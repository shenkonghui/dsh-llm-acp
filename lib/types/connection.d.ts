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
import { type ContentBlock as AcpContentBlock, type SessionConfigOption, type SessionInfo, type StopReason } from '@agentclientprotocol/sdk';
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
/** EOF grace for child flush and nested-process teardown; wider than the signal grace. */
export declare const DEFAULT_DISPOSE_EOF_GRACE_MS = 6000;
/** Default POSIX grace between SIGTERM and SIGKILL on dispose. */
export declare const DEFAULT_DISPOSE_GRACE_MS = 3000;
/** Default bound on the `initialize` handshake plus any keyed `authenticate` round. */
export declare const DEFAULT_INIT_TIMEOUT_MS = 120000;
/** Default bound on `session/new`, `session/load`, and `session/set_config_option`. */
export declare const DEFAULT_SESSION_TIMEOUT_MS = 60000;
/** Default bound on one `authenticate` round, keyed or key-less. */
export declare const DEFAULT_AUTH_TIMEOUT_MS = 15000;
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
} | {
    kind: 'done';
    reason: StopReason;
} | {
    kind: 'error';
    error: Error;
};
/** Decision returned by an interactive ACP permission requester. */
export type AcpPermissionDecision = 'allow' | 'reject' | 'cancel';
/** Permission details forwarded from an ACP server to an interactive requester. */
export interface AcpPermissionRequest {
    title: string;
    signal: AbortSignal;
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
    /** Bound (ms) on `session/new`, `session/load`, and `session/set_config_option`. */
    sessionTimeoutMs: number;
    /** Bound (ms) on one `authenticate` round, keyed or key-less. */
    authTimeoutMs: number;
    /** Spawn function from the subprocess seam (`ctx.subprocess.spawn`). */
    spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle;
    /** Sink for connection-level warnings (wired to `ctx.logger.warn`). */
    onWarn?: (message: string) => void;
    /**
     * Notified with the browser login URL when the server publishes it via the
     * `_codebuddy.ai/authUrl` extension notification during an interactive
     * `authenticate` round. The host decides how to surface it (e.g. open the
     * system browser); failures must not affect the connection.
     */
    onAuthUrl?: (url: string) => void;
    /**
     * Resolves the API key to pass to `authenticate` when the ACP server
     * advertises auth methods. Returns `undefined` to skip authentication
     * (the server will reject `session/new` if it requires auth).
     */
    resolveAuthApiKey?: () => Promise<string | undefined>;
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
    /** Capabilities advertised by the agent in its `initialize` response. */
    private agentCapabilities;
    /** Session lifecycle capabilities advertised by the agent. */
    private sessionCapabilities;
    /** Agent name/version published in the `initialize` response (`agentInfo`). */
    private agentInfo;
    /** Negotiated ACP protocol version from the `initialize` response. */
    private protocolVersion;
    /** Auth methods advertised in the `initialize` response. */
    private authMethods;
    /**
     * The connection's single `authenticate` round — the eager keyed attempt
     * during `initialize`, or the lazy key-less attempt started on the first
     * `session/new`/`session/load` failure. Set at most once; a second round
     * cannot succeed where the first did not.
     */
    private authRound;
    /**
     * Browser login URL published via the `_codebuddy.ai/authUrl` extension
     * notification while an interactive `authenticate` round is in flight.
     * Captured so a key-less auth timeout can tell the user where to log in.
     */
    private pendingAuthUrl;
    constructor(spec: AcpConnectionSpec);
    /** Resolves when the ACP server has completed `initialize`. */
    get ready(): Promise<void>;
    private initialize;
    /** Whether the agent advertises `session/load` (session reuse). */
    get supportsLoadSession(): boolean;
    /** Whether the agent advertises `session/list` via sessionCapabilities. */
    get supportsListSessions(): boolean;
    /** Whether the agent advertises `session/delete` via sessionCapabilities. */
    get supportsDeleteSession(): boolean;
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
    private authenticateWithKey;
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
    private ensureAuthenticated;
    /**
     * Run one session operation bounded by `sessionTimeoutMs`. On failure —
     * once, and only while no `authenticate` round has run yet and the server
     * advertised auth methods — run {@link ensureAuthenticated} and retry.
     * This is the lazy-auth path: servers that accept env credentials or a
     * cached login never see an `authenticate` call at all.
     */
    private withAuthRetry;
    /** Resolve one ACP permission request through its owning session. */
    private requestPermission;
    /** Select an advertised rejection option, or cancel when none is available. */
    private rejectPermission;
    /** Push an inbound session/update into the owning session's queue. */
    private enqueueUpdate;
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
     * Load an existing ACP session by id (`session/load`). Only available when
     * the agent advertises the `loadSession` capability. Returns the session's
     * current config options (models, modes, etc.) if the server publishes them.
     * @param sessionId - the remote session id to resume.
     * @returns the config options published by the server, or `undefined`.
     */
    loadSession(sessionId: string): Promise<SessionConfigOption[] | undefined>;
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
    /** Extract model entries from a config option list (category `model`, type `select`).
     * Handles both flat option lists and grouped option lists per the ACP
     * `SessionConfigSelectOptions` union: a group entry carries its own
     * `options` array of leaf values, so flatten one level before collecting. */
    private extractModels;
    /**
     * Set the model for one ACP session via `session/set_config_option`. Best-effort:
     * if the server rejects the config id or value, the error surfaces from the
     * caller. Only called when the model differs from the server's current value.
     * @param sessionId - the remote session id from {@link AcpConnection.newSession}.
     * @param modelId - the model value id to select.
     */
    setSessionModel(sessionId: string, modelId: string): Promise<void>;
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
    promptStream(sessionId: string, prompt: AcpContentBlock[], signal: AbortSignal, permissionRequester?: AcpPermissionRequester): AsyncGenerator<QueuedUpdate>;
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