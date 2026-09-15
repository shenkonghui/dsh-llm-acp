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
import { homedir } from 'node:os'
import { accessSync, constants, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-settings'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle, LlmConfigurableProvider, LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { AcpAdapter } from './adapter.ts'
import {
  AcpConnection,
  DEFAULT_AUTH_TIMEOUT_MS,
  DEFAULT_DISPOSE_EOF_GRACE_MS,
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_INIT_TIMEOUT_MS,
  DEFAULT_INTERACTIVE_AUTH_TIMEOUT_MS,
  DEFAULT_SESSION_TIMEOUT_MS,
} from './connection.ts'
import registryData from './registry.json' with { type: 'json' }

export { AcpAdapter } from './adapter.ts'
export type { AcpAdapterOptions } from './adapter.ts'
export {
  AcpConnection,
  DEFAULT_AUTH_TIMEOUT_MS,
  DEFAULT_DISPOSE_EOF_GRACE_MS,
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_INIT_TIMEOUT_MS,
  DEFAULT_INTERACTIVE_AUTH_TIMEOUT_MS,
  DEFAULT_SESSION_TIMEOUT_MS,
} from './connection.ts'
export type { AcpConnectionSpec, ProtocolTraceEntry } from './connection.ts'
export type * from './types.ts'
export { registryData as acpRegistry }

export const name = 'llm-acp'
export const inject = ['llm', 'subprocess', 'settings']

/** Settings namespace owned by this plugin. */
const NS = 'llm-acp'

/** Structural deep equality over JSON-compatible data (objects, arrays, primitives). */
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((entry, index) => deepEqualJson(entry, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every(key => key in right && deepEqualJson(left[key], right[key]))
}

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
  /**
   * User-defined models to expose in addition to (or instead of) the discovered
   * catalog. Each entry has an `id` (sent to the ACP server as the model name)
   * and a `name` (display label). Custom models with the same id as a discovered
   * model override its display name; custom models with unique ids are added.
   */
  customModels?: { id: string; name: string }[]
  /**
   * Map a dsh permission preset name (or sandbox mode value) to the ACP
   * session mode applied to this server's sessions, e.g.
   * `{ "danger-full-access": "bypass" }`. Read per prompt so a mid-turn
   * preset switch reaches the next stream. Unmapped states leave the
   * server's mode untouched; servers without a `mode` config option keep
   * their own default.
   */
  modeMap?: Record<string, string>
  /**
   * Which advertised ACP auth method to log in with, e.g. `external`. Only
   * needed when the server offers a choice: a single advertised method is
   * used automatically, and a server that logs in from cached credentials or
   * env credentials never authenticates at all. Methods are not
   * interchangeable — codebuddy advertises an intranet-only `iOA` alongside a
   * public `external` — so an unset or unknown value leaves authentication
   * blocked (and the ACP Servers UI asks) rather than guessing. Changing this
   * rebuilds the server's connection, which is what actually applies it.
   */
  authMethod?: string
}

/** Plugin config: defaults applied to every spawned ACP server. */
export interface Config {
  /** Extra environment variables merged on top of the scrubbed parent env. */
  env?: Record<string, string>
  /** Whether to translate `agent_thought_chunk` into `reasoning-delta` chunks (default `true`). */
  emitReasoning?: boolean
  /** Whether to surface extension progress notifications as reasoning blocks (default `false`). */
  emitProgress?: boolean
  /** Fallback model id/name when ACP model discovery returns nothing. */
  defaultModelId?: string
  defaultModelName?: string
  /** Grace (ms) for the child's EOF-driven quiesce on dispose; must not exceed `MAX_TIMER_DELAY_MS`. */
  disposeEofGraceMs?: number
  /** Termination-escalation grace (ms) after SIGTERM before SIGKILL; must not exceed `MAX_TIMER_DELAY_MS`. */
  disposeGraceMs?: number
  /**
   * Bound (ms) on the ACP `initialize` handshake plus any keyed `authenticate`
   * round; must not exceed `MAX_TIMER_DELAY_MS`. Covers `npx` cold fetches, so
   * keep it generous.
   */
  initTimeoutMs?: number
  /**
   * Bound (ms) on `session/new`, `session/load`, `session/list`, and
   * `session/set_config_option`; must not exceed `MAX_TIMER_DELAY_MS`.
   */
  sessionTimeoutMs?: number
  /**
   * Bound (ms) on one `authenticate` round — the eager keyed attempt during
   * `initialize`, or the lazy key-less attempt after a failed `session/new`;
   * must not exceed `MAX_TIMER_DELAY_MS`.
   */
  authTimeoutMs?: number
  /**
   * Bound (ms) on one key-less interactive `authenticate` round — long enough
   * for the user to complete a browser login; when the round settles the failed
   * session call retries automatically. Must not exceed `MAX_TIMER_DELAY_MS`.
   */
  interactiveAuthTimeoutMs?: number
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
  env: z.dict(z.string()).default({}),
  emitReasoning: z.boolean().default(true),
  emitProgress: z.boolean().default(false),
  defaultModelId: z.string().default('devin'),
  defaultModelName: z.string().default('Devin (ACP)'),
  disposeEofGraceMs: z.number().default(DEFAULT_DISPOSE_EOF_GRACE_MS),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  initTimeoutMs: z.number().default(DEFAULT_INIT_TIMEOUT_MS),
  sessionTimeoutMs: z.number().default(DEFAULT_SESSION_TIMEOUT_MS),
  authTimeoutMs: z.number().default(DEFAULT_AUTH_TIMEOUT_MS),
  interactiveAuthTimeoutMs: z.number().default(DEFAULT_INTERACTIVE_AUTH_TIMEOUT_MS),
  cwd: z.string(),
  servers: z.dict(z.object({
    command: z.string().required(),
    args: z.array(z.string()).default([]),
    name: z.string().required(),
    env: z.dict(z.string()).default({}),
    models: z.array(z.string()).default([]),
    customModels: z.array(z.object({
      id: z.string().required(),
      name: z.string().default(''),
    })).default([]),
    modeMap: z.dict(z.string()).default({}),
    authMethod: z.string().default(''),
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
    customModels: z.array(z.object({
      id: z.string().required(),
      name: z.string().default(''),
    })).default([]),
    modeMap: z.dict(z.string()).default({}),
    authMethod: z.string().default(''),
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

/** Derive the bin name an npm package installs (heuristic: last path segment
 * of the package name, without scope or version). `@scope/name@ver` → `name`,
 * `name@ver` → `name`. The true bin may differ; this is only a PATH probe. */
function npmBinName(pkg: string): string | undefined {
  const core = pkg.startsWith('@')
    ? pkg.split('@', 2)[1]?.split('/').pop()
    : pkg.split('@', 0)[0] ?? pkg.split('@')[0]
  return core
}

/** User-level install dirs probed after the process PATH. GUI and service
 * launches inherit a minimal PATH that misses `~/.local/bin` (devin, pipx,
 * uv) and the Homebrew prefix, even though a login shell finds them. */
const EXTRA_BIN_DIRS: readonly string[] =
  process.platform === 'win32'
    ? []
    : [
        resolve(homedir(), '.local/bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        resolve(homedir(), 'bin'),
      ]

/** Locate an executable in PATH plus {@link EXTRA_BIN_DIRS}; returns the
 * absolute path or `undefined`.
 * ponytail: ceiling — scans PATH on every probe; called once per server spawn. */
function whichBin(bin: string): string | undefined {
  const sep = process.platform === 'win32' ? ';' : ':'
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(sep).concat(EXTRA_BIN_DIRS)) {
    if (dir.length === 0) continue
    for (const ext of exts) {
      const p = resolve(dir, bin + ext)
      try {
        accessSync(p, constants.X_OK)
        return p
      } catch { /* not in this dir */ }
    }
  }
  return undefined
}

/** Resolve a bare command name to its absolute path so the spawn does not
 * depend on the process PATH. Names already carrying a path separator (or
 * absent from every probed dir) pass through unchanged — the spawn error
 * then reports the configured name. */
function resolveCommandPath(command: string): string {
  if (command.includes('/') || command.includes('\\')) return command
  return whichBin(command) ?? command
}

/**
 * Rewrite a `npx -y <pkg> [args…]` spawn to use the package's bin directly
 * when it is already in PATH, avoiding an npm fetch. Settings still store the
 * `npx` form (portable); the rewrite is a spawn-time optimization. Returns the
 * original pair when the pattern doesn't match or the bin is absent.
 */
function resolveNpxShortcut(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  if (command !== 'npx') return { command, args: [...args] }
  const idx = args.findIndex(a => a === '-y' || a === '--yes')
  if (idx < 0 || idx + 1 >= args.length) return { command, args: [...args] }
  const pkg = args[idx + 1]
  if (typeof pkg !== 'string' || pkg.length === 0) return { command, args: [...args] }
  const rest = args.slice(idx + 2)
  const bin = npmBinName(pkg)
  if (bin === undefined) return { command, args: [...args] }
  const resolved = whichBin(bin)
  if (resolved === undefined) return { command, args: [...args] }
  return { command: resolved, args: rest }
}

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Omit<Config, 'cwd' | 'servers'>> & Pick<Config, 'cwd' | 'servers'>

/** Session permission fields used to route ACP permission requests. */
interface PermissionPresetReader {
  readonly names: readonly string[]
  current(session: Session): string
  resolve(name: string): { sandbox: string; approval: string }
}

/** Session sandbox reader: the effective mode including the deployment default. */
interface SandboxPolicyReader {
  resolve(request: { session: Session }): { mode: string }
}

/** Append the `approval/asked` + `approval/decided` audit pair for an ACP
 * permission request auto-allowed by the session's unrestricted permission
 * state (sandbox `danger-full-access` with approval policy `never`). That
 * shortcut bypasses `approval.request` (whose `never` policy would reject),
 * so without this the session log records no trace of the grant. */
function auditAutoAllowedPermission(session: Session, serverName: string, title: string): void {
  try {
    const id = randomUUID() as ApprovalRequestId
    session.append('approval/asked', {
      id,
      toolName: `ACP: ${title}`,
      reason: `${serverName} requested permission: ${title}. Auto-allowed by session sandbox danger-full-access with approval policy never.`,
    })
    session.append('approval/decided', { id, outcome: 'allowed-once' })
  } catch {
    // Audit-only: a session that cannot append must not block the grant.
  }
}

/** One active ACP server: connection, adapter registration, and provider route. */
interface ActiveServer {
  connection: AcpConnection
  adapter: AcpAdapter
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
    customModels: server.customModels ?? [],
    modeMap: server.modeMap ?? {},
    // Part of the fingerprint because the connection owns the value at
    // construction: only a rebuild applies a new method, and a rebuild is also
    // what abandons an authenticate round still hung on the old one.
    authMethod: server.authMethod ?? '',
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
  assertPositiveFinite('initTimeoutMs', resolved.initTimeoutMs)
  assertPositiveFinite('sessionTimeoutMs', resolved.sessionTimeoutMs)
  assertPositiveFinite('authTimeoutMs', resolved.authTimeoutMs)
  assertPositiveFinite('interactiveAuthTimeoutMs', resolved.interactiveAuthTimeoutMs)
  const cwd = config.cwd === undefined || config.cwd === ''
    ? process.cwd()
    : assertUsableCwd('config cwd', resolve(config.cwd))

  /** Current settings source; updated by `settings.installSection`. */
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

  /** Best-effort system-browser open for an interactive login URL; failure keeps the URL in the auth warning. */
  function openBrowser(url: string): void {
    const argv = process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url]
    try {
      const handle = ctx.subprocess.spawn({
        argv,
        cwd,
        stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
        graceMs: resolved.disposeGraceMs,
      })
      handle.done.catch(() => { /* opener missing or failed; the key-less auth timeout warning still shows the URL */ })
    } catch {
      // Spawn refused synchronously; the key-less auth timeout warning still shows the URL.
    }
  }

  /** Create one ACP connection + adapter for a server. */
  function createServer(serverId: string, server: AcpServerConfig): ActiveServer {
    const serverEnv = { ...resolved.env, ...(server.env ?? {}) }
    // When a registry agent is distributed via `npx -y <pkg>`, prefer the
    // package's bin directly when it is already in PATH — avoids an npm fetch
    // and startup latency for agents the user has installed globally.
    const { command: npxCommand, args: spawnArgs } = resolveNpxShortcut(server.command, server.args)
    // A bare command name resolves against the process PATH at spawn time;
    // GUI/service launches often miss user bin dirs, so probe the augmented
    // PATH and store the absolute path before spawning.
    const spawnCommand = resolveCommandPath(npxCommand)
    const connection = new AcpConnection({
      command: spawnCommand,
      args: spawnArgs,
      cwd,
      env: serverEnv,
      disposeEofGraceMs: resolved.disposeEofGraceMs,
      disposeGraceMs: resolved.disposeGraceMs,
      initTimeoutMs: resolved.initTimeoutMs,
      sessionTimeoutMs: resolved.sessionTimeoutMs,
      authTimeoutMs: resolved.authTimeoutMs,
      interactiveAuthTimeoutMs: resolved.interactiveAuthTimeoutMs,
      spawn: spec => ctx.subprocess.spawn(spec),
      onWarn: message => ctx.logger.warn(message),
      onAuthUrl: openBrowser,
      authMethod: server.authMethod ?? '',
      // Resolve an API key from the server's configured env. When present,
      // it is passed via _meta.api_key in an eager authenticate round so ACP
      // servers that accept direct key auth skip interactive flows. When
      // absent, no authenticate call is made up front: servers using env
      // credentials or a cached login go straight to session/new, and only
      // a failed session/new triggers one lazy authenticate round — so a
      // healthy server never opens a browser login it did not need.
      resolveAuthApiKey: async () => {
        for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEVIN_API_KEY', 'API_KEY', 'CODEBUDDY_API_KEY', 'LLM_API_KEY']) {
          const value = serverEnv[key]
          if (typeof value === 'string' && value.length > 0) return value
        }
        return undefined
      },
      // A dead prompt on a serial server wedges the whole connection — every
      // later request queues behind it. Rebuild the connection so the next
      // turn starts on a fresh process instead of starving.
      onWedged: reason => {
        const existing = active.get(serverId)
        if (existing === undefined || existing.connection !== connection) return
        ctx.logger.warn(`llm-acp: rebuilding "${serverId}" (${reason})`)
        existing.adapter.disposeSessions()
        existing.registration()
        void existing.connection.dispose().catch((error: unknown) => {
          ctx.logger.warn(`llm-acp: connection disposal for "${serverId}" failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        active.delete(serverId)
        try {
          const rebuilt = createServer(serverId, server)
          active.set(serverId, rebuilt)
          // A dead prompt likely means expired credentials — kick an
          // interactive round so the published URL reaches the UI and the
          // next turn can recover. No-op when the server advertises no
          // auth methods.
          rebuilt.connection.requestInteractiveAuth()
        } catch (error: unknown) {
          ctx.logger.error(`llm-acp: failed to rebuild server "${serverId}": ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    })
    const adapter = new AcpAdapter({
      connection,
      provider: routeName(serverId),
      emitReasoning: resolved.emitReasoning,
      emitProgress: resolved.emitProgress,
      defaultModel: { id: resolved.defaultModelId, name: resolved.defaultModelName },
      enabledModels: server.models,
      customModels: server.customModels,
      onWarn: message => ctx.logger.warn(message),
      // Map the calling dsh session's permission state to this server's ACP
      // session mode (e.g. danger-full-access → bypass). Read per stream so a
      // preset switch applies to the next prompt; preset name is looked up
      // first, then the effective sandbox mode so delegated children carrying
      // only knob events still match.
      resolveSessionMode: () => {
        const modeMap = server.modeMap
        if (modeMap === undefined || Object.keys(modeMap).length === 0) return undefined
        const agent = ctx.get('agents')?.currentInitiator()
        const session = agent?.session as Session | undefined
        if (session === undefined) return undefined
        const permissionPresets = ctx.get('permissionPresets' as never) as PermissionPresetReader | undefined
        const sandboxPolicy = ctx.get('sandboxPolicy' as never) as SandboxPolicyReader | undefined
        const preset = permissionPresets?.current(session)
        const sandbox = sandboxPolicy?.resolve({ session }).mode
        return (preset !== undefined ? modeMap[preset] : undefined)
          ?? (sandbox !== undefined ? modeMap[sandbox] : undefined)
      },
      permissionRequester: () => {
        const agents = ctx.get('agents')
        const agent = agents?.currentInitiator()
        if (agent === undefined) return undefined
        const permissionPresets = ctx.get('permissionPresets' as never) as PermissionPresetReader | undefined
        const sandboxPolicy = ctx.get('sandboxPolicy' as never) as SandboxPolicyReader | undefined
        const approval = ctx.get('approval')
        if (approval === undefined && sandboxPolicy === undefined && permissionPresets === undefined) return undefined
        const sessionLike = agent.session as Session
        return async ({ title, signal, optionLabels }) => {
          // Read the effective permission knobs per request, not once at
          // stream start: a mid-turn switch to danger-full-access must reach
          // the in-flight prompt. Under approval policy `never` the approval
          // seam auto-rejects instead of asking, so routing the request
          // through it would deny everything the agent tries. Knobs are read
          // directly rather than matching a preset name: delegation seeds
          // child sessions with `sandbox/mode` + `approval/policy` events and
          // unnamed combinations derive `custom`, which a name match misses.
          // The preset reader stays as fallback for a deployment without the
          // sandbox-policy seam.
          let preset: { sandbox: string; approval: string } | undefined
          if (permissionPresets !== undefined) {
            const current = permissionPresets.current(sessionLike)
            if (permissionPresets.names.includes(current)) preset = permissionPresets.resolve(current)
          }
          const sandbox = sandboxPolicy?.resolve({ session: sessionLike }).mode ?? preset?.sandbox
          const policy = approval?.overrideOf(sessionLike) ?? approval?.config.policy ?? preset?.approval
          if (sandbox === 'danger-full-access' && policy === 'never') {
            auditAutoAllowedPermission(sessionLike, server.name, title)
            return 'allow'
          }
          if (approval === undefined) return 'reject'
          const reason = optionLabels !== undefined && optionLabels.length > 0
            ? `${server.name} requested permission: ${title}. Options: ${optionLabels.join(', ')}.`
            : `${server.name} requested permission to run "${title}".`
          const outcome = await approval.request({
            agent,
            toolName: `ACP: ${title}`,
            reason,
            signal,
          })
          if (outcome === 'allowed-once') return 'allow'
          if (outcome === 'cancelled') return 'cancel'
          if (outcome === 'unavailable') {
            ctx.logger.warn(`llm-acp: permission request for "${title}" denied: no approval answerer on this session (unattended sessions auto-deny); run the session under a preset whose approval policy needs no answerer`)
          } else if (outcome === 'rejected' && policy === 'never') {
            ctx.logger.warn(`llm-acp: permission request for "${title}" auto-rejected by approval policy "never" (effective sandbox: ${sandbox ?? 'unknown'}); full-access sessions pair approval "never" with sandbox "danger-full-access"`)
          }
          return 'reject'
        }
      },
    })
    const registration = ctx.llm.registerAdapter([routeName(serverId)], adapter)
    return { connection, adapter, registration, fingerprint: serverFingerprint(server) }
  }

  /** Reconcile active connections with the current server set. */
  function reconcileServers(): void {
    const desired = mergedServers()
    const desiredIds = new Set(desired.keys())

    // Remove servers that are no longer configured.
    for (const [id, server] of active) {
      if (!desiredIds.has(id)) {
        server.adapter.disposeSessions()
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
        existing.adapter.disposeSessions()
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

  // Register model discovery so the settings UI can query each ACP server's
  // model catalog via `remote.llm.discoverModels(settingsNs, { provider })`.
  // The provider route (`acp-<id>`) maps to the active connection; we call its
  // `discoverModels()` which creates a throwaway ACP session and reads the
  // `configOptions` (category `model`) from the `session/new` response.
  // A bounded timeout prevents the UI from hanging when the ACP server needs
  // interactive auth (e.g. browser PKCE) before it can create sessions.
  //
  // A second route convention, `acp-info-<id>`, surfaces the server's
  // `initialize` identity (agent name/version and negotiated protocol
  // version) without creating a session. The reply reuses the
  // `LlmDiscoveredModel` wire shape as a private carrier: `id` is the agent
  // name, `name` is the agent version, and `contextWindow` is the ACP
  // protocol version. Only the ACP settings UI consumes this route.
  const INFO_PREFIX = 'acp-info-'
  // A third route convention, `acp-resolve-<binname>`, probes the host PATH
  // for an executable so the settings UI can store a local bin path instead
  // of `npx -y <pkg>` when the agent is already installed. The reply reuses
  // the `LlmDiscoveredModel` wire shape: `id` is the absolute path, `name`
  // is the bin name. Only the ACP settings UI consumes this route.
  const RESOLVE_PREFIX = 'acp-resolve-'
  // A fourth route convention, `acp-test-<id>`, runs an end-to-end probe for
  // the settings UI's server test dialog: create a throwaway session, send a
  // short prompt, collect the streamed reply, and close the session. The reply
  // reuses the `LlmDiscoveredModel` wire shape: `id` is `ok` or `error`, and
  // `name` carries the reply text or the failure message. Only the ACP
  // settings UI consumes this route.
  const TEST_PREFIX = 'acp-test-'
  // A fifth route convention, `acp-auth-<id>`, reports the server's
  // interactive-auth state. The reply reuses the `LlmDiscoveredModel` wire
  // shape: `id` `auth` with `name` carrying the browser URL captured from the
  // `_codebuddy.ai/authUrl` extension notification while a login is pending;
  // `id` `pending` with `name` carrying the method id while a round is in
  // flight but no URL was published; `id` `none` otherwise. Only the ACP
  // settings UI and conversation auth banner consume this route.
  const AUTH_PREFIX = 'acp-auth-'
  // A sixth route convention, `acp-methods-<id>`, reports the server's auth
  // method catalog for the choice UI. The reply reuses the
  // `LlmDiscoveredModel` wire shape as a private carrier: `id` is always
  // `methods` and `name` is a JSON-encoded `AcpAuthMethodState`
  // (`{methods, selected, needed}`). Kept separate from `acp-auth-<id>`
  // because that one reports a transient round (a hung round would otherwise
  // hide the catalog just when the user needs to change the method). Consumed
  // by the ACP settings UI and the conversation auth banner.
  const METHODS_PREFIX = 'acp-methods-'
  /** How long to wait for `initialize` before the test probe reports failure. */
  const TEST_INIT_TIMEOUT_MS = 15_000
  /** How long to wait for the probe prompt's terminal update before aborting. */
  const TEST_PROMPT_TIMEOUT_MS = 60_000
  ctx.effect(() => ctx.llm.registerModelDiscovery(NS, async (request: LlmModelDiscoveryRequest, _signal?: AbortSignal) => {
    const provider = request.provider ?? ''
    if (provider.length === 0) return []
    if (provider.startsWith(RESOLVE_PREFIX)) {
      const bin = provider.slice(RESOLVE_PREFIX.length)
      if (bin.length === 0) return []
      const resolved = whichBin(bin)
      if (resolved === undefined) return []
      return [{ id: resolved, name: bin }]
    }
    if (provider.startsWith(INFO_PREFIX)) {
      const serverId = provider.slice(INFO_PREFIX.length)
      const server = active.get(serverId)
      if (server === undefined) return [{ id: 'error', name: 'server is not running — no active connection found for this server id; the server may have been removed or never started' }]
      let readySettled = false
      let readyError: Error | undefined
      try {
        await Promise.race([
          server.connection.ready.then(() => { readySettled = true }, (error: unknown) => { readyError = error instanceof Error ? error : new Error(String(error)) }),
          new Promise(resolve => setTimeout(() => resolve(undefined), 10_000)),
        ])
      } catch (error: unknown) {
        return [{
          id: 'error',
          name: `initialize threw synchronously: ${error instanceof Error ? error.message : String(error)}`,
        }]
      }
      if (readyError !== undefined) {
        return [{
          id: 'error',
          name: `initialize failed: ${readyError.message}`,
        }]
      }
      if (!readySettled) {
        const authUrl = server.connection.getPendingAuthUrl()
        return [{
          id: 'error',
          name: `initialize timed out after 10s — the agent may still be starting (e.g. npx fetching a package), waiting for an interactive login, or the process may have exited`
            + (authUrl !== undefined ? `; a browser login is pending: ${authUrl}` : '; check the host logs for llm-acp warnings'),
        }]
      }
      const info = server.connection.getServerInfo()
      if (info === undefined) {
        return [{
          id: 'error',
          name: 'initialize completed but no protocol version was negotiated — the agent may have returned an invalid initialize response',
        }]
      }
      if (info.agentInfoMissing) {
        return [{
          id: 'unknown',
          name: `agentInfo missing — initialize succeeded (protocol ${info.protocolVersion}) but the agent omitted or published an invalid agentInfo; the ACP SDK silently drops agentInfo that fails schema validation (name and version must be non-empty strings); the server may still be functional`,
          contextWindow: info.protocolVersion,
        }]
      }
      return [{
        id: info.agentName,
        name: info.agentVersion,
        contextWindow: info.protocolVersion,
      }]
    }
    if (provider.startsWith(TEST_PREFIX)) {
      const serverId = provider.slice(TEST_PREFIX.length)
      const server = active.get(serverId)
      if (server === undefined) return [{ id: 'error', name: 'server is not running — no active connection found for this server id; the server may have been removed or never started' }]
      const fail = (error: unknown): LlmDiscoveredModel[] => [{
        id: 'error',
        name: error instanceof Error ? error.message : String(error),
      }]
      try {
        await Promise.race([
          server.connection.ready,
          new Promise((_, reject) => setTimeout(() => reject(new Error(`initialize timed out after ${TEST_INIT_TIMEOUT_MS}ms — the agent may still be starting, waiting for an interactive login, or the process may have exited; check the host logs for llm-acp warnings`)), TEST_INIT_TIMEOUT_MS)),
        ])
      } catch (error: unknown) {
        return fail(error)
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TEST_PROMPT_TIMEOUT_MS)
      let sessionId: string | undefined
      try {
        sessionId = await server.connection.newSession()
        let reply = ''
        for await (const update of server.connection.promptStream(
          sessionId,
          [{ type: 'text', text: 'Reply with exactly: pong' }],
          controller.signal,
        )) {
          if (update.kind === 'text') reply += update.text
          else if (update.kind === 'done') return [{ id: 'ok', name: reply }]
          else if (update.kind === 'error') throw new Error(update.error.message)
        }
        if (controller.signal.aborted) throw new Error(`prompt timed out after ${TEST_PROMPT_TIMEOUT_MS}ms — the agent accepted the prompt but did not respond within the deadline; it may be stuck on an interactive login, a permission request, or an internal error`)
        throw new Error('stream ended without a stop reason — the agent closed the prompt stream without sending a terminal update; this may indicate a crash or protocol violation')
      } catch (error: unknown) {
        return fail(error)
      } finally {
        clearTimeout(timer)
        if (sessionId !== undefined) server.connection.closeSession(sessionId)
      }
    }
    if (provider.startsWith(AUTH_PREFIX)) {
      const serverId = provider.slice(AUTH_PREFIX.length)
      const server = active.get(serverId)
      const url = server?.connection.getPendingAuthUrl()
      if (url !== undefined && url.length > 0) return [{ id: 'auth', name: url }]
      // A round may be in flight without a published URL (e.g. desktop-client
      // methods like codebuddy's iOA) — report it so the UI can still show a
      // waiting state instead of a silent stall.
      const method = server?.connection.getPendingAuthMethod()
      if (method !== undefined) return [{ id: 'pending', name: method }]
      return [{ id: 'none', name: '' }]
    }
    if (provider.startsWith(METHODS_PREFIX)) {
      const serverId = provider.slice(METHODS_PREFIX.length)
      const server = active.get(serverId)
      if (server === undefined) {
        return [{ id: 'methods', name: JSON.stringify({ methods: [], selected: '', needed: false }) }]
      }
      // The catalog only exists after `initialize`; bound the wait so the
      // picker renders "no methods" instead of hanging on a cold `npx` start.
      try {
        await Promise.race([
          server.connection.ready,
          new Promise((_, reject) => setTimeout(() => reject(new Error('initialize timed out')), 10_000)),
        ])
      } catch {
        // Report whatever is known (usually nothing) rather than failing.
      }
      return [{ id: 'methods', name: JSON.stringify(server.connection.authMethodState()) }]
    }
    // A sixth route convention, `acp-trace-<id>`, returns the server's
    // recent protocol interactions (ring buffer, max 10). The reply reuses
    // the `LlmDiscoveredModel` wire shape: `id` is `trace`, `name` is a
    // JSON-encoded array of {time,dir,method,summary}. Consumed by the
    // protocol inspector conversation view.
    if (provider.startsWith('acp-trace-')) {
      const serverId = provider.slice('acp-trace-'.length)
      const server = active.get(serverId)
      if (server === undefined) return [{ id: 'none', name: '[]' }]
      const trace = server.connection.getProtocolTrace()
      return [{ id: 'trace', name: JSON.stringify(trace) }]
    }
    // A seventh route convention, `acp-modes-<id>`, lists the session modes
    // the server advertises via its `mode` config option (e.g. Devin's
    // `bypass`). The reply reuses the `LlmDiscoveredModel` wire shape: `id` is
    // the mode value, `name` its display label. Only the ACP settings UI
    // consumes this route — it populates the modeMap editor's ACP-side select.
    if (provider.startsWith('acp-modes-')) {
      const serverId = provider.slice('acp-modes-'.length)
      const server = active.get(serverId)
      if (server === undefined) return []
      try {
        const modes = await Promise.race([
          server.connection.discoverModes(),
          new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 10_000)),
        ])
        return (modes ?? []).map(m => ({ id: m.id, name: m.name }))
      } catch {
        return []
      }
    }
    // An eighth route convention, `acp-dsh-presets`, lists the dsh permission
    // preset names plus sandbox mode values usable as modeMap keys. Falls back
    // to the three standard sandbox modes when no preset service is mounted.
    // Only the ACP settings UI consumes this route.
    if (provider === 'acp-dsh-presets') {
      const presets = ctx.get('permissionPresets' as never) as PermissionPresetReader | undefined
      const names = presets !== undefined && presets.names.length > 0
        ? [...presets.names]
        : ['read-only', 'workspace-write', 'danger-full-access']
      return names.map(name => ({ id: name, name }))
    }
    if (!provider.startsWith('acp-')) return []
    const serverId = provider.slice(4)
    const server = active.get(serverId)
    if (server === undefined) return []
    try {
      const discovered = await Promise.race([
        server.connection.discoverModels(),
        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 10_000)),
      ])
      if (discovered === undefined) return []
      const models: LlmDiscoveredModel[] = discovered.map(m => ({ id: m.id, name: m.name }))
      return models
    } catch {
      return []
    }
  }), 'llm-acp.modelDiscovery()')

  // Install the settings section for dynamic server management.
  // `installSection` is on SettingsProvider in dsh-settings ≥0.1.2-rc.1; the
  // local 0.1.0-rc.5 type lacks it, so cast to the minimal call signature.
  type InstallSectionFn = <T>(
    owner: Context,
    ns: string,
    schema: z<T>,
    entry: T,
    hooks: { setSource: (source: () => T) => void; onChange: () => void; validate?: (value: T) => void },
  ) => void
  (ctx.settings as unknown as { installSection: InstallSectionFn }).installSection(
    ctx, NS, SettingsSchema, { servers: {} }, {
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
        server.adapter.disposeSessions()
        server.registration()
        void server.connection.dispose().catch(() => {})
      }
      active.clear()
    }
  })
}
