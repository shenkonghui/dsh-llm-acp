/**
 * `AcpAdapter`: an {@link LlmAdapter} that delegates each model call to a
 * long-lived external ACP server. Subsequent turns within the same dsh session
 * reuse the live ACP session and send only the new user message — the ACP
 * server keeps each session's context and conversation history between
 * prompts, so resending history would duplicate what it already holds. A
 * fresh session is created only when no reuse mapping exists (first turn,
 * one-shot calls) or the history shrank (compaction); one-shot sessions are
 * closed after the prompt.
 *
 * `agent_message_chunk` / `agent_thought_chunk` updates are translated into
 * harness `StreamChunk`s; `usage_update` becomes a `usage` chunk carrying the
 * server's context occupancy on the prompt side. Tool calls are never emitted
 * as `tool-call` stream blocks: the agent loop dispatches such blocks to the
 * harness's own tool registry, but the ACP server already executed them — the
 * host would run them twice or fail on an unknown tool. When the caller
 * supplies a {@link AcpToolCallRecorder} they are logged as `tool/call` +
 * `tool/result` session events instead, which is what renders them as tool
 * cards; without one they degrade to `[tool: …]` reasoning notes.
 *
 * @module @deepseek-ai/dsh-llm-acp/adapter
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Message } from '@deepseek-ai/dsh-llm';
import { AcpConnection } from './connection.ts';
import type { AcpPermissionRequester, AcpSubagentNotice } from './connection.ts';
/**
 * Records ACP-observed tool activity into the calling session's durable log
 * (`tool/call` on start, `tool/result` on terminal status). Implementations
 * are host-owned: the adapter never sees the session itself, it only reports
 * what the wire carried. A call that never reaches {@link callFinished} is
 * closed by the adapter at stream end with `output: ''`.
 */
export interface AcpToolCallRecorder {
    /**
     * One tool call began on the ACP side. `subagent` marks a call made inside
     * a subagent; `toolKind` is the ACP tool kind (`read`/`edit`/`execute`/…),
     * `''` when the server omitted it — the host maps it onto a native tool
     * name so the call renders with the matching row family.
     */
    callStarted(call: {
        id: string;
        name: string;
        args: string;
        subagent: boolean;
        toolKind: string;
    }): void;
    /** A previously started call reached a terminal status. */
    callFinished(result: {
        id: string;
        output: string;
        isError: boolean;
    }): void;
}
/** Constructor options for {@link AcpAdapter}. */
export interface AcpAdapterOptions {
    /** The long-lived ACP client connection; ready after `connection.ready` resolves. */
    connection: AcpConnection;
    /** Provider route name this adapter is registered under. */
    provider: string;
    /** Whether to translate `agent_thought_chunk` into `reasoning-delta` chunks. */
    emitReasoning: boolean;
    /** Whether to surface extension progress text (e.g. `_cognition.ai/output`,
     * `[tool: …]` notes) as reasoning blocks. Off by default: these carry
     * server log noise rather than model thinking. */
    emitProgress?: boolean;
    /** Model id to fall back to when ACP model discovery returns nothing. */
    defaultModel: {
        id: string;
        name: string;
    };
    /**
     * Model ids to expose from the discovered catalog. When omitted or empty,
     * every discovered model is exposed. When non-empty, only the listed models
     * (intersected with the discovered set) appear in `listModels`.
     */
    enabledModels?: readonly string[] | undefined;
    /**
     * User-defined models to expose in addition to the discovered catalog.
     * Each entry has an `id` (sent to the ACP server as the model name) and a
     * `name` (display label). Custom models with the same id as a discovered
     * model override its display name; custom models with unique ids are added.
     */
    customModels?: readonly {
        id: string;
        name: string;
    }[] | undefined;
    /** Capture an interactive permission requester from the current agent turn. */
    permissionRequester?: (() => AcpPermissionRequester | undefined) | undefined;
    /**
     * Resolve the ACP session mode to apply before this stream's prompt (e.g.
     * `bypass`), read from the calling session's current permission state.
     * Called once per stream; `undefined` leaves the server mode untouched.
     */
    resolveSessionMode?: (() => string | undefined) | undefined;
    /**
     * Whether to surface ACP-side subagent activity for this stream. Resolved
     * once per stream, like {@link AcpAdapterOptions.resolveSessionMode}, because
     * it is read from the calling session's permission state — which is only
     * reachable on the adapter's async context, not on the connection's inbound
     * notification path. `undefined` means `notice`.
     */
    subagentNotice?: (() => AcpSubagentNotice) | undefined;
    /**
     * Whether to surface which tool the ACP server ran. Defaults to on — it
     * answers "what is it doing" — and is separate from
     * {@link AcpAdapterOptions.emitProgress}, which carries extension log
     * chatter rather than structured activity. With a {@link toolCallRecorder}
     * the calls land in the session log as `tool/call`/`tool/result` pairs
     * (tool cards); without one they degrade to `[tool: …]` reasoning notes.
     */
    emitToolCalls?: boolean;
    /**
     * Whether to include the DSH harness system-prompt additions in the prompt:
     * the `system` slot plus the harness preamble user message ("You are an AI
     * agent powered by DeepSeek Harness. …"). Read per stream from the live
     * settings; default `false` — ACP agents assemble their own system prompt,
     * so the harness copy is duplicate context that would otherwise persist in
     * the agent's history and be resent on every turn.
     */
    includeHarnessPrompt?: (() => boolean) | undefined;
    /**
     * Whether to include the DSH runtime-context snapshots and the skills
     * `<system-reminder>` catalog in the prompt (default `false`). These are
     * DSH-specific concepts (DSH file policy, DSH skill tool) that an external
     * ACP agent cannot act on.
     */
    includeRuntimeContext?: (() => boolean) | undefined;
    /**
     * Resolve a recorder that turns ACP-observed tool calls into session
     * `tool/call`/`tool/result` events. Called once per stream on the adapter's
     * async context — where the calling agent's session is reachable — and
     * returns `undefined` when the call runs outside a session step (test
     * probes, auxiliary purposes), in which case tool activity falls back to
     * `[tool: …]` reasoning notes.
     */
    toolCallRecorder?: (() => AcpToolCallRecorder | undefined) | undefined;
    /** Host sink for best-effort operation failures (session mode, etc.). */
    onWarn?: (message: string) => void;
    /**
     * Path of the JSON file persisting the `dshSessionId → acpSessionId` map
     * across harness restarts. When set, a turn whose in-memory mapping is gone
     * (harness restart, connection rebuild) reattaches to the persisted ACP
     * session via `session/load` instead of creating a fresh one; the file is
     * rewritten on every mapping change. `undefined` disables persistence.
     */
    sessionStorePath?: string | undefined;
}
/** Whether one conversation message is a DSH addition the ACP agent should not
 * receive, given the two include switches. Assistant messages are never
 * stripped; the preamble may arrive as either a `user` or a `system` role
 * message (both render as `[user]` on the ACP wire). */
