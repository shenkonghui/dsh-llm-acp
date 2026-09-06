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
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { acpFinishReason } from "./types.js";
/** Extract the concatenated text of a harness message (non-text blocks contribute nothing). */
function messageText(message) {
    return message.content
        .filter((block) => block.type === 'text')
        .map(block => block.text)
        .join('\n');
}
/** Render the full conversation (system + all messages) into one ACP text block. */
function renderPrompt(options) {
    const parts = [];
    if (options.system !== undefined && options.system.length > 0) {
        parts.push(`[system]\n${options.system}`);
    }
    for (const message of options.messages) {
        const role = message.role === 'assistant' ? 'assistant' : 'user';
        const text = messageText(message);
        if (text.length > 0)
            parts.push(`[${role}]\n${text}`);
    }
    return [{ type: 'text', text: parts.join('\n\n') }];
}
/**
 * Render only new user messages since `fromIndex` as one ACP text block.
 * Assistant messages are skipped: the ACP server already has its own responses
 * in context. Used for session-reuse prompts where only the delta is sent.
 * ponytail: ceiling — assumes messages[fromIndex:] contains at most one new
 * user turn; multiple unsent user turns would be concatenated into one prompt.
 */
function renderPromptDelta(messages, fromIndex) {
    const parts = [];
    for (const message of messages.slice(fromIndex)) {
        if (message.role === 'assistant')
            continue;
        const text = messageText(message);
        if (text.length > 0)
            parts.push(`[user]\n${text}`);
    }
    if (parts.length === 0)
        return [{ type: 'text', text: '' }];
    return [{ type: 'text', text: parts.join('\n\n') }];
}
/**
 * The ACP-backed LLM adapter. One instance serves every model name under its
 * registered provider route. The model catalog is discovered once from the
 * ACP server's `session/new` config options at construction time; when a
 * specific model is selected, `stream()` sets it on the ACP session before
 * prompting.
 */
