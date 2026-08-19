/**
 * Register {@link AcpAdapter} instances on `ctx.llm` that delegate model calls
 * to external ACP servers over JSON-RPC stdio. The plugin reads configured
 * servers from the `llm-acp` settings namespace; each server spawns one
 * long-lived child process and becomes a provider route `acp-<id>`. Servers
 * can be added or removed dynamically through the settings UI without restart.
 *
 * This plugin uses named exports only; a default would hide its loader
 * metadata (see `docs/postmortem/0001-acp-default-export-drops-inject.md`).
 * @module @deepseek-ai/dsh-llm-acp
 */

import { isAbsolute, resolve } from 'node:path'
import { accessSync, constants, statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle, LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import { AcpAdapter } from './adapter.ts'
import {
  AcpConnection,
  DEFAULT_DISPOSE_EOF_GRACE_MS,
  DEFAULT_DISPOSE_GRACE_MS,
} from './connection.ts'
import type { PermissionPolicy } from './types.ts'
import registryData from './registry.json' with { type: 'json' }

export { AcpAdapter } from './adapter.ts'
export type { AcpAdapterOptions } from './adapter.ts'
export {
  AcpConnection,
  DEFAULT_DISPOSE_EOF_GRACE_MS,
  DEFAULT_DISPOSE_GRACE_MS,
} from './connection.ts'
export type { AcpConnectionSpec } from './connection.ts'
export type * from './types.ts'
export { registryData as acpRegistry }

export const name = 'llm-acp'
export const inject = ['llm', 'subprocess']

/** Settings namespace owned by this plugin. */
const NS = settingsNamespace('llm-acp')

/** One configured ACP server entry in settings. */
export interface AcpServerConfig {
  /** The executable to spawn (the external ACP agent server). */
  command: string
  /** Arguments passed to {@link command}. */
  args: string[]
  /** Human-readable display name for the provider. */
  name: string
  /**
   * Per-server environment variables merged on top of the plugin-level `env`.
   * Use this for credentials the ACP server needs (e.g. `DEEPSEEK_API_KEY`,
   * `OPENAI_API_KEY`). Per-server values override plugin-level ones.
   */
  env?: Record<string, string>
  /**
   * Model ids to expose from this server's discovered catalog. When omitted or
   * empty, every discovered model is exposed. When non-empty, only the listed
   * models (intersected with the discovered set) appear in `listModels`.
   */
  models?: string[]
}

/** Plugin config: defaults applied to every spawned ACP server. */
export interface Config {
  /** How to auto-answer the child's `session/request_permission` prompts (default `reject`). */
  permission?: PermissionPolicy
  /** Extra environment variables merged on top of the scrubbed parent env. */
  env?: Record<string, string>
  /** Whether to translate `agent_thought_chunk` into `reasoning-delta` chunks (default `false`). */
  emitReasoning?: boolean
  /** Fallback model id/name when ACP model discovery returns nothing. */
  defaultModelId?: string
  defaultModelName?: string
  /** Grace (ms) for the child's EOF-driven quiesce on dispose; must not exceed `MAX_TIMER_DELAY_MS`. */
  disposeEofGraceMs?: number
  /** Termination-escalation grace (ms) after SIGTERM before SIGKILL; must not exceed `MAX_TIMER_DELAY_MS`. */
  disposeGraceMs?: number
  /**
   * Working directory for child processes. A relative path resolves against the
   * harness launch directory at load. When omitted, the harness process cwd is used.
   */
  cwd?: string
  /**
   * Inline server entries composed at load time (in addition to settings).
   * Each entry becomes a provider route `acp-<id>`.
   */
  servers?: Record<string, AcpServerConfig>
}

export const Config: z<Config> = z.object({
  permission: z.union(['allow', 'reject'] as const).default('allow'),
  env: z.dict(z.string()).default({}),
  emitReasoning: z.boolean().default(true),
  defaultModelId: z.string().default('devin'),
  defaultModelName: z.string().default('Devin (ACP)'),
  disposeEofGraceMs: z.number().default(DEFAULT_DISPOSE_EOF_GRACE_MS),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  cwd: z.string(),
  servers: z.dict(z.object({
    command: z.string().required(),
    args: z.array(z.string()).default([]),
    name: z.string().required(),
    env: z.dict(z.string()).default({}),
    models: z.array(z.string()).default([]),
  })).default({}),
})

/** Settings schema: a map of server ids to their spawn configuration. */
const SettingsSchema = z.object({
  servers: z.dict(z.object({
    command: z.string().required(),
    args: z.array(z.string()).default([]),
    name: z.string().required(),
    env: z.dict(z.string()).default({}),
    models: z.array(z.string()).default([]),
  })).default({}),
})

/** A dispose grace must fit the single Node timer that owns its teardown tier. */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-acp: ${name} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/** Whether `path` names an existing directory the harness can enter (X_OK). */
function isDirectory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Assert `cwd` is absolute and an accessible directory. */
function assertUsableCwd(label: string, cwd: string): string {
  if (!isAbsolute(cwd)) {
    throw new Error(`llm-acp: ${label} must be an absolute path: ${cwd}`)
  }
  if (!isDirectory(cwd)) {
    throw new Error(`llm-acp: ${label} is not an accessible directory: ${cwd}`)
  }
  return cwd
}

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Omit<Config, 'cwd' | 'servers'>> & Pick<Config, 'cwd' | 'servers'>

/** One active ACP server: connection, adapter registration, and provider route. */
interface ActiveServer {
  connection: AcpConnection
  registration: AdapterRegistrationHandle
  /** JSON fingerprint of the config this server was created from, for change detection. */
  fingerprint: string
}

/** Provider route name for one server id. */
function routeName(serverId: string): string {
  return `acp-${serverId}`
}

/** Stable JSON fingerprint of a server config, for reconcile change detection. */
function serverFingerprint(server: AcpServerConfig): string {
  return JSON.stringify({
    command: server.command,
    args: server.args,
    name: server.name,
    env: server.env ?? {},
    models: server.models ?? [],
  })
}

/** Directory entries for the configurable-provider directory.
 * Always includes at least one entry so the `llm-acp` settings namespace is
 * exposed to configuration clients (the web API only serves namespaces that
 * appear in `listConfigurableProviders()`). A dormant entry has no
 * `settingsPath`, so the Models settings page renders it as a declared route
 * the user cannot edit — the ACP Servers page is the intended editor. */
function directoryEntries(servers: ReadonlyMap<string, AcpServerConfig>): LlmConfigurableProvider[] {
  const entries: LlmConfigurableProvider[] = [...servers.entries()].map(([id, server]) => ({
    provider: routeName(id),
    displayName: server.name,
    settingsNs: NS,
    settingsPath: ['servers', id],
  }))
  if (entries.length === 0) {
    entries.push({
      provider: '__acp_dormant__',
      displayName: 'ACP',
      settingsNs: NS,
      settingsPath: [],
      declared: true,
    })
  }
  return entries
}

export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite('disposeEofGraceMs', resolved.disposeEofGraceMs)
  assertPositiveFinite('disposeGraceMs', resolved.disposeGraceMs)
  const cwd = config.cwd === undefined || config.cwd === ''
    ? process.cwd()
    : assertUsableCwd('config cwd', resolve(config.cwd))

  /** Current settings source; updated by `installSettingsSection`. */
  let currentSettings: () => { servers: Record<string, AcpServerConfig> } = () => ({ servers: {} })
  /** Servers from the composition entry (inline config). */
  const configServers = (): Map<string, AcpServerConfig> => {
    const result = new Map<string, AcpServerConfig>()
    if (resolved.servers !== undefined) {
      for (const [id, server] of Object.entries(resolved.servers)) {
        result.set(id, server)
      }
    }
    return result
  }
  /** Merged servers from both config and settings. */
  const mergedServers = (): Map<string, AcpServerConfig> => {
    const result = configServers()
    const settings = currentSettings()
    if (settings?.servers !== undefined) {
      for (const [id, server] of Object.entries(settings.servers)) {
        result.set(id, server)
      }
    }
    return result
  }

  /** Active connections keyed by server id. */
  const active = new Map<string, ActiveServer>()

  /** Create one ACP connection + adapter for a server. */
  function createServer(serverId: string, server: AcpServerConfig): ActiveServer {
    const connection = new AcpConnection({
      command: server.command,
      args: server.args,
      cwd,
      permission: resolved.permission,
      env: { ...resolved.env, ...(server.env ?? {}) },
      disposeEofGraceMs: resolved.disposeEofGraceMs,
      disposeGraceMs: resolved.disposeGraceMs,
      spawn: spec => ctx.subprocess.spawn(spec),
      onWarn: message => ctx.logger.warn(message),
    })
    const adapter = new AcpAdapter({
      connection,
      provider: routeName(serverId),
      emitReasoning: resolved.emitReasoning,
      defaultModel: { id: resolved.defaultModelId, name: resolved.defaultModelName },
      enabledModels: server.models,
    })
    const registration = ctx.llm.registerAdapter([routeName(serverId)], adapter)
    return { connection, registration, fingerprint: serverFingerprint(server) }
  }

  /** Reconcile active connections with the current server set. */
  function reconcileServers(): void {
    const desired = mergedServers()
    const desiredIds = new Set(desired.keys())

    // Remove servers that are no longer configured.
    for (const [id, server] of active) {
      if (!desiredIds.has(id)) {
        server.registration()
        void server.connection.dispose().catch((error: unknown) => {
          ctx.logger.warn(`llm-acp: connection disposal for "${id}" failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        active.delete(id)
      }
    }

    // Add new servers or rebuild when an existing server's config changed.
    for (const [id, server] of desired) {
      const existing = active.get(id)
      if (existing === undefined) {
        try {
          active.set(id, createServer(id, server))
        } catch (error: unknown) {
          ctx.logger.error(`llm-acp: failed to create server "${id}": ${error instanceof Error ? error.message : String(error)}`)
        }
      } else if (existing.fingerprint !== serverFingerprint(server)) {
        // Config changed (env, models, command, …): tear down and rebuild so
        // the adapter picks up the new enabledModels and the connection gets
        // the new env. A stale adapter would keep advertising old models.
        existing.registration()
        void existing.connection.dispose().catch((error: unknown) => {
          ctx.logger.warn(`llm-acp: connection disposal for "${id}" failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        active.delete(id)
        try {
          active.set(id, createServer(id, server))
        } catch (error: unknown) {
          ctx.logger.error(`llm-acp: failed to rebuild server "${id}": ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

  /** Reconcile the configurable-provider directory. */
  let directory: DirectoryRegistrationHandle | undefined
  let lastDirectoryFacts: unknown
  function reconcileDirectory(): void {
    const entries = directoryEntries(mergedServers())
    if (deepEqualJson(entries, lastDirectoryFacts)) return
    if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders(entries)
    } else {
      directory.replace(entries)
    }
    lastDirectoryFacts = entries
  }

  // Initial registration from config servers.
  reconcileServers()
  reconcileDirectory()

  // Install the settings section for dynamic server management.
  installSettingsSection(ctx, NS, SettingsSchema, { servers: {} }, {
    setSource: (source) => {
      currentSettings = source as () => { servers: Record<string, AcpServerConfig> }
    },
    onChange: () => {
      try {
        reconcileServers()
      } catch (error: unknown) {
        ctx.logger.error('llm-acp: keeping previously registered servers after a refused update')
        ctx.logger.error(error)
      }
      try {
        reconcileDirectory()
      } catch (error: unknown) {
        ctx.logger.error('llm-acp: keeping previous configurable-provider directory after a refused update')
        ctx.logger.error(error)
      }
    },
  })

  // Dispose all connections when this plugin's fiber ends.
  ctx.effect(() => {
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      for (const [, server] of active) {
        server.registration()
        void server.connection.dispose().catch(() => {})
      }
      active.clear()
    }
  })
}
