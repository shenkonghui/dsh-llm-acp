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
import { isAbsolute, resolve } from 'node:path';
import { accessSync, constants, statSync } from 'node:fs';
import z from '@deepseek-ai/schemastery';
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import { AcpAdapter } from "./adapter.js";
import { AcpConnection, DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS, } from "./connection.js";
import registryData from './registry.json' with { type: 'json' };
export { AcpAdapter } from "./adapter.js";
export { AcpConnection, DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS, } from "./connection.js";
export { registryData as acpRegistry };
export const name = 'llm-acp';
export const inject = ['llm', 'subprocess', 'settings'];
/** Settings namespace owned by this plugin. */
const NS = 'llm-acp';
/** Structural deep equality over JSON-compatible data (objects, arrays, primitives). */
function deepEqualJson(a, b) {
    if (a === b)
        return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null)
        return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
            return false;
        return a.every((entry, index) => deepEqualJson(entry, b[index]));
    }
    const left = a;
    const right = b;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length)
        return false;
    return keys.every(key => key in right && deepEqualJson(left[key], right[key]));
}
export const Config = z.object({
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
});
/** Settings schema: a map of server ids to their spawn configuration. */
const SettingsSchema = z.object({
    servers: z.dict(z.object({
        command: z.string().required(),
        args: z.array(z.string()).default([]),
        name: z.string().required(),
        env: z.dict(z.string()).default({}),
        models: z.array(z.string()).default([]),
    })).default({}),
});
/** A dispose grace must fit the single Node timer that owns its teardown tier. */
function assertPositiveFinite(name, value) {
    if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
        throw new Error(`llm-acp: ${name} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
    }
}
/** Whether `path` names an existing directory the harness can enter (X_OK). */
function isDirectory(path) {
    try {
        if (!statSync(path).isDirectory())
            return false;
        accessSync(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
/** Assert `cwd` is absolute and an accessible directory. */
function assertUsableCwd(label, cwd) {
    if (!isAbsolute(cwd)) {
        throw new Error(`llm-acp: ${label} must be an absolute path: ${cwd}`);
    }
    if (!isDirectory(cwd)) {
        throw new Error(`llm-acp: ${label} is not an accessible directory: ${cwd}`);
    }
    return cwd;
}
/** Provider route name for one server id. */
function routeName(serverId) {
    return `acp-${serverId}`;
}
/** Stable JSON fingerprint of a server config, for reconcile change detection. */
function serverFingerprint(server) {
    return JSON.stringify({
        command: server.command,
        args: server.args,
        name: server.name,
        env: server.env ?? {},
        models: server.models ?? [],
    });
}
/** Directory entries for the configurable-provider directory.
 * Always includes at least one entry so the `llm-acp` settings namespace is
 * exposed to configuration clients (the web API only serves namespaces that
 * appear in `listConfigurableProviders()`). A dormant entry has no
 * `settingsPath`, so the Models settings page renders it as a declared route
 * the user cannot edit — the ACP Servers page is the intended editor. */
function directoryEntries(servers) {
    const entries = [...servers.entries()].map(([id, server]) => ({
        provider: routeName(id),
        displayName: server.name,
        settingsNs: NS,
        settingsPath: ['servers', id],
    }));
    if (entries.length === 0) {
        entries.push({
            provider: '__acp_dormant__',
            displayName: 'ACP',
            settingsNs: NS,
            settingsPath: [],
            declared: true,
        });
    }
    return entries;
}
export function apply(ctx, config) {
    const resolved = config;
    assertPositiveFinite('disposeEofGraceMs', resolved.disposeEofGraceMs);
    assertPositiveFinite('disposeGraceMs', resolved.disposeGraceMs);
    const cwd = config.cwd === undefined || config.cwd === ''
        ? process.cwd()
        : assertUsableCwd('config cwd', resolve(config.cwd));
    /** Current settings source; updated by `settings.installSection`. */
    let currentSettings = () => ({ servers: {} });
    /** Servers from the composition entry (inline config). */
    const configServers = () => {
        const result = new Map();
        if (resolved.servers !== undefined) {
            for (const [id, server] of Object.entries(resolved.servers)) {
                result.set(id, server);
            }
        }
        return result;
    };
    /** Merged servers from both config and settings. */
    const mergedServers = () => {
        const result = configServers();
        const settings = currentSettings();
        if (settings?.servers !== undefined) {
            for (const [id, server] of Object.entries(settings.servers)) {
                result.set(id, server);
            }
        }
        return result;
    };
    /** Active connections keyed by server id. */
    const active = new Map();
    /** Create one ACP connection + adapter for a server. */
    function createServer(serverId, server) {
        const connection = new AcpConnection({
            command: server.command,
            args: server.args,
            cwd,
            env: { ...resolved.env, ...(server.env ?? {}) },
            disposeEofGraceMs: resolved.disposeEofGraceMs,
            disposeGraceMs: resolved.disposeGraceMs,
            spawn: spec => ctx.subprocess.spawn(spec),
            onWarn: message => ctx.logger.warn(message),
        });
        const adapter = new AcpAdapter({
            connection,
            provider: routeName(serverId),
            emitReasoning: resolved.emitReasoning,
            defaultModel: { id: resolved.defaultModelId, name: resolved.defaultModelName },
            enabledModels: server.models,
            permissionRequester: () => {
                const agents = ctx.get('agents');
                const agent = agents?.currentInitiator();
                if (agent === undefined)
                    return undefined;
                const permissionPresets = ctx.get('permissionPresets');
                if (permissionPresets !== undefined) {
                    const current = permissionPresets.current(agent.session.events);
                    if (permissionPresets.names.includes(current)) {
                        const preset = permissionPresets.resolve(current);
                        if (preset.sandbox === 'danger-full-access' && preset.approval === 'never') {
                            return async () => 'allow';
                        }
                    }
                }
                const approval = ctx.get('approval');
                if (approval === undefined)
                    return undefined;
                return async ({ title, signal }) => {
                    const outcome = await approval.request({
                        agent,
                        toolName: `ACP: ${title}`,
                        reason: `${server.name} requested permission to run "${title}".`,
                        signal,
                    });
                    if (outcome === 'allowed-once')
                        return 'allow';
                    if (outcome === 'cancelled')
                        return 'cancel';
                    return 'reject';
                };
            },
        });
        const registration = ctx.llm.registerAdapter([routeName(serverId)], adapter);
        return { connection, registration, fingerprint: serverFingerprint(server) };
    }
    /** Reconcile active connections with the current server set. */
    function reconcileServers() {
        const desired = mergedServers();
        const desiredIds = new Set(desired.keys());
        // Remove servers that are no longer configured.
        for (const [id, server] of active) {
            if (!desiredIds.has(id)) {
                server.registration();
                void server.connection.dispose().catch((error) => {
                    ctx.logger.warn(`llm-acp: connection disposal for "${id}" failed: ${error instanceof Error ? error.message : String(error)}`);
                });
                active.delete(id);
            }
        }
        // Add new servers or rebuild when an existing server's config changed.
        for (const [id, server] of desired) {
            const existing = active.get(id);
            if (existing === undefined) {
                try {
                    active.set(id, createServer(id, server));
                }
                catch (error) {
                    ctx.logger.error(`llm-acp: failed to create server "${id}": ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            else if (existing.fingerprint !== serverFingerprint(server)) {
                // Config changed (env, models, command, …): tear down and rebuild so
                // the adapter picks up the new enabledModels and the connection gets
                // the new env. A stale adapter would keep advertising old models.
                existing.registration();
                void existing.connection.dispose().catch((error) => {
                    ctx.logger.warn(`llm-acp: connection disposal for "${id}" failed: ${error instanceof Error ? error.message : String(error)}`);
                });
                active.delete(id);
                try {
                    active.set(id, createServer(id, server));
                }
                catch (error) {
                    ctx.logger.error(`llm-acp: failed to rebuild server "${id}": ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
    }
    /** Reconcile the configurable-provider directory. */
    let directory;
    let lastDirectoryFacts;
    function reconcileDirectory() {
        const entries = directoryEntries(mergedServers());
        if (deepEqualJson(entries, lastDirectoryFacts))
            return;
        if (directory === undefined) {
            directory = ctx.llm.registerConfigurableProviders(entries);
        }
        else {
            directory.replace(entries);
        }
        lastDirectoryFacts = entries;
    }
    // Initial registration from config servers.
    reconcileServers();
    reconcileDirectory();
    ctx.settings.installSection(ctx, NS, SettingsSchema, { servers: {} }, {
        setSource: (source) => {
            currentSettings = source;
        },
        onChange: () => {
            try {
                reconcileServers();
            }
            catch (error) {
                ctx.logger.error('llm-acp: keeping previously registered servers after a refused update');
                ctx.logger.error(error);
            }
            try {
                reconcileDirectory();
            }
            catch (error) {
                ctx.logger.error('llm-acp: keeping previous configurable-provider directory after a refused update');
                ctx.logger.error(error);
            }
        },
    });
    // Dispose all connections when this plugin's fiber ends.
    ctx.effect(() => {
        let disposed = false;
        return () => {
            if (disposed)
                return;
            disposed = true;
            for (const [, server] of active) {
                server.registration();
                void server.connection.dispose().catch(() => { });
            }
            active.clear();
        };
    });
}
//# sourceMappingURL=index.js.map