export class AcpAdapter extends LlmAdapter {
    config;
    /** Discovered model catalog; populated after {@link modelsReady} resolves. */
    models = [];
    /** Resolves when the model discovery probe finishes (success or fallback). */
    modelsReady;
    /** Reused ACP sessions keyed by dsh session id (only when `loadSession` is supported). */
    sessionMap = new Map();
    constructor(config) {
        super();
        this.config = config;
        const fallback = [{ provider: config.provider, id: config.defaultModel.id, name: config.defaultModel.name }];
        const allow = config.enabledModels;
        this.models = allow !== undefined && allow.length > 0 && !allow.includes(config.defaultModel.id)
            ? []
            : fallback;
        this.modelsReady = this.discoverModels();
    }
    /** Probe the ACP server for its model catalog and cache the result. */
    async discoverModels() {
        try {
            const discovered = await this.config.connection.discoverModels();
            if (discovered !== undefined && discovered.length > 0) {
                const all = discovered.map(m => ({ provider: this.config.provider, id: m.id, name: m.name }));
                const allow = this.config.enabledModels;
                this.models = allow !== undefined && allow.length > 0
                    ? all.filter(m => allow.includes(m.id))
                    : all;
            }
        }
        catch {
            // Keep the fallback model list; discovery is best-effort.
        }
    }
    providerInfo(provider) {
        return { id: provider, name: provider };
    }
    /**
     * Advertise the model catalog discovered from the ACP server's session config
     * options. Falls back to a single placeholder entry when the server publishes
     * no model config option.
     */
    async listModels(provider) {
        await this.modelsReady;
        return this.models.map(m => ({ ...m, provider }));
    }
    async resolveModel(provider, model) {
        await this.modelsReady;
        const found = this.models.find(m => m.id === model);
        return {
            provider,
            id: model,
            name: found?.name ?? model,
        };
    }
    async prepareCall(provider, model, _signal) {
        const resolved = await this.resolveModel(provider, model);
        return {
            model: resolved,
            stream: (options) => this.stream(options),
        };
    }
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
    async *stream(options) {
        const permissionRequester = this.config.permissionRequester?.();
        await this.config.connection.ready;
        const canReuse = this.config.connection.supportsLoadSession
            && options.sessionId !== undefined
            && options.purpose === undefined;
        const dshSessionId = canReuse ? String(options.sessionId) : undefined;
        const existing = dshSessionId !== undefined ? this.sessionMap.get(dshSessionId) : undefined;
        // Determine whether we can reuse an existing ACP session.
        // Fall back to a fresh session when: compaction shrank the history, the
        // session mapping is stale, or loadSession fails.
        let sessionId;
        let prompt;
        let isReused = false;
        if (existing !== undefined && options.messages.length >= existing.messagesSent) {
            try {
                await this.config.connection.loadSession(existing.acpSessionId);
                sessionId = existing.acpSessionId;
                prompt = renderPromptDelta(options.messages, existing.messagesSent);
                isReused = true;
            }
            catch {
                // Session gone (server restart, eviction): drop mapping, create fresh.
                this.sessionMap.delete(dshSessionId);
                sessionId = await this.createSession(options);
                prompt = renderPrompt(options);
            }
        }
        else {
            // No existing mapping or history shrank (compaction): create fresh.
            if (existing !== undefined && dshSessionId !== undefined) {
                this.sessionMap.delete(dshSessionId);
            }
            sessionId = await this.createSession(options);
            prompt = renderPrompt(options);
        }
        // Set the model on the ACP session when a specific model is selected.
        // Best-effort: if the server rejects the value, the prompt still proceeds
        // with the server's default model. On reuse, the session may already have
        // the right model; setting it again is harmless when the value matches.
        if (options.model.length > 0 && options.model !== this.config.defaultModel.id) {
            try {
                await this.config.connection.setSessionModel(sessionId, options.model);
            }
            catch {
                // Model selection is best-effort; continue with the server default.
            }
        }
        const emitReasoning = this.config.emitReasoning;
        let nextIndex = 0;
        let open;
        const signal = options.signal ?? new AbortController().signal;
        const closeOpen = function* () {
            if (open === undefined)
                return;
            yield {
                type: 'block-end',
                index: open.index,
                block: open.type === 'text' ? { type: 'text', text: open.text } : { type: 'reasoning', text: open.text },
            };
            open = undefined;
        };
        try {
            for await (const update of this.config.connection.promptStream(sessionId, prompt, signal, permissionRequester)) {
                switch (update.kind) {
                    case 'text': {
                        if (update.text.length === 0)
                            break;
                        if (open === undefined || open.type !== 'text') {
                            yield* closeOpen();
                            open = { type: 'text', index: nextIndex++, text: '' };
                            yield { type: 'block-start', index: open.index, blockType: 'text' };
                        }
                        open.text += update.text;
                        yield { type: 'text-delta', index: open.index, text: update.text };
                        break;
                    }
                    case 'reasoning': {
                        if (!emitReasoning || update.text.length === 0)
                            break;
                        if (open === undefined || open.type !== 'reasoning') {
                            yield* closeOpen();
                            open = { type: 'reasoning', index: nextIndex++, text: '' };
                            yield { type: 'block-start', index: open.index, blockType: 'reasoning' };
                        }
                        open.text += update.text;
                        yield { type: 'reasoning-delta', index: open.index, text: update.text };
                        break;
                    }
                    case 'progress': {
                        // Extension notifications (e.g. Devin's _cognition.ai/output) that
                        // carry human-readable progress text. Surface as reasoning so the
                        // user sees activity during long operations without model text.
                        if (!emitReasoning || update.text.length === 0)
                            break;
                        if (open === undefined || open.type !== 'reasoning') {
                            yield* closeOpen();
                            open = { type: 'reasoning', index: nextIndex++, text: '' };
                            yield { type: 'block-start', index: open.index, blockType: 'reasoning' };
                        }
                        open.text += update.text + '\n';
                        yield { type: 'reasoning-delta', index: open.index, text: update.text + '\n' };
                        break;
                    }
                    case 'done': {
                        yield* closeOpen();
                        // Track the session for reuse after a successful prompt.
                        if (canReuse) {
                            this.sessionMap.set(dshSessionId, { acpSessionId: sessionId, messagesSent: options.messages.length });
                        }
                        yield {
                            type: 'finish',
                            reason: acpFinishReason(update.reason, { code: 'ACP_STOP', message: `ACP stop reason: ${update.reason}` }),
                        };
                        return;
                    }
                    case 'error': {
                        yield* closeOpen();
                        // Drop the mapping on error so the next turn creates a fresh session.
                        if (isReused && dshSessionId !== undefined) {
                            this.sessionMap.delete(dshSessionId);
                        }
                        yield {
                            type: 'finish',
                            reason: { kind: 'error', failure: { code: 'ACP_ERROR', message: update.error.message } },
                        };
                        return;
                    }
                }
            }
        }
        catch (error) {
            yield* closeOpen();
            if (isReused && dshSessionId !== undefined) {
                this.sessionMap.delete(dshSessionId);
            }
            throw new LlmError(`llm-acp: stream failed: ${error instanceof Error ? error.message : String(error)}`, 'SERVER');
        }
        finally {
            // Close one-shot sessions (no reuse mapping). Reused sessions stay alive
            // for subsequent turns; they are cleaned up by {@link disposeSessions}.
            if (!isReused && !canReuse) {
                this.config.connection.closeSession(sessionId);
            }
        }
        // The generator ended without a terminal update (e.g. the queue was disposed).
        yield* closeOpen();
        if (isReused && dshSessionId !== undefined) {
            this.sessionMap.delete(dshSessionId);
        }
        yield {
            type: 'finish',
            reason: { kind: 'error', failure: { code: 'ACP_EOF', message: 'ACP stream ended without a stop reason' } },
        };
    }
    /** Create a fresh ACP session, throwing `LlmError` on failure. */
    async createSession(_options) {
        try {
            return await this.config.connection.newSession();
        }
        catch (error) {
            throw new LlmError(`llm-acp: failed to create ACP session: ${error instanceof Error ? error.message : String(error)}`, 'NO_ADAPTER');
        }
    }
    /** Close all reused ACP sessions. Called when the adapter's connection is disposed. */
    disposeSessions() {
        for (const { acpSessionId } of this.sessionMap.values()) {
            this.config.connection.closeSession(acpSessionId);
        }
        this.sessionMap.clear();
    }
}
//# sourceMappingURL=adapter.js.map