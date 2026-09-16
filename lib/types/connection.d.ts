/**
 * Long-lived ACP client connection: spawns one external ACP server subprocess
 * at plugin load and drives it over JSON-RPC stdio. Each {@link AcpConnection.promptStream}
 * call targets one ACP session, sends one user message, and yields the
 * streamed assistant text/reasoning chunks plus a terminal stop reason.
 *
 * Authentication is lazy: `authenticate` runs eagerly only when a configured
 * API key resolves, and otherwise only after a `session/new`
 * failure — servers that accept env credentials or a cached login never see
 * an `authenticate` call, so a healthy server never triggers a browser login
 * it did not need. When a server advertises several auth methods, the round
 * waits for the operator's `authMethod` selection instead of guessing:
 * methods differ in reachability (codebuddy's intranet-only `iOA` versus its
 * public `external`), so a guess can hang for the whole interactive window.
 * Every handshake and session operation is bounded by its configured timeout
 * so a wedged server fails fast instead of hanging the harness.
 *
 * @module @deepseek-ai/dsh-llm-acp/connection
 */
import { type ContentBlock as AcpContentBlock, type SessionConfigOption, type SessionInfo, type StopReason } from '@agentclientprotocol/sdk';
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
/** EOF grace for child flush and nested-process teardown; wider than the signal grace. */
export declare const DEFAULT_DISPOSE_EOF_GRACE_MS = 6000;
/** Default POSIX grace between SIGTERM and SIGKILL on dispose. */
export declare const DEFAULT_DISPOSE_GRACE_MS = 3000;
/** Default bound on the `initialize` handshake plus any keyed `authenticate` round. */
export declare const DEFAULT_INIT_TIMEOUT_MS = 120000;
/** Default bound on `session/new`, `session/list`, and `session/set_config_option`. */
export declare const DEFAULT_SESSION_TIMEOUT_MS = 60000;
/** Default bound on one `authenticate` round, keyed or key-less. */
export declare const DEFAULT_AUTH_TIMEOUT_MS = 15000;
/** Default bound on one key-less interactive `authenticate` round: generous
 * enough for the user to finish a browser login before the failed session
 * call retries. */
export declare const DEFAULT_INTERACTIVE_AUTH_TIMEOUT_MS = 300000;
/** One queued update delivered to a {@link AcpConnection.promptStream} consumer. */
type QueuedUpdate = {
    kind: 'text';
    text: string;
} | {
    kind: 'reasoning';
    text: string;
} | {
    kind: 'progress';
    text: string;
}
/**
 * A tool call the ACP server started: `id` correlates with a later
 * `tool-end`, `name` is the server-provided display title, `args` is the
 * serialized `rawInput` (`{}` when the server sent none), `subagent` marks a
 * call made inside a subagent, and `toolKind` is the ACP tool kind
 * (read/edit/execute/…) — `''` when the server omitted it. The host maps
 * `toolKind` onto a native harness tool name so the call renders with the
 * matching row family instead of the generic one.
 */
 | {
    kind: 'tool';
    id: string;
    name: string;
    args: string;
    subagent: boolean;
    toolKind: string;
}
/** A tool call reached a terminal status (`completed`/`failed`). */
 | {
    kind: 'tool-end';
    id: string;
    status: 'completed' | 'failed';
    output: string;
}
/** Agent-side event the caller chose to surface (see `AcpSubagentNotice`). */
 | {
    kind: 'notice';
    text: string;
} | {
    kind: 'usage';
    used: number;
} | {
    kind: 'done';
    reason: StopReason;
} | {
    kind: 'error';
    error: Error;
};
/** Decision returned by an interactive ACP permission requester. */
export type AcpPermissionDecision = 'allow' | 'reject' | 'cancel';
/**
 * Whether ACP-side subagent activity is surfaced for the calling session.
 * `notice` notes it in the stream, `silent` consumes it.
 */
export type AcpSubagentNotice = 'notice' | 'silent';
/**
 * Auth-method picker state: what the server advertises, what the operator
 * selected, and whether a blocked attempt has made a choice necessary.
 */