export declare function isDshAddition(message: Message, includeHarnessPrompt: boolean, includeRuntimeContext: boolean): boolean;
/**
 * Extract the session title directly from the harness's title-generation
 * prompt instead of spending an ACP session + model round on reformatting
 * text the prompt already carries. The prompt embeds the human messages as a
 * JSON array (`[{"seq":8,"text":"1 +1 =?"}]`); the first entry names the
 * session topic. Returns `undefined` when the prompt does not match the
 * expected shape, so the caller falls back to the normal model path rather
 * than ever deriving a wrong title.
 * ponytail: ceiling — couples to the harness's title-prompt wording and JSON
 * shape; a reworded prompt degrades to the model round-trip, never to a wrong
 * title. Upgrade path: a structured title-request field on GenerateOptions.
 */
export declare function sessionTitleFromMessages(messages: readonly Message[]): string | undefined;
/** One reused ACP session: remote id + how many dsh messages have been sent. */
interface ReusedSession {
    acpSessionId: string;
    messagesSent: number;
}
/**
 * Durable `dshSessionId → ReusedSession` map backing the in-memory
 * {@link AcpAdapter.sessionMap} across harness restarts. One JSON file per
 * ACP server; every mutation rewrites the file (small, infrequent). All
 * operations are no-ops when no path was configured, and every read failure
 * (missing/corrupt file) degrades to an empty map — the store is an
 * optimization over the fresh-session fallback, never a correctness source.
 */
export declare class SessionStore {
    private readonly path;
    /** Lazily parsed file contents; `undefined` until the first access. */
    private cache;
    constructor(path: string | undefined);
    private load;
    private parse;
    get(dshSessionId: string): ReusedSession | undefined;
    set(dshSessionId: string, entry: ReusedSession): void;
    delete(dshSessionId: string): void;
    /** Host sink for store write failures; optional so tests can stay quiet. */
    onWriteError?: (message: string) => void;
    private flush;
}
/**
 * The ACP-backed LLM adapter. One instance serves every model name under its
 * registered provider route. The model catalog is discovered once from the
 * ACP server's `session/new` config options at construction time; when a
 * specific model is selected, `stream()` sets it on the ACP session before
 * prompting.
 */
export declare class AcpAdapter extends LlmAdapter {
    private readonly config;
    /** Discovered model catalog; populated after {@link modelsReady} resolves. */
    private models;
    /** Resolves when the model discovery probe finishes (success or fallback). */
    private readonly modelsReady;
    /** Reused ACP sessions keyed by dsh session id. */
    private readonly sessionMap;
    /** Durable backing of {@link AcpAdapter.sessionMap} across restarts (no-op without a path). */
    private readonly sessionStore;
    /** Last session-mode value applied per ACP session id, to skip redundant writes. */
    private readonly appliedMode;
    constructor(config: AcpAdapterOptions);
    /** Probe the ACP server for its model catalog and cache the result. */
    private discoverModels;
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * Advertise the model catalog discovered from the ACP server's session config
     * options. Falls back to a single placeholder entry when the server publishes
     * no model config option.
     */
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall>;
    /**
     * Stream one model call. When the request carries a dsh `sessionId`, the
     * ACP session is reused across turns: the server keeps each session's
     * context between prompts, so only the new user message is sent. A mapping
     * lost in memory (harness restart, connection rebuild) is restored from the
     * durable store via `session/load` when the agent supports it. Without any
     * mapping (first turn, one-shot calls) or when the history shrank
     * (compaction), a fresh ACP session is created with the full conversation
     * and closed after the prompt.
     *
     * Yields `text-delta` (and optionally `reasoning-delta`) chunks as the ACP
     * server streams assistant output, a `usage` chunk whenever the server
     * reports context occupancy, then a terminal `finish` chunk.
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /** Create a fresh ACP session, throwing `LlmError` on failure. */
    private createSession;
    /**
     * Drop the in-memory reuse mappings. The ACP sessions themselves are left
     * alive: the durable store keeps their ids, so a later turn (same run after
     * a connection rebuild, or a future harness run) reattaches via
     * `session/load` instead of starting over. Called when the adapter's
     * connection is disposed.
     */
    disposeSessions(): void;
}
export {};
//# sourceMappingURL=adapter.d.ts.map