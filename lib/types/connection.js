/**
 * Long-lived ACP client connection: spawns one external ACP server subprocess
 * at plugin load and drives it over JSON-RPC stdio. Each {@link AcpConnection.promptStream}
 * call targets one ACP session, sends one user message, and yields the
 * streamed assistant text/reasoning chunks plus a terminal stop reason.
 *
 * Authentication is lazy: `authenticate` runs eagerly only when a configured
 * API key resolves, and otherwise only after a `session/new`/`session/load`
 * failure — servers that accept env credentials or a cached login never see
 * an `authenticate` call, so a healthy server never triggers a browser login
 * it did not need. Every handshake and session operation is bounded by its
 * configured timeout so a wedged server fails fast instead of hanging the
 * harness.
 *
 * @module @deepseek-ai/dsh-llm-acp/connection
 */
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, } from '@agentclientprotocol/sdk';
/** EOF grace for child flush and nested-process teardown; wider than the signal grace. */
export const DEFAULT_DISPOSE_EOF_GRACE_MS = 6_000;
/**
 * Grace after `session/cancel` for the server to settle a hanging prompt.
 * A non-cooperative server may never answer the cancel; the pending drain
 * is force-settled as `cancelled` once this elapses so consumers are not
 * stuck on a dead prompt.
 */
const CANCEL_SETTLE_GRACE_MS = 5_000;
/**
 * Grace after an `idle` agent phase while a prompt response is still pending.
 * Some servers (observed: codebuddy) transition to `idle` on an internal model
 * failure without ever answering `session/prompt`; once this elapses the
 * pending drain is force-settled as an error so consumers are not stuck on a
 * dead prompt.
 */
const IDLE_SETTLE_GRACE_MS = 10_000;
/** Resolve after `ms` milliseconds. */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
/** Reject `operation` with a labelled error when it does not settle within `ms`. */
function withTimeout(operation, ms, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`llm-acp: ${label} timed out after ${ms}ms`)), ms);
        operation.then(value => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); });
    });
}
/**
 * Prefer an API-key-shaped auth method when several are advertised: the
 * first advertised method is often an interactive OAuth flow, which a keyed
 * `authenticate` call must not select.
 */
function pickAuthMethod(methods) {
    const keyed = methods.find(m => /api[-_]?key|token|credential/i.test(`${m.id} ${m.name}`));
    return keyed ?? methods[0];
}
/** Default POSIX grace between SIGTERM and SIGKILL on dispose. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000;
/** Default bound on the `initialize` handshake plus any keyed `authenticate` round. */
export const DEFAULT_INIT_TIMEOUT_MS = 120_000;
/** Default bound on `session/new`, `session/load`, and `session/set_config_option`. */
export const DEFAULT_SESSION_TIMEOUT_MS = 60_000;
/** Default bound on one `authenticate` round, keyed or key-less. */
export const DEFAULT_AUTH_TIMEOUT_MS = 15_000;
/** Default bound on one key-less interactive `authenticate` round: generous
 * enough for the user to finish a browser login before the failed session
 * call retries. */
