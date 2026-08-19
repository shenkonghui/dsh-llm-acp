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
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, } from '@agentclientprotocol/sdk';
/** EOF grace for child flush and nested-process teardown; wider than the signal grace. */
export const DEFAULT_DISPOSE_EOF_GRACE_MS = 6_000;
/** Default POSIX grace between SIGTERM and SIGKILL on dispose. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000;
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
/** Extract text from an ACP content block (non-text blocks contribute nothing). */
function acpContentText(content) {
    return content.type === 'text' ? content.text : '';
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
                if (spec.permission === 'allow') {
                    const allow = params.options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always');
                    if (allow !== undefined) {
                        return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } });
                    }
                }
                return Promise.resolve({ outcome: { outcome: 'cancelled' } });
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
        this.readyPromise = this.initialize();
    }
    /** Resolves when the ACP server has completed `initialize`. */
    get ready() {
        return this.readyPromise;
    }
    async initialize() {
        const spawnFailed = this.child.done.then(() => new Promise(() => { }), (err) => Promise.reject(err instanceof Error ? err : new Error(String(err))));
        spawnFailed.catch(() => { });
        await Promise.race([
            this.conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
            spawnFailed,
        ]);
    }
    /** Push an inbound session/update into the owning session's queue. */
    enqueueUpdate(params) {
        const entry = this.queues.get(params.sessionId);
        if (entry === undefined)
            return;
        const update = params.update;
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
        this.signal(entry);
    }
    /**
     * Handle extension notifications from ACP servers that use non-standard
     * protocols (e.g. Devin's `_cognition.ai/*` notifications). These are
     * silently consumed to prevent SDK error logs, with progress notifications
     * surfaced to keep the user informed during long operations.
     */
    handleExtNotification(method, params) {
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
        // Unknown extension notifications are silently consumed.
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
        const session = await this.conn.newSession({ cwd: this.spec.cwd, mcpServers: [] });
        const returnedId = Reflect.get(session, 'sessionId');
        if (typeof returnedId !== 'string') {
            throw new Error('llm-acp: ACP server published a session without a string sessionId');
        }
        return returnedId;
    }
    /**
     * Probe the ACP server for its model catalog by creating a throwaway session
     * and reading the `configOptions` (category `model`) from the `session/new`
     * response. The probe session is closed immediately. Returns `undefined` when
     * the server publishes no model config option.
     * @returns the model entries, or `undefined` if none were advertised.
     */
    async discoverModels() {
        await this.ready;
        const session = await this.conn.newSession({ cwd: this.spec.cwd, mcpServers: [] });
        const configOptions = Reflect.get(session, 'configOptions');
        const sessionId = Reflect.get(session, 'sessionId');
        if (typeof sessionId === 'string') {
            void this.conn.closeSession({ sessionId }).catch(() => { });
        }
        if (configOptions === undefined || configOptions === null)
            return undefined;
        const modelOption = configOptions.find(opt => opt.category === 'model' && opt.type === 'select');
        if (modelOption === undefined || modelOption.type !== 'select')
            return undefined;
        const options = Array.isArray(modelOption.options) ? modelOption.options : [];
        const models = [];
        for (const opt of options) {
            if ('value' in opt && typeof opt.value === 'string' && typeof opt.name === 'string') {
                models.push({ id: opt.value, name: opt.name });
            }
        }
        return models.length > 0 ? models : undefined;
    }
    /**
     * Set the model for one ACP session via `session/set_config_option`. Best-effort:
     * if the server rejects the config id or value, the error surfaces from the
     * caller. Only called when the model differs from the server's current value.
     * @param sessionId - the remote session id from {@link AcpConnection.newSession}.
     * @param modelId - the model value id to select.
     */
    async setSessionModel(sessionId, modelId) {
        await this.conn.setSessionConfigOption({ sessionId, configId: 'model', value: modelId });
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
     */
    async *promptStream(sessionId, prompt, signal) {
        const entry = { queue: [], resolve: undefined };
        this.queues.set(sessionId, entry);
        const onAbort = () => {
            void this.conn.cancel({ sessionId }).catch(() => { });
        };
        signal.addEventListener('abort', onAbort, { once: true });
        const settled = this.conn.prompt({ sessionId, prompt }).then((result) => {
            const stopReason = Reflect.get(result, 'stopReason');
            entry.queue.push({ kind: 'done', reason: stopReason ?? 'end_turn' });
            this.signal(entry);
        }, (err) => {
            const error = err instanceof Error ? err : new Error(String(err));
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