/**
 * `AcpAdapter`: an {@link LlmAdapter} that delegates each model call to a
 * long-lived external ACP server. One `stream()` call creates a fresh ACP
 * session, sends the full conversation as a single user message, and translates
 * the streamed `agent_message_chunk` / `agent_thought_chunk` updates into
 * harness `StreamChunk`s. Tool-call deltas are never emitted: the ACP server
 * executes its own tools internally and does not expose tool-call argument
 * deltas to the client, so the harness agent loop sees a single tool-less
 * assistant step per turn.
 *
 * @module @deepseek-ai/dsh-llm-acp/adapter
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { AcpConnection } from './connection.ts';
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
    /**
     * Stream one model call by opening a fresh ACP session and sending the full
     * conversation as one user message. Yields `text-delta` (and optionally
     * `reasoning-delta`) chunks as the ACP server streams assistant output, then
     * a terminal `finish` chunk. Tool-call deltas are never emitted.
     *
     * After the stream completes, the ACP session is closed best-effort to
     * avoid resource leaks on the server side.
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
//# sourceMappingURL=adapter.d.ts.map