export interface AcpAuthMethodState {
    /** Methods advertised in the `initialize` response; empty before it. */
    methods: readonly {
        id: string;
        name: string;
    }[];
    /** The configured method id, `''` when the operator has not chosen yet. */
    selected: string;
    /** Whether authentication is currently blocked until a method is chosen. */
    needed: boolean;
}
/** One captured ACP protocol interaction, for the protocol inspector view. */
export interface ProtocolTraceEntry {
    /** Epoch milliseconds. */
    time: number;
    /** Request, response, or notification. */
    dir: 'send' | 'recv';
    /** JSON-RPC method name (e.g. `initialize`, `session/new`, `session/update`). */
    method: string;
    /** Human-readable summary of the payload. */
    summary: string;
    /** How many consecutive interactions this entry represents (default 1). */
    count?: number;
    /** Internal merge key; consecutive entries with the same key collapse into one. */
    collapseKey?: string;
    /** Full payload JSON for the detail pane, truncated. */
    detail?: string;
}
/** Permission details forwarded from an ACP server to an interactive requester. */
export interface AcpPermissionRequest {
    title: string;
    signal: AbortSignal;
    /** Human-readable labels of the permission options the server offered
     * (e.g. "Allow once", "Reject always"), for display when the toolCall
     * itself carries no descriptive fields. */
    optionLabels?: readonly string[];
}
/** Interactive permission requester captured for one prompt session. */
export type AcpPermissionRequester = (request: AcpPermissionRequest) => Promise<AcpPermissionDecision>;
/**
 * Cooperative teardown ladder over the subprocess seam's public verbs: stdin
 * EOF (the child's window to flush and reap descendants), then the
 * `terminate()` escalation (SIGTERM → grace → SIGKILL) and its whole-tree exit
 * proof. Resolves only at whole-tree quiescence.
 * @param child - the spawned ACP child's handle.
 * @param eofGraceMs - tier-1 window after stdin EOF.
 */
export declare function disposeAcpChild(child: SubprocessHandle, eofGraceMs: number): Promise<void>;
/** Resolved spawn spec for the long-lived ACP server process. */
export interface AcpConnectionSpec {
    /** The executable to spawn (the external ACP agent server). */
    command: string;
    /** Arguments passed to {@link command}. */
    args: string[];
    /** Absolute working directory for the child process and its ACP sessions. */
    cwd: string;
    /** Extra environment variables merged on top of the scrubbed parent env. */
    env: Record<string, string>;
    /** Grace (ms) for the child's EOF-driven quiesce on dispose. */
    disposeEofGraceMs: number;
    /** Termination-escalation grace (ms) after SIGTERM before SIGKILL. */
    disposeGraceMs: number;
    /** Bound (ms) on the `initialize` handshake plus any keyed `authenticate` round. */
    initTimeoutMs: number;
    /** Bound (ms) on `session/new`, `session/list`, and `session/set_config_option`. */
    sessionTimeoutMs: number;
    /** Bound (ms) on one `authenticate` round, keyed or key-less. */
    authTimeoutMs: number;
    /** Bound (ms) on one key-less interactive `authenticate` round — long enough
     * for the user to complete a browser login, after which the failed session
     * call retries automatically. */
    interactiveAuthTimeoutMs: number;
    /** Spawn function from the subprocess seam (`ctx.subprocess.spawn`). */
    spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle;
    /** Sink for connection-level warnings (wired to `ctx.logger.warn`). */
    onWarn?: (message: string) => void;
    /**
     * Called when the connection is presumed dead: a prompt went idle without
     * answering, or `session/new` timed out (serial servers queue requests
     * behind a dead prompt). The owner uses this hook to rebuild the connection.
     */
    onWedged?: ((reason: string) => void) | undefined;
    /**
     * Notified with the browser login URL when the server publishes it via the
     * `_codebuddy.ai/authUrl` extension notification during an interactive
     * `authenticate` round. Fires at most once per connection — later
     * publishes only refresh the pending URL exposed via
     * {@link getPendingAuthUrl}. The host decides how to surface it (e.g. open
     * the system browser); failures must not affect the connection.
     */
    onAuthUrl?: (url: string) => void;
    /**
     * Resolves the API key to pass to `authenticate` when the ACP server
     * advertises auth methods. Returns `undefined` to skip authentication
     * (the server will reject `session/new` if it requires auth).
     */
    resolveAuthApiKey?: () => Promise<string | undefined>;
    /**
     * The auth method this server should authenticate with, matching one of the
     * ids it advertises in `initialize`. The operator picks it in the ACP
     * Servers settings (`authMethod`) when the server offers more than one; a
     * server that offers exactly one needs no selection. Ownership of this value
     * is configuration, so a change rebuilds the connection rather than being
     * read per round — see the fingerprint in the owning plugin.
     */
    authMethod?: string;
    /**
     * Directory receiving a JSONL dump of every protocol trace event, one line
     * per event, written before the in-memory buffer's collapsing and eviction
     * (so per-chunk arrival times survive). Unset disables the dump. Intended
     * for offline protocol debugging; a write failure warns once and turns the
     * dump off without affecting the connection.
     */
    debugTraceDir?: string | undefined;
}
/**
 * One long-lived ACP client connection backed by a single child server
 * process. The connection is ready after {@link AcpConnection.ready}
 * resolves; dispose runs the full teardown ladder.
 */
