/**
 * `AcpAdapter`: an {@link LlmAdapter} that delegates each model call to a
 * long-lived external ACP server. When the agent advertises `session/load`,
 * subsequent turns within the same dsh session reuse the ACP session and send
 * only the new user message — avoiding full-history resend. Without
 * `loadSession`, each `stream()` call creates a fresh ACP session, sends the
 * full conversation as a single user message, and closes it after.
 *
 * `agent_message_chunk` / `agent_thought_chunk` updates are translated into
 * harness `StreamChunk`s. Tool-call deltas are never emitted: the ACP server
 * executes its own tools internally.
 *
 * @module @deepseek-ai/dsh-llm-acp/adapter
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm';
import { AcpConnection } from './connection.ts';
import type { AcpPermissionRequester } from './connection.ts';
/** Constructor options for {@link AcpAdapter}. */
export interface AcpAdapterOptions {
    /** The long-lived ACP client connection; ready after `connection.ready` resolves. */
    connection: AcpConnection;
    /** Provider route name this adapter is registered under. */
    provider: string;
    /** Whether to translate `agent_thought_chunk` into `reasoning-delta` chunks. */
    emitReasoning: boolean;
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
    /** Reused ACP sessions keyed by dsh session id (only when `loadSession` is supported). */
    private readonly sessionMap;
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
     * Stream one model call. When the ACP agent supports `session/load` and the
     * request carries a dsh `sessionId`, the ACP session is reused across turns:
     * only new user messages are sent, avoiding full-history resend. Without
     * `loadSession` or for one-shot calls, a fresh ACP session is created with
     * the full conversation and closed after the prompt.
     *
     * Yields `text-delta` (and optionally `reasoning-delta`) chunks as the ACP
     * server streams assistant output, then a terminal `finish` chunk.
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /** Create a fresh ACP session, throwing `LlmError` on failure. */
    private createSession;
    /** Close all reused ACP sessions. Called when the adapter's connection is disposed. */
    disposeSessions(): void;
}
//# sourceMappingURL=adapter.d.ts.map