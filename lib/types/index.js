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
import { AcpConnection, DEFAULT_AUTH_TIMEOUT_MS, DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS, DEFAULT_INIT_TIMEOUT_MS, DEFAULT_SESSION_TIMEOUT_MS, } from "./connection.js";
import registryData from './registry.json' with { type: 'json' };
export { AcpAdapter } from "./adapter.js";
export { AcpConnection, DEFAULT_AUTH_TIMEOUT_MS, DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS, DEFAULT_INIT_TIMEOUT_MS, DEFAULT_SESSION_TIMEOUT_MS, } from "./connection.js";
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
    initTimeoutMs: z.number().default(DEFAULT_INIT_TIMEOUT_MS),
    sessionTimeoutMs: z.number().default(DEFAULT_SESSION_TIMEOUT_MS),
    authTimeoutMs: z.number().default(DEFAULT_AUTH_TIMEOUT_MS),
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
        customModels: z.array(z.object({
            id: z.string().required(),
            name: z.string().default(''),
        })).default([]),
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
/** Derive the bin name an npm package installs (heuristic: last path segment
 * of the package name, without scope or version). `@scope/name@ver` → `name`,
 * `name@ver` → `name`. The true bin may differ; this is only a PATH probe. */
function npmBinName(pkg) {
    const core = pkg.startsWith('@')
        ? pkg.split('@', 2)[1]?.split('/').pop()
        : pkg.split('@', 0)[0] ?? pkg.split('@')[0];
    return core;
}
/** Locate an executable in PATH; returns the absolute path or `undefined`.
 * ponytail: ceiling — scans PATH on every probe; called once per server spawn. */
function whichBin(bin) {
    const sep = process.platform === 'win32' ? ';' : ':';
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (const dir of (process.env.PATH ?? '').split(sep)) {
        if (dir.length === 0)
            continue;
        for (const ext of exts) {
            const p = resolve(dir, bin + ext);
            try {
                accessSync(p, constants.X_OK);
                return p;
            }
            catch { /* not in this dir */ }
        }
    }
    return undefined;
}
/**
 * Rewrite a `npx -y <pkg> [args…]` spawn to use the package's bin directly
 * when it is already in PATH, avoiding an npm fetch. Settings still store the
 * `npx` form (portable); the rewrite is a spawn-time optimization. Returns the
 * original pair when the pattern doesn't match or the bin is absent.
 */