export const DEFAULT_INTERACTIVE_AUTH_TIMEOUT_MS = 300_000;
/** Maximum protocol trace entries retained (ring buffer). */
const MAX_PROTOCOL_TRACE = 100;
/** Cap on one trace entry's serialized detail payload. */
const MAX_TRACE_DETAIL = 8_192;
/** Bounded whole-tree exit wait: polls the handle's tree liveness until it exits or `ms` elapses. */
async function treeExitsWithin(child, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, ms);
    try {
        return await child.waitForExit(controller.signal);
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Cooperative teardown ladder over the subprocess seam's public verbs: stdin
 * EOF (the child's window to flush and reap descendants), then the
 * `terminate()` escalation (SIGTERM → grace → SIGKILL) and its whole-tree exit
 * proof. Resolves only at whole-tree quiescence.
 * @param child - the spawned ACP child's handle.
 * @param eofGraceMs - tier-1 window after stdin EOF.
 */
export async function disposeAcpChild(child, eofGraceMs) {
    if (child.pid <= 0) {
        await child.done.catch(() => { });
        return;
    }
    child.stdin?.end();
    if (await treeExitsWithin(child, eofGraceMs))
        return;
    child.terminate();
    await child.waitForExit();
}
/** Whether an RPC failure is the ACP `authRequired` error (code -32000) — the
 * only failure that earns a lazy authenticate round. Timeout/transport errors
 * are not auth failures even though they share the same catch site. */
function isAuthRequiredError(error) {
    if (!(error instanceof Error))
        return false;
    const code = Reflect.get(error, 'code');
    if (code === -32000 || /^authentication required/i.test(error.message))
        return true;
    // A server that throws a plain Error gets wrapped as -32603 Internal error
    // with the original message preserved under `data.details`.
    const data = Reflect.get(error, 'data');
    const details = data === null || typeof data !== 'object' ? undefined : Reflect.get(data, 'details');
    return typeof details === 'string' && /^authentication required/i.test(details);
}
/** Whether an RPC failure came from a `withTimeout` deadline (message shape is `llm-acp: <label> timed out after Nms`). */
function isTimeoutError(error) {
    return error instanceof Error && /timed out after \d+ms$/.test(error.message);
}
/** Extract text from an ACP content block (non-text blocks contribute nothing). */
/**
 * Read an agent-phase extension marker (e.g. `_meta["codebuddy.ai/agentPhase"].phase`)
 * from a session update. Returns the phase string (`model_streaming`, `idle`, …)
 * or `undefined` when the update carries none.
 */
function acpAgentPhase(update) {
    const meta = Reflect.get(update, '_meta');
    if (meta === null || typeof meta !== 'object')
        return undefined;
    for (const [key, value] of Object.entries(meta)) {
        if (!key.endsWith('agentPhase'))
            continue;
        if (value === null || typeof value !== 'object')
            continue;
        const phase = Reflect.get(value, 'phase');
        if (typeof phase === 'string')
            return phase;
    }
    return undefined;
}
function acpContentText(content) {
    return content.type === 'text' ? content.text : '';
}
/** Truncate a string to a display-friendly length for permission prompts. */
function truncate(s, max = 120) {
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
/** Best-effort stringification of a non-string `rawInput` value. */
function tryStringify(value) {
    try {
        return typeof value === 'string' ? value : JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
/** Build a human-readable description of the tool call needing permission.
 * Prefers the server-provided `title`; when absent, derives one from
 * `kind`, `locations` (file paths), and `rawInput` so the user sees what
 * they are approving instead of a generic "ACP operation".
 * When all tool-call fields are empty (some agents send only a
 * `toolCallId`), the subject is extracted from the permission `options`
 * labels — which often embed it in backticks ("Yes, allow `git` commands
 * (this session)") — since the full label list is forwarded separately as
 * `optionLabels` for the prompt body. */
function describePermissionToolCall(toolCall, options) {
    const title = typeof toolCall.title === 'string' && toolCall.title.length > 0
        ? toolCall.title
        : '';
    if (title.length > 0)
        return title;
    const kind = toolCall.kind ?? '';
    const locations = toolCall.locations ?? [];
    const paths = locations
        .map(loc => loc.path)
        .filter((p) => typeof p === 'string' && p.length > 0);
    const rawInput = toolCall.rawInput;
    const inputSummary = typeof rawInput === 'string' && rawInput.length > 0
        ? rawInput
        : rawInput !== undefined && rawInput !== null
            ? tryStringify(rawInput)
            : '';
    if (kind.length > 0 && paths.length > 0)
        return `${kind}: ${paths.join(', ')}`;
    if (kind.length > 0 && inputSummary.length > 0)
        return `${kind}: ${truncate(inputSummary)}`;
    if (kind.length > 0)
        return kind;
    if (paths.length > 0)
        return paths.join(', ');
    if (inputSummary.length > 0)
        return truncate(inputSummary);
    // Fallback: the toolCall carried no descriptive fields. Option labels often
    // embed the subject in backticks ("Yes, allow `git` commands (this
    // session)") — surface that subject; the full label list still reaches the
    // prompt via optionLabels.
    if (options !== undefined && options.length > 0) {
        for (const option of options) {
            const name = option.name;
            if (typeof name !== 'string' || name.length === 0)
                continue;
            const quoted = /`([^`]+)`/.exec(name);
            const subject = quoted?.[1] ?? name
                .replace(/^yes,?\s*(?:always\s+)?allow\s+/i, '')
                .replace(/\s*\((?:this session|in all projects)\)\s*$/i, '')
                .trim();
            if (subject.length > 0 && !/^(?:allow|reject)$/i.test(subject)) {
                return `permission: ${truncate(subject)}`;
            }
        }
        return 'permission request';
    }
    // Last resort: dump the toolCall so the user sees what the agent sent.
    const dump = tryStringify(toolCall);
    return dump.length > 0 ? truncate(dump, 200) : 'ACP operation';
}
/**
 * One long-lived ACP client connection backed by a single child server
 * process. The connection is ready after {@link AcpConnection.ready}
 * resolves; dispose runs the full teardown ladder.
 */
export class AcpConnection {
    child;
    conn;
    spec;
    queues = new Map();
    readyPromise;
    disposed = false;
    disposal;
    /** Capabilities advertised by the agent in its `initialize` response. */
    agentCapabilities;
    /** Session lifecycle capabilities advertised by the agent. */
    sessionCapabilities;
    /** Agent name/version published in the `initialize` response (`agentInfo`). */
    agentInfo;
    /** Negotiated ACP protocol version from the `initialize` response. */
    protocolVersion;
    /** Auth methods advertised in the `initialize` response. */
    authMethods;
    /**
     * The connection's single `authenticate` round — the eager keyed attempt
     * during `initialize`, or the lazy key-less attempt started on the first
     * `session/new`/`session/load` failure. Set at most once; a second round
     * cannot succeed where the first did not.
     */
    authRound;
    /**
     * Browser login URL published via the `_codebuddy.ai/authUrl` extension
     * notification while an interactive `authenticate` round is in flight.
     * Captured so a key-less auth timeout can tell the user where to log in.
     */
    pendingAuthUrl;
    /** Set once {@link onAuthUrl} has fired — one browser open per connection. */
    authUrlNotified = false;
    /** Auth method id of the in-flight key-less round, if any. */
    interactiveAuthMethodId;
    cachedConfigOptions;
    configOptionsProbe;
    /** Ring buffer of recent ACP protocol interactions (max {@link MAX_PROTOCOL_TRACE}). */
    protocolTrace = [];
    constructor(spec) {
        this.spec = spec;
        this.child = spec.spawn({
            argv: [spec.command, ...spec.args],
            cwd: spec.cwd,
            stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
            graceMs: spec.disposeGraceMs,
            env: spec.env,
        });
        if (this.child.stdin === undefined || this.child.stdout === undefined) {
            throw new Error('llm-acp: subprocess implementation dropped a piped protocol stream');
        }
        const makeClient = (_agent) => ({
            sessionUpdate: (params) => {
                this.enqueueUpdate(params);
                return Promise.resolve();
            },
            requestPermission: (params) => {
                return this.requestPermission(params);
            },
            extNotification: (method, params) => {
                this.handleExtNotification(method, params);
                return Promise.resolve();
            },
            extMethod: (method, params) => {
                return this.handleExtMethod(method, params);
            },
        });
        this.conn = new ClientSideConnection(makeClient, ndJsonStream(NodeWritable.toWeb(this.child.stdin), NodeReadable.toWeb(this.child.stdout)));
        this.readyPromise = withTimeout(this.initialize(), spec.initTimeoutMs, `initialize of "${spec.command}"`);
    }
    /** Resolves when the ACP server has completed `initialize`. */
    get ready() {
        return this.readyPromise;
    }
    async initialize() {
        const spawnFailed = this.child.done.then(() => new Promise(() => { }), (err) => Promise.reject(err instanceof Error ? err : new Error(String(err))));
        spawnFailed.catch(() => { });
        let initResult;
        try {
            this.traceEvent('send', 'initialize', `protocolVersion=${PROTOCOL_VERSION}`, undefined, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
            initResult = await Promise.race([
                this.conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
                spawnFailed,
            ]);
        }
        catch (error) {
            throw new Error(`ACP server "${this.spec.command}" failed to initialize: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.agentCapabilities = initResult.agentCapabilities;
        this.sessionCapabilities = initResult.agentCapabilities?.sessionCapabilities;
        this.agentInfo = initResult.agentInfo ?? undefined;
        this.protocolVersion = initResult.protocolVersion;
        this.authMethods = initResult.authMethods ?? undefined;
        this.traceEvent('recv', 'initialize', `protocol=${initResult.protocolVersion} agent=${initResult.agentInfo?.name ?? '?'} v${initResult.agentInfo?.version ?? '?'} authMethods=${initResult.authMethods?.length ?? 0}`, undefined, initResult);
        try {
            await this.authenticateWithKey();
        }
        catch (error) {
            throw new Error(`ACP server "${this.spec.command}" failed to authenticate: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /** Whether the agent advertises `session/load` (session reuse). */
    get supportsLoadSession() {
        return this.agentCapabilities?.loadSession === true;
    }
    /** Whether the agent advertises `session/list` via sessionCapabilities. */
    get supportsListSessions() {
        return this.sessionCapabilities?.list != null && this.sessionCapabilities.list !== null;
    }
    /** Whether the agent advertises `session/delete` via sessionCapabilities. */
    get supportsDeleteSession() {
        return this.sessionCapabilities?.delete != null && this.sessionCapabilities.delete !== null;
    }
    /**
     * Server identity published in the `initialize` response: the agent's
     * reported name/version and the negotiated ACP protocol version. Returns
     * `undefined` before {@link ready} settles or when no protocol version was
     * negotiated. When the agent omitted or published an invalid `agentInfo`
     * (the SDK silently drops `agentInfo` failing schema validation —
     * `name`/`version` are required non-empty strings), `agentInfoMissing`
     * is `true` and `agentName`/`agentVersion` are empty; callers that need a
     * populated answer should `await ready` first.
     * @returns the agent name/version, protocol version, and whether
     * `agentInfo` was missing; or `undefined` when no protocol version exists.
     */
    getServerInfo() {
        const protocolVersion = this.protocolVersion;
        if (protocolVersion === undefined)
            return undefined;
        const info = this.agentInfo;
        if (info === undefined) {
            return { agentName: '', agentVersion: '', protocolVersion, agentInfoMissing: true };
        }
        return { agentName: info.name, agentVersion: info.version, protocolVersion, agentInfoMissing: false };
    }
    /**
     * The browser login URL most recently published via the
     * `_codebuddy.ai/authUrl` extension notification, or `undefined` when no
     * interactive login is pending. The settings UI surfaces it as a clickable
     * link so a headless host can still complete the browser login.
     */
    getPendingAuthUrl() {
        return this.pendingAuthUrl;
    }
    /**
     * The auth method id of an in-flight key-less interactive round, or
     * `undefined` when no round is running. Lets callers surface "waiting for
     * interactive login" even before (or without) an auth URL.
     */
    getPendingAuthMethod() {
        return this.interactiveAuthMethodId;
    }
    /**
     * Begin an interactive authenticate round when the server advertises auth
     * methods — a no-op otherwise. Waits for `initialize` first so the
     * advertised method list is populated; failures surface through `onWarn`.
     */
    requestInteractiveAuth() {
        void this.ready
            .then(() => this.ensureAuthenticated())
            .catch((error) => {
            this.spec.onWarn?.(`llm-acp: interactive auth for "${this.spec.command}" failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    /**
     * Recent ACP protocol interactions (ring buffer, {@link MAX_PROTOCOL_TRACE} entries). The
     * protocol inspector view polls this to show what the server is doing.
     * @returns a snapshot copy of the trace buffer.
     */
    getProtocolTrace() {
        return [...this.protocolTrace];
    }
    /** Append one trace entry, evicting the oldest when the buffer is full.
     * Consecutive entries sharing `collapseKey` merge into one with a `count`
     * so per-token stream chunks do not flood the buffer. */
    traceEvent(dir, method, summary, collapseKey, detail) {
        const last = this.protocolTrace[this.protocolTrace.length - 1];
        if (collapseKey !== undefined && last !== undefined
            && last.dir === dir && last.method === method && last.collapseKey === collapseKey) {
            last.time = Date.now();
            last.count = (last.count ?? 1) + 1;
            return;
        }
        this.protocolTrace.push({
            time: Date.now(), dir, method, summary,
            ...collapseKey === undefined ? {} : { collapseKey },
            ...detail === undefined ? {} : { detail: tryStringify(detail).slice(0, MAX_TRACE_DETAIL) },
        });
        while (this.protocolTrace.length > MAX_PROTOCOL_TRACE)
            this.protocolTrace.shift();
    }
    /**
     * Eager `authenticate` round, run during `initialize` only when the server
     * advertises auth methods AND a configured API key resolves. The key rides
     * as `_meta.api_key` for servers that accept direct key authentication; an
     * API-key-shaped method is preferred over an interactive OAuth one when
     * several are advertised. Without a key no `authenticate` call is made:
     * servers that accept env credentials or a cached login go straight to
     * `session/new`, and servers that truly require an interactive round reach
     * it lazily through {@link ensureAuthenticated} on the first failed
     * `session/new` — so a well-configured server never triggers a browser
     * login it did not need.
     */
    async authenticateWithKey() {
        const methods = this.authMethods;
        if (methods === undefined || methods.length === 0)
            return;
        const apiKey = this.spec.resolveAuthApiKey !== undefined
            ? await this.spec.resolveAuthApiKey().catch(() => undefined)
            : undefined;
        if (apiKey === undefined)
            return;
        const method = pickAuthMethod(methods);
        if (method === undefined)
            return;
        this.traceEvent('send', 'authenticate', `methodId=${method.id} (with key)`, undefined, { methodId: method.id });
        this.authRound = withTimeout(this.conn.authenticate({ methodId: method.id, _meta: { api_key: apiKey } }).then(() => {
            this.traceEvent('recv', 'authenticate', `methodId=${method.id} ok`, undefined, { methodId: method.id });
        }), this.spec.authTimeoutMs, 'authenticate');
        await this.authRound;
    }
    /**
     * The connection's single key-less `authenticate` round, started lazily by
     * {@link withAuthRetry} when `session/new`/`session/load` fails on a server
     * that advertised auth methods. Servers with cached credentials (e.g.
     * codebuddy) resolve the call immediately — and only then accept
     * `session/new`. The round is bounded and best-effort: on timeout or error
     * the connection stays usable, and a browser login URL published via the
     * `_codebuddy.ai/authUrl` extension notification is surfaced in the
     * warning so the user can complete an interactive login.
     */
    ensureAuthenticated() {
        if (this.authRound !== undefined)
            return this.authRound;
        // Key-less auth uses the first advertised method — the server's default,
        // which is the method its cached-credential and interactive flows share.
        const method = this.authMethods?.[0];
        if (method === undefined)
            return Promise.resolve();
        this.pendingAuthUrl = undefined;
        this.interactiveAuthMethodId = method.id;
        this.authRound = (async () => {
            try {
                this.traceEvent('send', 'authenticate', `methodId=${method.id} (key-less)`, undefined, { methodId: method.id });
                const attempt = this.conn.authenticate({ methodId: method.id });
                const settled = await Promise.race([
                    attempt.then(() => ({ done: true, error: undefined }), (error) => ({ done: true, error })),
                    sleep(this.spec.interactiveAuthTimeoutMs).then(() => ({ done: false, error: undefined })),
                ]);
                if (settled.done) {
                    if (settled.error !== undefined) {
                        const message = settled.error instanceof Error ? settled.error.message : String(settled.error);
                        this.spec.onWarn?.(`llm-acp: key-less authentication for "${this.spec.command}" failed: ${message}`);
                        this.traceEvent('recv', 'authenticate', `methodId=${method.id} error: ${message}`, undefined, { methodId: method.id, error: message });
                    }
                    else {
                        this.pendingAuthUrl = undefined;
                        this.traceEvent('recv', 'authenticate', `methodId=${method.id} ok`, undefined, { methodId: method.id });
                    }
                    return;
                }
                const url = this.pendingAuthUrl;
                this.spec.onWarn?.(`llm-acp: interactive authentication for "${this.spec.command}" is still pending after ${this.spec.interactiveAuthTimeoutMs}ms`
                    + (url !== undefined ? ` — complete the login in a browser: ${url}` : ''));
            }
            finally {
                // Clear the latch so a later auth failure starts a fresh round.
                this.authRound = undefined;
                this.interactiveAuthMethodId = undefined;
            }
        })();
        return this.authRound;
    }
    /**
     * Run one session operation bounded by `sessionTimeoutMs`. On failure —
     * once, and only while no `authenticate` round has run yet and the server
     * advertised auth methods — run {@link ensureAuthenticated} and retry.
     * This is the lazy-auth path: servers that accept env credentials or a
     * cached login never see an `authenticate` call at all.
     */
    async withAuthRetry(label, call) {
        try {
            return await withTimeout(call(), this.spec.sessionTimeoutMs, label);
        }
        catch (error) {
            // Only an actual auth failure earns an authenticate round; timeouts and
            // transport errors would otherwise stall the caller behind a key-less
            // interactive round that cannot help them.
            if (this.authMethods === undefined || this.authMethods.length === 0 || !isAuthRequiredError(error))
                throw error;
            const message = error instanceof Error ? error.message : String(error);
            this.spec.onWarn?.(`llm-acp: ${label} failed for "${this.spec.command}" (${message}); running one authenticate round then retrying`);
            // Concurrent failures share the in-flight round (or a finished one ends
            // immediately); each caller retries its own operation once afterwards.
            await this.ensureAuthenticated();
            return await withTimeout(call(), this.spec.sessionTimeoutMs, label);
        }
    }
    /** Resolve one ACP permission request through its owning session. */
    async requestPermission(params) {
        const entry = this.queues.get(params.sessionId);
        if (entry?.permissionRequester === undefined) {
            this.spec.onWarn?.('llm-acp: interactive permission request failed closed because no active harness approval requester was available');
            return this.rejectPermission(params);
        }
        let decision;
        try {
            const title = describePermissionToolCall(params.toolCall, params.options);
            const optionLabels = params.options
                .map(o => o.name)
                .filter((n) => typeof n === 'string' && n.length > 0);
            this.traceEvent('recv', 'session/request_permission', `title="${title}"`, undefined, params);
            this.spec.onWarn?.(`llm-acp: permission request toolCall=${JSON.stringify(params.toolCall)} options=${JSON.stringify(params.options.map(o => ({ kind: o.kind, name: o.name })))} -> title="${title}"`);
            decision = await entry.permissionRequester({ title, signal: entry.signal, optionLabels });
        }
        catch (error) {
            this.spec.onWarn?.(`llm-acp: permission request failed closed: ${error instanceof Error ? error.message : String(error)}`);
            return this.rejectPermission(params);
        }
        if (decision === 'cancel')
            return { outcome: { outcome: 'cancelled' } };
        if (decision === 'reject')
            return this.rejectPermission(params);
        const option = params.options.find(item => item.kind === 'allow_once');
        return option === undefined
            ? this.rejectPermission(params)
            : { outcome: { outcome: 'selected', optionId: option.optionId } };
    }
    /** Select an advertised rejection option, or cancel when none is available. */
    rejectPermission(params) {
        const option = params.options.find(item => item.kind === 'reject_once' || item.kind === 'reject_always');
        return option === undefined
            ? { outcome: { outcome: 'cancelled' } }
            : { outcome: { outcome: 'selected', optionId: option.optionId } };
    }
    /** Push an inbound session/update into the owning session's queue. */
    enqueueUpdate(params) {
        const entry = this.queues.get(params.sessionId);
        const update = params.update;
        if (entry === undefined) {
            // Content updates on an unqueued session lose real output — keep them
            // per-session in the trace. Session-setup broadcasts (config options,
            // mode, commands, usage) arrive for every new/discovery session and are
            // pure noise, so collapse them across sessions into one counted row.
            const contentDrop = update.sessionUpdate === 'agent_message_chunk'
                || update.sessionUpdate === 'agent_thought_chunk'
                || update.sessionUpdate === 'tool_call'
                || update.sessionUpdate === 'plan';
            this.traceEvent('recv', 'session/update-dropped', `${update.sessionUpdate} sessionId=${params.sessionId}`, contentDrop ? `drop:${update.sessionUpdate}:${params.sessionId}` : `drop:${update.sessionUpdate}`, params);
            this.spec.onWarn?.(`llm-acp: dropped session/update ${update.sessionUpdate} for unqueued session ${params.sessionId}`);
            return;
        }
        const isChunk = update.sessionUpdate === 'agent_thought_chunk' || update.sessionUpdate === 'agent_message_chunk';
        const preview = isChunk
            ? ` text=${JSON.stringify(acpContentText(update.content).slice(0, 40))}`
            : '';
        this.traceEvent('recv', 'session/update', `${update.sessionUpdate} sessionId=${params.sessionId}${preview}`, isChunk ? `update:${update.sessionUpdate}:${params.sessionId}` : undefined, params);
        if (update.sessionUpdate === 'agent_message_chunk') {
            entry.queue.push({ kind: 'text', text: acpContentText(update.content) });
        }
        else if (update.sessionUpdate === 'agent_thought_chunk') {
            entry.queue.push({ kind: 'reasoning', text: acpContentText(update.content) });
        }
        else if (update.sessionUpdate === 'tool_call') {
            // Tool calls are consumed but not surfaced as text; the ACP server
            // executes its own tools internally. Surface a progress note so the
            // user sees activity rather than a silent hang.
            const title = update.title ?? 'tool';
            entry.queue.push({ kind: 'progress', text: `[tool: ${title}]` });
        }
        else if (update.sessionUpdate === 'tool_call_update') {
            // Intermediate tool-call updates are consumed silently.
        }
        else if (update.sessionUpdate === 'plan') {
            // Plan updates are consumed but not surfaced.
        }
        else if (update.sessionUpdate === 'user_message_chunk') {
            // Echo of user input; consumed silently.
        }
        // Other update variants are consumed but not surfaced.
        const phase = acpAgentPhase(update);
        if (phase === 'idle') {
            // Agent reports idle while the prompt is still unsettled. Normally the
            // `session/prompt` response lands a beat later; if it never does (dead
            // internal model call), the watchdog settles the drain as an error.
            if (entry.idleTimer === undefined) {
                entry.idleTimer = setTimeout(() => {
                    entry.idleTimer = undefined;
                    if (entry.promptSettled === true)
                        return;
                    // Free the server's in-flight prompt: serial servers queue every
                    // later call (including session/new) behind this dead prompt. The
                    // cancel is best-effort — a wedged handler may not reach it — so the
                    // owner also gets onDeadPrompt to rebuild the connection.
                    void this.conn.cancel({ sessionId: params.sessionId }).catch(() => { });
                    this.spec.onWedged?.(`prompt went idle without answering (session ${params.sessionId})`);
                    entry.queue.push({
                        kind: 'error',
                        error: new Error(`llm-acp: agent went idle without answering session/prompt for session ${params.sessionId} — the server dropped the turn`),
                    });
                    this.signal(entry);
                }, IDLE_SETTLE_GRACE_MS);
            }
        }
        else if (phase !== undefined && entry.idleTimer !== undefined) {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = undefined;
        }
        this.signal(entry);
    }
    /**
     * Handle extension notifications from ACP servers that use non-standard
     * protocols (e.g. Devin's `_cognition.ai/*` notifications). These are
     * silently consumed to prevent SDK error logs, with progress notifications
     * surfaced to keep the user informed during long operations.
     */
    handleExtNotification(method, params) {
        this.traceEvent('recv', method, tryStringify(params).slice(0, 100), undefined, params);
        // Devin sends `_cognition.ai/output` with a `message` field for logging.
        if (method === '_cognition.ai/output') {
            const message = typeof params.message === 'string' ? params.message : '';
            const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
            if (message.length > 0 && sessionId.length > 0) {
                const entry = this.queues.get(sessionId);
                if (entry !== undefined) {
                    entry.queue.push({ kind: 'progress', text: message });
                    this.signal(entry);
                }
            }
            return;
        }
        // `_cognition.ai/thinking_complete` indicates the agent finished a
        // thinking block; no text payload to surface.
        if (method === '_cognition.ai/thinking_complete')
            return;
        // `_cognition.ai/agent_stopped` indicates the agent finished its turn;
        // the terminal stopReason arrives via the `session/prompt` response.
        if (method === '_cognition.ai/agent_stopped')
            return;
        // `_cognition.ai/mcp/serversChanged` indicates MCP server topology change.
        if (method === '_cognition.ai/mcp/serversChanged')
            return;
        // `_cognition.ai/connection_retry` indicates a backend retry.
        if (method === '_cognition.ai/connection_retry')
            return;
        // `_codebuddy.ai/authUrl` publishes the browser login URL for an
        // in-flight `authenticate` round (codebuddy). Captured so a key-less
        // interactive auth can surface it to the user instead of hanging silently.
        if (method === '_codebuddy.ai/authUrl') {
            const authUrl = typeof params.authUrl === 'string' ? params.authUrl : '';
            if (authUrl.length > 0) {
                this.pendingAuthUrl = authUrl;
                // Auto-open at most once per connection: later publishes (a repeated
                // notification or a new round after the authRound latch released)
                // only refresh the URL the UI polls via `acp-auth-<id>`.
                if (!this.authUrlNotified) {
                    this.authUrlNotified = true;
                    this.spec.onAuthUrl?.(authUrl);
                }
            }
            return;
        }
        // Unknown extension notifications are logged for diagnosis, then consumed.
        this.spec.onWarn?.(`llm-acp: unhandled extension notification ${method}: ${tryStringify(params).slice(0, 200)}`);
    }
    /**
     * Handle extension requests from ACP servers. Currently no extension
     * requests are expected; return an empty object to satisfy the protocol.
     */
    handleExtMethod(method, _params) {
        this.spec.onWarn?.(`llm-acp: unhandled extension request: ${method}`);
        return Promise.resolve({});
    }
    /** Wake a consumer waiting on an empty queue. */
    signal(entry) {
        const resolve = entry.resolve;
        if (resolve !== undefined) {
            entry.resolve = undefined;
            resolve();
        }
    }
    /** Drain the queue for one session, awaiting new updates when it is empty. */
    async *drainQueue(sessionId) {
        const entry = this.queues.get(sessionId);
        if (entry === undefined)
            return;
        while (true) {
            while (entry.queue.length > 0) {
                yield entry.queue.shift();
            }
            if (entry.queue.length === 0) {
                await new Promise((resolve) => { entry.resolve = resolve; });
            }
        }
    }
    /**
     * Create a fresh ACP session for one prompt. The session is removed from the
     * connection's queue map after the generator completes or is abandoned.
     * @returns the remote session id.
     */
    async newSession() {
        this.traceEvent('send', 'session/new', `cwd=${this.spec.cwd}`, undefined, { cwd: this.spec.cwd, mcpServers: [] });
        let session;
        try {
            session = await this.withAuthRetry('session/new', () => this.conn.newSession({ cwd: this.spec.cwd, mcpServers: [] }));
        }
        catch (error) {
            // A timed-out session/new on a serial server means its request queue is
            // wedged behind a dead prompt — tell the owner to rebuild instead of
            // leaving every later call to starve the same way.
            if (isTimeoutError(error))
                this.spec.onWedged?.(`session/new timed out after ${this.spec.sessionTimeoutMs}ms`);
            throw error;
        }
        const returnedId = Reflect.get(session, 'sessionId');
        if (typeof returnedId !== 'string') {
            throw new Error('llm-acp: ACP server published a session without a string sessionId');
        }
        this.traceEvent('recv', 'session/new', `sessionId=${returnedId}`, undefined, session);
        return returnedId;
    }
    /**
     * Load an existing ACP session by id (`session/load`). Only available when
     * the agent advertises the `loadSession` capability. Returns the session's
     * current config options (models, modes, etc.) if the server publishes them.
     * @param sessionId - the remote session id to resume.
     * @returns the config options published by the server, or `undefined`.
     */
    async loadSession(sessionId) {
        const session = await this.withAuthRetry('session/load', () => this.conn.loadSession({ sessionId, cwd: this.spec.cwd, mcpServers: [] }));
        const configOptions = Reflect.get(session, 'configOptions');
        return configOptions ?? undefined;
    }
    /**
     * List existing ACP sessions (`session/list`). Only available when the agent
     * advertises the `session/list` capability. Returns `undefined` when the
     * agent does not support listing.
     * @param cursor - optional pagination cursor from a previous response.
     * @returns the session list and optional next cursor, or `undefined`.
     */
    async listSessions(cursor) {
        if (!this.supportsListSessions)
            return undefined;
        const result = await withTimeout(this.conn.listSessions({ cursor: cursor ?? null }), this.spec.sessionTimeoutMs, 'session/list');
        const nextCursor = result.nextCursor;
        return nextCursor !== null && nextCursor !== undefined
            ? { sessions: result.sessions, nextCursor }
            : { sessions: result.sessions };
    }
    /**
     * Delete an ACP session (`session/delete`). Only available when the agent
     * advertises the `session/delete` capability. Best-effort: errors are
     * swallowed because the session may already be gone.
     * @param sessionId - the remote session id to delete.
     * @returns `true` if the session was deleted, `false` if unsupported or failed.
     */
    async deleteSession(sessionId) {
        if (!this.supportsDeleteSession)
            return false;
        try {
            await this.conn.deleteSession({ sessionId });
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Probe the ACP server for its model catalog by creating a throwaway session
     * and reading the `configOptions` (category `model`) from the `session/new`
     * response. The probe session is closed immediately. Returns `undefined` when
     * the server publishes no model config option.
     * @returns the model entries, or `undefined` if none were advertised.
     */
    async discoverModels() {
        const options = await this.discoverConfigOptions();
        if (options === undefined)
            return undefined;
        return this.extractModels(options);
    }
    /**
     * Probe the ACP server for its full config option catalog by creating a
     * throwaway session and reading `configOptions` from the `session/new`
     * response. The probe session is closed immediately. Returns `undefined`
     * when the server publishes no config options.
     * @returns all config options (models, modes, thought levels, etc.).
     */
    async discoverConfigOptions() {
        await this.ready;
        if (this.cachedConfigOptions !== undefined)
            return this.cachedConfigOptions;
        // Share one in-flight probe so concurrent polls do not each spawn a session.
        this.configOptionsProbe ??= this.probeConfigOptions();
        const options = await this.configOptionsProbe;
        this.configOptionsProbe = undefined;
        if (options !== undefined)
            this.cachedConfigOptions = options;
        return options;
    }
    /** Single config-option probe: one throwaway session, closed immediately. */
    async probeConfigOptions() {
        const session = await this.withAuthRetry('session/new', () => this.conn.newSession({ cwd: this.spec.cwd, mcpServers: [] }));
        const configOptions = Reflect.get(session, 'configOptions');
        const sessionId = Reflect.get(session, 'sessionId');
        if (typeof sessionId === 'string') {
            void this.conn.closeSession({ sessionId }).catch(() => { });
        }
        if (configOptions === undefined || configOptions === null)
            return undefined;
        return configOptions;
    }
    /**
     * List the session modes this server advertises via the `mode` config
     * option (category `mode`, type `select`), e.g. Devin's
     * `accept-edits`/`bypass`. `undefined` when the server publishes no mode
     * selector or the config-option probe is unsupported.
     */
    async discoverModes() {
        const options = await this.discoverConfigOptions();
        if (options === undefined)
            return undefined;
        return this.extractSelectValues(options, 'mode');
    }
    /** Extract model entries from a config option list (category `model`, type `select`). */
    extractModels(options) {
        return this.extractSelectValues(options, 'model');
    }
    /** Collect the leaf `{value, name}` pairs of one select config option by
     * category. Handles both flat option lists and grouped option lists per the
     * ACP `SessionConfigSelectOptions` union: a group entry carries its own
     * `options` array of leaf values, so flatten one level before collecting. */
    extractSelectValues(options, category) {
        const selectOption = options.find(opt => opt.category === category && opt.type === 'select');
        if (selectOption === undefined || selectOption.type !== 'select')
            return undefined;
        const selectOptions = Array.isArray(selectOption.options) ? selectOption.options : [];
        const entries = [];
        for (const opt of selectOptions) {
            if ('value' in opt && typeof opt.value === 'string' && typeof opt.name === 'string') {
                entries.push({ id: opt.value, name: opt.name });
            }
            else if ('group' in opt && Array.isArray(opt.options)) {
                for (const leaf of opt.options) {
                    if ('value' in leaf && typeof leaf.value === 'string' && typeof leaf.name === 'string') {
                        entries.push({ id: leaf.value, name: leaf.name });
                    }
                }
            }
        }
        return entries.length > 0 ? entries : undefined;
    }
    /**
     * Set the model for one ACP session via `session/set_config_option`. Best-effort:
     * if the server rejects the config id or value, the error surfaces from the
     * caller. Only called when the model differs from the server's current value.
     * @param sessionId - the remote session id from {@link AcpConnection.newSession}.
     * @param modelId - the model value id to select.
     */
    async setSessionModel(sessionId, modelId) {
        await withTimeout(this.conn.setSessionConfigOption({ sessionId, configId: 'model', value: modelId }), this.spec.sessionTimeoutMs, 'session/set_config_option');
    }
    /**
     * Switch the ACP session's mode (e.g. `bypass` on agents that publish a
     * `mode` config option). Prefers the unified `session/set_config_option`
     * write and falls back to the legacy `session/set_mode` when the config
     * option is unknown to the server.
     * @param sessionId - the remote session id from {@link AcpConnection.newSession}.
     * @param modeId - the mode value id to select.
     */
    async setSessionMode(sessionId, modeId) {
        try {
            await withTimeout(this.conn.setSessionConfigOption({ sessionId, configId: 'mode', value: modeId }), this.spec.sessionTimeoutMs, 'session/set_config_option');
        }
        catch {
            await withTimeout(this.conn.setSessionMode({ sessionId, modeId }), this.spec.sessionTimeoutMs, 'session/set_mode');
        }
    }
    /**
     * Send one user message to `sessionId` and yield streamed assistant updates
     * until the prompt call settles. The SDK v1 contract delivers the terminal
     * `stopReason` in the `session/prompt` response; streamed
     * `agent_message_chunk` updates arrive first via the sessionUpdate callback.
     * The generator emits text/reasoning chunks followed by a single terminal
     * `done` or `error` update, then removes the session queue.
     *
     * Cancellation: when `signal` aborts, a best-effort `session/cancel` is sent
     * and the generator ends after draining any already-queued updates.
     * @param sessionId - the remote session id from {@link AcpConnection.newSession}.
     * @param prompt - ACP content blocks forming the single user message.
     * @param signal - cancellation; abort triggers a best-effort ACP cancel.
     * @param permissionRequester - interactive requester captured for this prompt.
     */
    async *promptStream(sessionId, prompt, signal, permissionRequester) {
        const entry = { queue: [], resolve: undefined, permissionRequester, signal };
        this.queues.set(sessionId, entry);
        // On abort the server gets `session/cancel`; a non-cooperative server may
        // never answer it, so after CANCEL_SETTLE_GRACE_MS the pending drain is
        // force-settled as `cancelled` instead of waiting on a dead prompt.
        let cancelTimer;
        const onAbort = () => {
            void this.conn.cancel({ sessionId }).catch(() => { });
            cancelTimer = setTimeout(() => {
                entry.queue.push({ kind: 'done', reason: 'cancelled' });
                this.signal(entry);
            }, CANCEL_SETTLE_GRACE_MS);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        // An already-aborted signal never fires 'abort' again — settle now.
        if (signal.aborted)
            onAbort();
        const promptSummary = prompt.map(b => b.type === 'text' ? b.text.slice(0, 60) : `[${b.type}]`).join(' ');
        this.traceEvent('send', 'session/prompt', `sessionId=${sessionId} prompt=${promptSummary.slice(0, 80)}`, undefined, { sessionId, prompt });
        const settled = this.conn.prompt({ sessionId, prompt }).then((result) => {
            const stopReason = Reflect.get(result, 'stopReason');
            this.traceEvent('recv', 'session/prompt', `stopReason=${stopReason ?? 'end_turn'}`, undefined, result);
            entry.promptSettled = true;
            if (entry.idleTimer !== undefined) {
                clearTimeout(entry.idleTimer);
                entry.idleTimer = undefined;
            }
            entry.queue.push({ kind: 'done', reason: stopReason ?? 'end_turn' });
            this.signal(entry);
        }, (err) => {
            const error = err instanceof Error ? err : new Error(String(err));
            entry.promptSettled = true;
            if (entry.idleTimer !== undefined) {
                clearTimeout(entry.idleTimer);
                entry.idleTimer = undefined;
            }
            entry.queue.push({ kind: 'error', error });
            this.signal(entry);
        });
        void settled.catch(() => { });
        try {
            for await (const update of this.drainQueue(sessionId)) {
                yield update;
                if (update.kind === 'done' || update.kind === 'error')
                    break;
            }
        }
        finally {
            signal.removeEventListener('abort', onAbort);
            if (cancelTimer !== undefined)
                clearTimeout(cancelTimer);
            if (entry.idleTimer !== undefined)
                clearTimeout(entry.idleTimer);
            this.queues.delete(sessionId);
        }
    }
    /**
     * Close one ACP session after a prompt completes. Best-effort: errors are
     * swallowed because the session may already be gone.
     * @param sessionId - the remote session id to close.
     */
    closeSession(sessionId) {
        void this.conn.closeSession({ sessionId }).catch(() => { });
    }
    /** Best-effort cancel of one in-flight session; unknown ids are no-ops. */
    cancel(sessionId) {
        void this.conn.cancel({ sessionId }).catch(() => { });
    }
    /** Idempotent disposal: runs the teardown ladder once and resolves at quiescence. */
    dispose() {
        if (this.disposed)
            return this.disposal ?? Promise.resolve();
        this.disposed = true;
        this.disposal = (async () => {
            for (const [, entry] of this.queues) {
                entry.queue.push({ kind: 'error', error: new Error('llm-acp: connection disposed') });
                this.signal(entry);
            }
            this.queues.clear();
            await disposeAcpChild(this.child, this.spec.disposeEofGraceMs);
        })();
        return this.disposal;
    }
}
//# sourceMappingURL=connection.js.map