export declare class AcpConnection {
    private readonly child;
    private readonly conn;
    private readonly spec;
    private readonly queues;
    private readonly readyPromise;
    private disposed;
    private disposal;
    /** Session lifecycle capabilities advertised by the agent. */
    private sessionCapabilities;
    /** Whether the agent advertised the `loadSession` capability at initialize. */
    private loadSessionAdvertised;
    /** Sessions with a `session/load` in flight; their replayed history updates are dropped silently. */
    private readonly loadingSessions;
    /** Agent name/version published in the `initialize` response (`agentInfo`). */
    private agentInfo;
    /** Negotiated ACP protocol version from the `initialize` response. */
    private protocolVersion;
    /** Auth methods advertised in the `initialize` response. */
    private authMethods;
    /**
     * The connection's single `authenticate` round — the eager keyed attempt
     * during `initialize`, or the lazy key-less attempt started on the first
     * `session/new` failure. Set at most once; a second round
     * cannot succeed where the first did not.
     */
    private authRound;
    /**
     * Browser login URL published via the `_codebuddy.ai/authUrl` extension
     * notification while an interactive `authenticate` round is in flight.
     * Captured so a key-less auth timeout can tell the user where to log in.
     */
    private pendingAuthUrl;
    /** Set once {@link onAuthUrl} has fired — one browser open per connection. */
    private authUrlNotified;
    /** Auth method id of the in-flight key-less round, if any. */
    private interactiveAuthMethodId;
    /**
     * Set once an authentication attempt has been **blocked** because the server
     * advertises several methods and none is selected. Latched only by an actual
     * blocked attempt, never merely by the shape of the method list: a server
     * whose cached login still works must not ask the user to choose.
     */
    private authChoiceBlocked;
    /**
     * Fingerprint of the last "choose an auth method" warning, so a repeated
     * blocked attempt does not repeat the same line on every turn. Cleared when
     * the condition changes (a different selection, or a different method list).
     */
    private authChoiceWarnedKey;
    /**
     * Agent ids of subagents seen on this connection, learned from the
     * `subagent_context` marker on the calls they make. A subagent's own
     * lifecycle arrives as bare `tool_call_update`s naming that id with no
     * preceding `tool_call`, so this set is what tells such an update apart from
     * one for a tool call that was never announced.
     */
    private readonly subagentIds;
    private cachedConfigOptions;
    private configOptionsProbe;
    /**
     * Total context window in tokens as reported by the newest `usage_update`
     * sample, across every session on this connection. The capacity belongs to
     * the model behind the server rather than to one session, so it survives the
     * session that published it (including the throwaway discovery probe
     * session) and is exposed to the adapter as this route's model context.
     */
    private reportedContextWindow;
    /** Ring buffer of recent ACP protocol interactions (max {@link MAX_PROTOCOL_TRACE}). */
    private readonly protocolTrace;
    /** Dump file resolved on the first trace event when {@link AcpConnectionSpec.debugTraceDir} is set. */
    private debugTraceFile;
    /** Set once the dump is unusable, so a failed directory or write is not retried per event. */
    private debugTraceOff;
    constructor(spec: AcpConnectionSpec);
    /** Resolves when the ACP server has completed `initialize`. */
    get ready(): Promise<void>;
    private initialize;
    /** Whether the agent advertises `session/list` via sessionCapabilities. */
    get supportsListSessions(): boolean;
    /** Whether the agent advertises `session/delete` via sessionCapabilities. */
    get supportsDeleteSession(): boolean;
    /** Whether the agent advertises the `loadSession` capability. */
    get canLoadSession(): boolean;
    /**
     * Attach this connection to a session created by an earlier connection
     * (typically a previous harness run whose child process is gone). The agent
     * restores its conversation history and replays it as `session/update`
     * notifications; while the load is in flight those replays are dropped
     * silently — the adapter's own history is authoritative and the next prompt
     * sends only the delta. Returns `false` when the agent does not advertise
     * `loadSession` or the load fails (unknown/deleted session), so the caller
     * falls back to a fresh session.
     * @param sessionId - the remote session id to reattach to.
     */
    loadSession(sessionId: string): Promise<boolean>;
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
    getServerInfo(): {
        agentName: string;
        agentVersion: string;
        protocolVersion: number;
        agentInfoMissing: boolean;
    } | undefined;
    /**
     * The browser login URL most recently published via the
     * `_codebuddy.ai/authUrl` extension notification, or `undefined` when no
     * interactive login is pending. The settings UI surfaces it as a clickable
     * link so a headless host can still complete the browser login.
     */
    getPendingAuthUrl(): string | undefined;
    /**
     * Total context window (tokens) the server reported in its newest
     * `usage_update` sample, or `undefined` before it reports one. A server
     * counts this as the capacity of the model behind it, so it is exempt from
     * session lifecycle: it outlives the session that published it and is read
     * by the adapter as the route's model context capacity.
     */
    getContextWindow(): number | undefined;
    /**
     * The auth method id of an in-flight key-less interactive round, or
     * `undefined` when no round is running. Lets callers surface "waiting for
     * interactive login" even before (or without) an auth URL.
     */
    getPendingAuthMethod(): string | undefined;
    /**
     * The advertised auth methods plus the operator's selection, for the ACP
     * Servers picker. `needed` is true only once an authentication attempt was
     * actually blocked for want of a selection — a server that offers several
     * methods but logs in from a cached credential must not be nagged.
     * @returns the method catalog (empty before `initialize`), the configured
     *   method id (`''` when unset), and whether the user must choose.
     */
    authMethodState(): AcpAuthMethodState;
    /**
     * Begin an interactive authenticate round when the server advertises auth
     * methods — a no-op otherwise. Waits for `initialize` first so the
     * advertised method list is populated; failures surface through `onWarn`.
     */
    requestInteractiveAuth(): void;
    /**
     * Recent ACP protocol interactions (ring buffer, {@link MAX_PROTOCOL_TRACE} entries). The
     * protocol inspector view polls this to show what the server is doing.
     * @returns a snapshot copy of the trace buffer.
     */
    getProtocolTrace(): readonly ProtocolTraceEntry[];
    /**
     * Append one event to the debug dump ({@link AcpConnectionSpec.debugTraceDir}),
     * opening the file on first use so an idle connection creates nothing. The
     * line carries the untruncated detail because the dump exists to be read
     * offline, where the in-memory buffer's caps only get in the way. Writes are
     * synchronous so a line is on disk even if the process dies mid-stream — a
     * cost accepted only because the dump is opt-in. A failed open or write
     * disables the dump after one warning.
     */
    private writeDebugTrace;
    /** Append one trace entry, evicting the oldest when the buffer is full.
     * Consecutive entries sharing `collapseKey` merge into one with a `count`
     * so per-token stream chunks do not flood the buffer. */
    private traceEvent;
    /**
     * Eager `authenticate` round, run during `initialize` only when the server
     * advertises auth methods AND a configured API key resolves. The key rides
     * as `_meta.api_key` for servers that accept direct key authentication.
     * Without a key no `authenticate` call is made: servers that accept env
     * credentials or a cached login go straight to `session/new`, and servers
     * that truly require an interactive round reach it lazily through
     * {@link ensureAuthenticated} on the first failed `session/new` — so a
     * well-configured server never triggers a browser login it did not need.
     *
     * The method is resolved by {@link resolveAuthMethod} like the lazy path, so
     * a server offering several methods is never guessed at here either: an
     * unresolved choice leaves this a no-op and `initialize` succeeds, keeping
     * the connection usable for model discovery and the method picker.
     */
    private authenticateWithKey;
    /**
     * The connection's single key-less `authenticate` round, started lazily by
     * {@link withAuthRetry} when `session/new` fails on a server
     * that advertised auth methods. Servers with cached credentials (e.g.
     * codebuddy) resolve the call immediately — and only then accept
     * `session/new`. The round is bounded and best-effort: on timeout or error
     * the connection stays usable, and a browser login URL published via the
     * `_codebuddy.ai/authUrl` extension notification is surfaced in the
     * warning so the user can complete an interactive login.
     *
     * A server offering several methods with none selected **starts no round at
     * all**: guessing picks a flow the operator did not choose (codebuddy's
     * intranet-only `iOA` hangs an off-network host for the whole interactive
     * window), so the choice is deferred to the UI and the caller is told no
     * round ran.
     * @returns whether an `authenticate` round actually ran.
     */
    private ensureAuthenticated;
    /**
     * Latch the "the server offers several auth methods and none is selected"
     * state and warn once per distinct condition. Called only from an attempt
     * that was actually blocked, so a server whose cached login still works
     * never reaches it; the warning repeats only when the selection or the
     * advertised method list changes, so a failing turn does not spam the log.
     */
    private noteAuthChoiceBlocked;
    /**
     * Run one session operation bounded by `sessionTimeoutMs`. On failure —
     * once, and only while no `authenticate` round has run yet and the server
     * advertised auth methods — run {@link ensureAuthenticated} and retry.
     * This is the lazy-auth path: servers that accept env credentials or a
     * cached login never see an `authenticate` call at all.
     */
    private withAuthRetry;
    /** Why the connection cannot authenticate on its own, for an error message. */
    private authChoiceRejection;
    /** Resolve one ACP permission request through its owning session. */
    private requestPermission;
    /** Select an advertised rejection option, or cancel when none is available. */
    private rejectPermission;
    /** Push an inbound session/update into the owning session's queue. */
    private enqueueUpdate;
    /**
     * Arm or clear the idle watchdog from an update's `agentPhase` marker. Every
     * update kind is inspected, not just content: a server may attach the marker
     * to a non-content update (a usage sample, a mode change), and an `idle`
     * phase there means the same thing. Unknown sessions are no-ops — the
     * watchdog guards a prompt drain, so it only exists alongside one.
     */
    private trackAgentPhase;
    /**
     * Handle extension notifications from ACP servers that use non-standard
     * protocols (e.g. Devin's `_cognition.ai/*` notifications). These are
     * silently consumed to prevent SDK error logs, with progress notifications
     * surfaced to keep the user informed during long operations.
     */
    private handleExtNotification;
    /**
     * Handle extension requests from ACP servers. Currently no extension
     * requests are expected; return an empty object to satisfy the protocol.
     */
    private handleExtMethod;
    /** Wake a consumer waiting on an empty queue. */
    private signal;
    /** Drain the queue for one session, awaiting new updates when it is empty. */
    private drainQueue;
    /**
     * Create a fresh ACP session for one prompt. The session is removed from the
     * connection's queue map after the generator completes or is abandoned.
     * @returns the remote session id.
     */
    newSession(): Promise<string>;
    /**
     * List existing ACP sessions (`session/list`). Only available when the agent
     * advertises the `session/list` capability. Returns `undefined` when the
     * agent does not support listing.
     * @param cursor - optional pagination cursor from a previous response.
     * @returns the session list and optional next cursor, or `undefined`.
     */
    listSessions(cursor?: string): Promise<{
        sessions: SessionInfo[];
        nextCursor?: string;
    } | undefined>;
    /**
     * Delete an ACP session (`session/delete`). Only available when the agent
     * advertises the `session/delete` capability. Best-effort: errors are
     * swallowed because the session may already be gone.
     * @param sessionId - the remote session id to delete.
     * @returns `true` if the session was deleted, `false` if unsupported or failed.
     */
    deleteSession(sessionId: string): Promise<boolean>;
    /**
     * Probe the ACP server for its model catalog by creating a throwaway session
     * and reading the `configOptions` (category `model`) from the `session/new`
     * response. The probe session is closed immediately. Returns `undefined` when
     * the server publishes no model config option.
     * @returns the model entries, or `undefined` if none were advertised.
     */
    discoverModels(): Promise<readonly {
        id: string;
        name: string;
    }[] | undefined>;
    /**
     * Probe the ACP server for its full config option catalog by creating a
     * throwaway session and reading `configOptions` from the `session/new`
     * response. The probe session is closed immediately. Returns `undefined`
     * when the server publishes no config options.
     * @returns all config options (models, modes, thought levels, etc.).
     */
    discoverConfigOptions(): Promise<readonly SessionConfigOption[] | undefined>;
    /** Single config-option probe: one throwaway session, closed immediately. */
    private probeConfigOptions;
    /**
     * List the session modes this server advertises via the `mode` config
     * option (category `mode`, type `select`), e.g. Devin's
     * `accept-edits`/`bypass`. `undefined` when the server publishes no mode
     * selector or the config-option probe is unsupported.
     */
    discoverModes(): Promise<{
        id: string;
        name: string;
    }[] | undefined>;
    /** Extract model entries from a config option list (category `model`, type `select`). */
    private extractModels;
    /** Collect the leaf `{value, name}` pairs of one select config option by
     * category. Handles both flat option lists and grouped option lists per the
     * ACP `SessionConfigSelectOptions` union: a group entry carries its own
     * `options` array of leaf values, so flatten one level before collecting. */
    private extractSelectValues;
    /**
     * Set the model for one ACP session via `session/set_config_option`. Best-effort:
     * if the server rejects the config id or value, the error surfaces from the
     * caller. Only called when the model differs from the server's current value.
     * @param sessionId - the remote session id from {@link AcpConnection.newSession}.
     * @param modelId - the model value id to select.
     */
    setSessionModel(sessionId: string, modelId: string): Promise<void>;
    /**
     * Switch the ACP session's mode (e.g. `bypass` on agents that publish a
     * `mode` config option). Prefers the unified `session/set_config_option`
     * write and falls back to the legacy `session/set_mode` when the config
     * option is unknown to the server.
     * @param sessionId - the remote session id from {@link AcpConnection.newSession}.
     * @param modeId - the mode value id to select.
     */
    setSessionMode(sessionId: string, modeId: string): Promise<void>;
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
    promptStream(sessionId: string, prompt: AcpContentBlock[], signal: AbortSignal, permissionRequester?: AcpPermissionRequester, subagentNotice?: AcpSubagentNotice): AsyncGenerator<QueuedUpdate>;
    /**
     * Close one ACP session after a prompt completes. Best-effort: errors are
     * swallowed because the session may already be gone.
     * @param sessionId - the remote session id to close.
     */
    closeSession(sessionId: string): void;
    /** Best-effort cancel of one in-flight session; unknown ids are no-ops. */
    cancel(sessionId: string): void;
    /** Idempotent disposal: runs the teardown ladder once and resolves at quiescence. */
    dispose(): Promise<void>;
}
export {};
//# sourceMappingURL=connection.d.ts.map