function resolveNpxShortcut(command, args) {
    if (command !== 'npx')
        return { command, args: [...args] };
    const idx = args.findIndex(a => a === '-y' || a === '--yes');
    if (idx < 0 || idx + 1 >= args.length)
        return { command, args: [...args] };
    const pkg = args[idx + 1];
    if (typeof pkg !== 'string' || pkg.length === 0)
        return { command, args: [...args] };
    const rest = args.slice(idx + 2);
    const bin = npmBinName(pkg);
    if (bin === undefined)
        return { command, args: [...args] };
    const resolved = whichBin(bin);
    if (resolved === undefined)
        return { command, args: [...args] };
    return { command: resolved, args: rest };
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
        customModels: server.customModels ?? [],
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
    assertPositiveFinite('initTimeoutMs', resolved.initTimeoutMs);
    assertPositiveFinite('sessionTimeoutMs', resolved.sessionTimeoutMs);
    assertPositiveFinite('authTimeoutMs', resolved.authTimeoutMs);
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
    /** Best-effort system-browser open for an interactive login URL; failure keeps the URL in the auth warning. */
    function openBrowser(url) {
        const argv = process.platform === 'darwin'
            ? ['open', url]
            : process.platform === 'win32'
                ? ['cmd', '/c', 'start', '', url]
                : ['xdg-open', url];
        try {
            const handle = ctx.subprocess.spawn({
                argv,
                cwd,
                stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
                graceMs: resolved.disposeGraceMs,
            });
            handle.done.catch(() => { });
        }
        catch {
            // Spawn refused synchronously; the key-less auth timeout warning still shows the URL.
        }
    }
    /** Create one ACP connection + adapter for a server. */
    function createServer(serverId, server) {
        const serverEnv = { ...resolved.env, ...(server.env ?? {}) };
        // When a registry agent is distributed via `npx -y <pkg>`, prefer the
        // package's bin directly when it is already in PATH — avoids an npm fetch
        // and startup latency for agents the user has installed globally.
        const { command: spawnCommand, args: spawnArgs } = resolveNpxShortcut(server.command, server.args);
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
            spawn: spec => ctx.subprocess.spawn(spec),
            onWarn: message => ctx.logger.warn(message),
            onAuthUrl: openBrowser,
            // Resolve an API key from the server's configured env. When present,
            // it is passed via _meta.api_key in an eager authenticate round so ACP
            // servers that accept direct key auth skip interactive flows. When
            // absent, no authenticate call is made up front: servers using env
            // credentials or a cached login go straight to session/new, and only
            // a failed session/new triggers one lazy authenticate round — so a
            // healthy server never opens a browser login it did not need.
            resolveAuthApiKey: async () => {
                for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEVIN_API_KEY', 'API_KEY', 'CODEBUDDY_API_KEY', 'LLM_API_KEY']) {
                    const value = serverEnv[key];
                    if (typeof value === 'string' && value.length > 0)
                        return value;
                }
                return undefined;
            },
        });
        const adapter = new AcpAdapter({
            connection,
            provider: routeName(serverId),
            emitReasoning: resolved.emitReasoning,
            defaultModel: { id: resolved.defaultModelId, name: resolved.defaultModelName },
            enabledModels: server.models,
            customModels: server.customModels,
            permissionRequester: () => {
                const agents = ctx.get('agents');
                const agent = agents?.currentInitiator();
                if (agent === undefined)
                    return undefined;
                const permissionPresets = ctx.get('permissionPresets');
                if (permissionPresets !== undefined) {
                    // permissionPresets.current(session) reads the session projection
                    // internally via sessionProjections.stateOf(session, ...), which
                    // calls session.snapshotEvents() itself. Pass the session object,
                    // not a pre-snapshotted events array.
                    const sessionLike = agent.session;
                    const current = permissionPresets.current(sessionLike);
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
        return { connection, adapter, registration, fingerprint: serverFingerprint(server) };
    }
    /** Reconcile active connections with the current server set. */
    function reconcileServers() {
        const desired = mergedServers();
        const desiredIds = new Set(desired.keys());
        // Remove servers that are no longer configured.
        for (const [id, server] of active) {
            if (!desiredIds.has(id)) {
                server.adapter.disposeSessions();
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
                existing.adapter.disposeSessions();
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
    const INFO_PREFIX = 'acp-info-';
    // A third route convention, `acp-resolve-<binname>`, probes the host PATH
    // for an executable so the settings UI can store a local bin path instead
    // of `npx -y <pkg>` when the agent is already installed. The reply reuses
    // the `LlmDiscoveredModel` wire shape: `id` is the absolute path, `name`
    // is the bin name. Only the ACP settings UI consumes this route.
    const RESOLVE_PREFIX = 'acp-resolve-';
    // A fourth route convention, `acp-test-<id>`, runs an end-to-end probe for
    // the settings UI's server test dialog: create a throwaway session, send a
    // short prompt, collect the streamed reply, and close the session. The reply
    // reuses the `LlmDiscoveredModel` wire shape: `id` is `ok` or `error`, and
    // `name` carries the reply text or the failure message. Only the ACP
    // settings UI consumes this route.
    const TEST_PREFIX = 'acp-test-';
    // A fifth route convention, `acp-auth-<id>`, reports the server's pending
    // interactive-auth browser URL captured from the `_codebuddy.ai/authUrl`
    // extension notification. The reply reuses the `LlmDiscoveredModel` wire
    // shape: `id` is `auth` with `name` carrying the URL while a login is
    // pending, `id` `none` otherwise. Only the ACP settings UI consumes this
    // route.
    const AUTH_PREFIX = 'acp-auth-';
    /** How long to wait for `initialize` before the test probe reports failure. */
    const TEST_INIT_TIMEOUT_MS = 15_000;
    /** How long to wait for the probe prompt's terminal update before aborting. */
    const TEST_PROMPT_TIMEOUT_MS = 60_000;
    ctx.effect(() => ctx.llm.registerModelDiscovery(NS, async (request, _signal) => {
        const provider = request.provider ?? '';
        if (provider.length === 0)
            return [];
        if (provider.startsWith(RESOLVE_PREFIX)) {
            const bin = provider.slice(RESOLVE_PREFIX.length);
            if (bin.length === 0)
                return [];
            const resolved = whichBin(bin);
            if (resolved === undefined)
                return [];
            return [{ id: resolved, name: bin }];
        }
        if (provider.startsWith(INFO_PREFIX)) {
            const serverId = provider.slice(INFO_PREFIX.length);
            const server = active.get(serverId);
            if (server === undefined)
                return [{ id: 'error', name: 'server is not running — no active connection found for this server id; the server may have been removed or never started' }];
            let readySettled = false;
            let readyError;
            try {
                await Promise.race([
                    server.connection.ready.then(() => { readySettled = true; }, (error) => { readyError = error instanceof Error ? error : new Error(String(error)); }),
                    new Promise(resolve => setTimeout(() => resolve(undefined), 10_000)),
                ]);
            }
            catch (error) {
                return [{
                        id: 'error',
                        name: `initialize threw synchronously: ${error instanceof Error ? error.message : String(error)}`,
                    }];
            }
            if (readyError !== undefined) {
                return [{
                        id: 'error',
                        name: `initialize failed: ${readyError.message}`,
                    }];
            }
            if (!readySettled) {
                const authUrl = server.connection.getPendingAuthUrl();
                return [{
                        id: 'error',
                        name: `initialize timed out after 10s — the agent may still be starting (e.g. npx fetching a package), waiting for an interactive login, or the process may have exited`
                            + (authUrl !== undefined ? `; a browser login is pending: ${authUrl}` : '; check the host logs for llm-acp warnings'),
                    }];
            }
            const info = server.connection.getServerInfo();
            if (info === undefined) {
                return [{
                        id: 'error',
                        name: 'initialize completed but no protocol version was negotiated — the agent may have returned an invalid initialize response',
                    }];
            }
            if (info.agentInfoMissing) {
                return [{
                        id: 'unknown',
                        name: `agentInfo missing — initialize succeeded (protocol ${info.protocolVersion}) but the agent omitted or published an invalid agentInfo; the ACP SDK silently drops agentInfo that fails schema validation (name and version must be non-empty strings); the server may still be functional`,
                        contextWindow: info.protocolVersion,
                    }];
            }
            return [{
                    id: info.agentName,
                    name: info.agentVersion,
                    contextWindow: info.protocolVersion,
                }];
        }
        if (provider.startsWith(TEST_PREFIX)) {
            const serverId = provider.slice(TEST_PREFIX.length);
            const server = active.get(serverId);
            if (server === undefined)
                return [{ id: 'error', name: 'server is not running — no active connection found for this server id; the server may have been removed or never started' }];
            const fail = (error) => [{
                    id: 'error',
                    name: error instanceof Error ? error.message : String(error),
                }];
            try {
                await Promise.race([
                    server.connection.ready,
                    new Promise((_, reject) => setTimeout(() => reject(new Error(`initialize timed out after ${TEST_INIT_TIMEOUT_MS}ms — the agent may still be starting, waiting for an interactive login, or the process may have exited; check the host logs for llm-acp warnings`)), TEST_INIT_TIMEOUT_MS)),
                ]);
            }
            catch (error) {
                return fail(error);
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), TEST_PROMPT_TIMEOUT_MS);
            let sessionId;
            try {
                sessionId = await server.connection.newSession();
                let reply = '';
                for await (const update of server.connection.promptStream(sessionId, [{ type: 'text', text: 'Reply with exactly: pong' }], controller.signal)) {
                    if (update.kind === 'text')
                        reply += update.text;
                    else if (update.kind === 'done')
                        return [{ id: 'ok', name: reply }];
                    else if (update.kind === 'error')
                        throw new Error(update.error.message);
                }
                if (controller.signal.aborted)
                    throw new Error(`prompt timed out after ${TEST_PROMPT_TIMEOUT_MS}ms — the agent accepted the prompt but did not respond within the deadline; it may be stuck on an interactive login, a permission request, or an internal error`);
                throw new Error('stream ended without a stop reason — the agent closed the prompt stream without sending a terminal update; this may indicate a crash or protocol violation');
            }
            catch (error) {
                return fail(error);
            }
            finally {
                clearTimeout(timer);
                if (sessionId !== undefined)
                    server.connection.closeSession(sessionId);
            }
        }
        if (provider.startsWith(AUTH_PREFIX)) {
            const serverId = provider.slice(AUTH_PREFIX.length);
            const server = active.get(serverId);
            const url = server?.connection.getPendingAuthUrl();
            if (url === undefined || url.length === 0)
                return [{ id: 'none', name: '' }];
            return [{ id: 'auth', name: url }];
        }
        if (!provider.startsWith('acp-'))
            return [];
        const serverId = provider.slice(4);
        const server = active.get(serverId);
        if (server === undefined)
            return [];
        try {
            const discovered = await Promise.race([
                server.connection.discoverModels(),
                new Promise(resolve => setTimeout(() => resolve(undefined), 10_000)),
            ]);
            if (discovered === undefined)
                return [];
            const models = discovered.map(m => ({ id: m.id, name: m.name }));
            return models;
        }
        catch {
            return [];
        }
    }), 'llm-acp.modelDiscovery()');
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
                server.adapter.disposeSessions();
                server.registration();
                void server.connection.dispose().catch(() => { });
            }
            active.clear();
        };
    });
}
//# sourceMappingURL=index.js.map