/**
 * Long-lived ACP client connection: spawns one external ACP server subprocess
 * at plugin load and drives it over JSON-RPC stdio. Each {@link AcpConnection.promptStream}
 * call creates a fresh ACP session, sends one user message, and yields the
 * streamed assistant text/reasoning chunks plus a terminal stop reason.
 *
 * The connection is deliberately stateless across prompts (no session reuse):
 * every prompt creates a new ACP session and sends the full conversation as a
 * single user message. This avoids cross-prompt state synchronization with the
 * remote agent and stays safe under compaction/fork, at the cost of remote KV
 * cache reuse.
 *
 * @module @deepseek-ai/dsh-llm-acp/connection
 */
import { type ContentBlock as AcpContentBlock, type StopReason } from '@agentclientprotocol/sdk';
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import type { PermissionPolicy } from './types.ts';
/** EOF grace for child flush and nested-process teardown; wider than the signal grace. */
export declare const DEFAULT_DISPOSE_EOF_GRACE_MS = 6000;
/** Default POSIX grace between SIGTERM and SIGKILL on dispose. */
export declare const DEFAULT_DISPOSE_GRACE_MS = 3000;
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
    /** How to auto-answer the child's permission prompts. */
    permission: PermissionPolicy;
    /** Extra environment variables merged on top of the scrubbed parent env. */
    env: Record<string, string>;
    /** Grace (ms) for the child's EOF-driven quiesce on dispose. */
    disposeEofGraceMs: number;
    /** Termination-escalation grace (ms) after SIGTERM before SIGKILL. */
    disposeGraceMs: number;
    /** Spawn function from the subprocess seam (`ctx.subprocess.spawn`). */
    spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle;
    /** Sink for connection-level warnings (wired to `ctx.logger.warn`). */
    onWarn?: (message: string) => void;
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
    constructor(spec: AcpConnectionSpec);
    /** Resolves when the ACP server has completed `initialize`. */
    get ready(): Promise<void>;
    private initialize;
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
     */
    promptStream(sessionId: string, prompt: AcpContentBlock[], signal: AbortSignal): AsyncGenerator<QueuedUpdate>;
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