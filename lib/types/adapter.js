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
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { acpFinishReason } from "./types.js";
/** Extract the concatenated text of a harness message (non-text blocks contribute nothing). */
function messageText(message) {
    return message.content
        .filter((block) => block.type === 'text')
        .map(block => block.text)
        .join('\n');
}
/**
 * Lead-in markers of the DSH-composed context messages. The harness sends its
 * system-prompt preamble, runtime-context snapshots, and the skills catalog as
 * non-assistant messages (observed as `system` role; `renderPrompt` renders
 * every non-assistant role as `[user]` on the wire); an external ACP agent
 * assembles its own equivalents, so these are stripped unless the corresponding
 * include switch is on.
 * ponytail: ceiling — detection is by lead-in marker, not a structured flag;
 * if dsh rewords them or bundles the preamble into a message that also carries
 * real user content, stripping silently stops (or must be switched off via the
 * settings toggles). Upgrade path: a structured message flag from the harness.
 */
const HARNESS_PREAMBLE_RE = /^You are an AI agent powered by DeepSeek Harness\./;
const RUNTIME_CONTEXT_RE = /^Current runtime context\./;
const SKILLS_REMINDER_RE = /^<system-reminder>/;
/** Whether one conversation message is a DSH addition the ACP agent should not
 * receive, given the two include switches. Assistant messages are never
 * stripped; the preamble may arrive as either a `user` or a `system` role
 * message (both render as `[user]` on the ACP wire). */
export function isDshAddition(message, includeHarnessPrompt, includeRuntimeContext) {
    if (message.role === 'assistant')
        return false;
    const text = messageText(message);
    if (!includeHarnessPrompt && HARNESS_PREAMBLE_RE.test(text))
        return true;
    if (!includeRuntimeContext && (RUNTIME_CONTEXT_RE.test(text) || SKILLS_REMINDER_RE.test(text)))
        return true;
    return false;
}
/** Render the full conversation (system + all messages) into one ACP text block.
 * User messages carry no marker: the whole ACP prompt IS a user message, so a
 * `[user]` prefix would only be stored as literal text in the agent's history.
 * Assistant turns keep a marker so multi-turn full renders stay attributable. */
function renderPrompt(options, includeHarnessPrompt, includeRuntimeContext) {
    const parts = [];
    if (includeHarnessPrompt && options.system !== undefined && options.system.length > 0) {
        parts.push(`[system]\n${options.system}`);
    }
    for (const message of options.messages) {
        if (isDshAddition(message, includeHarnessPrompt, includeRuntimeContext))
            continue;
        const text = messageText(message);
        if (text.length === 0)
            continue;
        parts.push(message.role === 'assistant' ? `[assistant]\n${text}` : text);
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
function renderPromptDelta(messages, fromIndex, includeHarnessPrompt, includeRuntimeContext) {
    const parts = [];
    for (const message of messages.slice(fromIndex)) {
        if (message.role === 'assistant')
            continue;
        if (isDshAddition(message, includeHarnessPrompt, includeRuntimeContext))
            continue;
        const text = messageText(message);
        if (text.length > 0)
            parts.push(text);
    }
    if (parts.length === 0)
        return [{ type: 'text', text: '' }];
    return [{ type: 'text', text: parts.join('\n\n') }];
}
/** Lead-in of the harness's session-title prompt; see {@link sessionTitleFromMessages}. */
const TITLE_PROMPT_MARKER = 'Generate the session title';
/** Longest extracted title before truncation. */
const MAX_TITLE_LENGTH = 60;
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
export function sessionTitleFromMessages(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message === undefined || message.role !== 'user')
            continue;
        const text = messageText(message);
        if (!text.includes(TITLE_PROMPT_MARKER))
            continue;
        const start = text.indexOf('[');
        const end = text.lastIndexOf(']');
        if (start === -1 || end <= start)
            return undefined;
        let entries;
        try {
            entries = JSON.parse(text.slice(start, end + 1));
        }
        catch {
            return undefined;
        }
        for (const entry of entries) {
            if (typeof entry?.text === 'string' && entry.text.trim().length > 0) {
                const title = entry.text.replace(/\s+/g, ' ').trim();
                return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
            }
        }
        return undefined;
    }
    return undefined;
}
/**
 * Durable `dshSessionId → ReusedSession` map backing the in-memory
 * {@link AcpAdapter.sessionMap} across harness restarts. One JSON file per
 * ACP server; every mutation rewrites the file (small, infrequent). All
 * operations are no-ops when no path was configured, and every read failure
 * (missing/corrupt file) degrades to an empty map — the store is an
 * optimization over the fresh-session fallback, never a correctness source.
 */
export class SessionStore {
    path;
    /** Lazily parsed file contents; `undefined` until the first access. */
    cache;
    constructor(path) {
        this.path = path;
    }
    load() {
        if (this.cache === undefined) {
            this.cache = {};
            if (this.path !== undefined && existsSync(this.path)) {
                try {
                    this.cache = this.parse(readFileSync(this.path, 'utf8'));
                }
                catch {
                    // A corrupt file degrades to an empty map; the next successful
                    // write overwrites it.
                }
            }
        }
        return this.cache;
    }
    parse(raw) {
        const parsed = JSON.parse(raw);
        // Shape-check every entry: a corrupt or hand-edited file degrades to a
        // fresh session rather than feeding a malformed id into session/load.
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value?.acpSessionId !== 'string' || value.acpSessionId.length === 0
                || typeof value?.messagesSent !== 'number' || !Number.isInteger(value.messagesSent)
                || value.messagesSent < 0) {
                delete parsed[key];
            }
        }
        return parsed;
    }
    get(dshSessionId) {
        if (this.path === undefined)
            return undefined;
        return this.load()[dshSessionId];
    }
    set(dshSessionId, entry) {
        if (this.path === undefined)
            return;
        this.load()[dshSessionId] = entry;
        this.flush();
    }
    delete(dshSessionId) {
        if (this.path === undefined)
            return;
        if (this.cache === undefined && !existsSync(this.path))
            return;
        if (this.load()[dshSessionId] === undefined)
            return;
        delete this.load()[dshSessionId];
        this.flush();
    }
    /** Host sink for store write failures; optional so tests can stay quiet. */
    onWriteError;
    flush() {
        if (this.path === undefined || this.cache === undefined)
            return;
        try {
            mkdirSync(dirname(this.path), { recursive: true });
            writeFileSync(this.path, JSON.stringify(this.cache, undefined, 2));
        }
        catch (error) {
            // Persistence is best-effort: a failed write degrades to in-memory-only
            // reuse (fresh session after restart), never to a broken prompt.
            this.onWriteError?.(`llm-acp: failed to persist the ACP session map: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
/** Deduplicate model entries by id, keeping the first occurrence (highest priority). */
function dedupModels(models) {
    const seen = new Set();
    const result = [];
    for (const m of models) {
        if (seen.has(m.id))
            continue;
        seen.add(m.id);
        result.push(m);
    }
    return result;
}
/** Merge custom models into a discovered catalog: custom entries override
 * matching ids' display names and append unique ids. */
function mergeCustomModels(discovered, custom, provider) {
    const customMap = new Map();
    for (const m of custom) {
        customMap.set(m.id, m.name.length > 0 ? m.name : m.id);
    }
    const result = discovered.map(m => {
        const customName = customMap.get(m.id);
        return customName !== undefined ? { ...m, name: customName } : m;
    });
    for (const [id, name] of customMap) {
        if (!discovered.some(m => m.id === id)) {
            result.push({ provider, id, name });
        }
    }
    return result;
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
    /** Reused ACP sessions keyed by dsh session id. */
    sessionMap = new Map();
    /** Durable backing of {@link AcpAdapter.sessionMap} across restarts (no-op without a path). */
    sessionStore;
    /** Last session-mode value applied per ACP session id, to skip redundant writes. */
    appliedMode = new Map();
    constructor(config) {
        super();
        this.config = config;
        this.sessionStore = new SessionStore(config.sessionStorePath);
        this.sessionStore.onWriteError = message => config.onWarn?.(message);
        const fallback = [{ provider: config.provider, id: config.defaultModel.id, name: config.defaultModel.name }];
        const allow = config.enabledModels;
        const custom = config.customModels ?? [];
        const customEntries = custom.map(m => ({ provider: config.provider, id: m.id, name: m.name.length > 0 ? m.name : m.id }));
        // Before discovery: start with custom models plus the fallback (when not
        // filtered out by enabledModels). This gives immediate model visibility
        // even when the ACP server is still initializing.
        let initial = [...customEntries];
        if (!(allow !== undefined && allow.length > 0 && !allow.includes(config.defaultModel.id))) {
            initial = [...initial, ...fallback];
        }
        // Dedup by id: custom models take priority over the fallback placeholder.
        this.models = dedupModels(initial);
        this.modelsReady = this.discoverModels();
    }
    /** Probe the ACP server for its model catalog and cache the result. */
    async discoverModels() {
        try {
            const discovered = await this.config.connection.discoverModels();
            if (discovered !== undefined && discovered.length > 0) {
                const all = discovered.map(m => ({ provider: this.config.provider, id: m.id, name: m.name }));
                const allow = this.config.enabledModels;
                const filtered = allow !== undefined && allow.length > 0
                    ? all.filter(m => allow.includes(m.id))
                    : all;
                // Merge custom models: override names for matching ids, append unique ids.
                this.models = mergeCustomModels(filtered, this.config.customModels ?? [], this.config.provider);
            }
        }
        catch {
            // Keep the fallback + custom model list; discovery is best-effort.
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
        // Advertise the context capacity the server reported through
        // `usage_update`. It is only known once the server has sampled a session
        // (or its discovery probe), so a first turn may run without a capacity and
        // a later request supplies it — the harness re-records `request/context`
        // whenever this value changes.
        const contextWindow = this.config.connection.getContextWindow();
        return {
            provider,
            id: model,
            name: found?.name ?? model,
            ...contextWindow === undefined ? {} : { context: { contextWindow } },
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
    async *stream(options) {
        // A session-title call is a pure string extraction: the prompt already
        // carries the human messages as JSON, and an ACP round-trip would spend a
        // full agent session (its own system prompt and model run) on reformatting
        // it. Answer locally when the prompt matches the expected shape; an
        // unmatched prompt falls through to the normal model path below.
        if (options.purpose === 'session-title') {
            const title = sessionTitleFromMessages(options.messages);
            if (title !== undefined) {
                yield { type: 'block-start', index: 0, blockType: 'text' };
                yield { type: 'text-delta', index: 0, text: title };
                yield { type: 'block-end', index: 0, block: { type: 'text', text: title } };
                yield { type: 'finish', reason: { kind: 'stop' } };
                return;
            }
        }
        const permissionRequester = this.config.permissionRequester?.();
        const subagentNotice = this.config.subagentNotice?.() ?? 'notice';
        // The calling session's workspace becomes the ACP session's cwd; without
        // an initiator (probes, one-shot calls) the connection's spawn cwd stands.
        const sessionCwd = this.config.resolveSessionCwd?.();
        try {
            await this.config.connection.ready;
        }
        catch (error) {
            yield {
                type: 'finish',
                reason: {
                    kind: 'error',
                    failure: {
                        code: 'ACP_INIT_FAILED',
                        message: `llm-acp: ACP server failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
                    },
                },
            };
            return;
        }
        const canReuse = options.sessionId !== undefined
            && options.purpose === undefined;
        const dshSessionId = canReuse ? String(options.sessionId) : undefined;
        let existing = dshSessionId !== undefined ? this.sessionMap.get(dshSessionId) : undefined;
        // The mapping is durable but not memory-resident: after a harness restart
        // (or a connection rebuild) the store still knows the ACP session id, and
        // a successful `session/load` reattaches to it — the agent restores its
        // history and the turn continues with only the delta. A failed load
        // (unknown/deleted session, no capability) falls through to a fresh
        // session and the stale store entry is dropped.
        if (existing === undefined && dshSessionId !== undefined) {
            const stored = this.sessionStore.get(dshSessionId);
            if (stored !== undefined && await this.config.connection.loadSession(stored.acpSessionId, sessionCwd)) {
                this.sessionMap.set(dshSessionId, stored);
                existing = stored;
            }
            else {
                this.sessionStore.delete(dshSessionId);
            }
        }
        // Reuse the mapped ACP session when one exists and the history did not
        // shrink (compaction): the server keeps the session's context between
        // prompts, so only the delta is sent. A server that dropped the session
        // fails the prompt; the error path deletes the mapping and the next turn
        // rebuilds from full history.
        let sessionId;
        let prompt;
        let isReused = false;
        // Read the include switches per stream so a settings edit applies to the
        // next prompt without rebuilding the connection. Stripping only affects
        // what is rendered — `messagesSent` bookkeeping stays on the raw array,
        // and the filter is deterministic per message, so the stripped arrays
        // keep a shared prefix across turns and delta indexing stays consistent.
        const includeHarnessPrompt = this.config.includeHarnessPrompt?.() ?? false;
        const includeRuntimeContext = this.config.includeRuntimeContext?.() ?? false;
        if (existing !== undefined && options.messages.length >= existing.messagesSent) {
            sessionId = existing.acpSessionId;
            prompt = renderPromptDelta(options.messages, existing.messagesSent, includeHarnessPrompt, includeRuntimeContext);
            isReused = true;
        }
        else {
            // No existing mapping or history shrank (compaction): create fresh.
            if (existing !== undefined && dshSessionId !== undefined) {
                this.sessionMap.delete(dshSessionId);
            }
            sessionId = await this.createSession(options, sessionCwd);
            prompt = renderPrompt(options, includeHarnessPrompt, includeRuntimeContext);
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
        // Apply the configured session-mode mapping (e.g. full-access dsh session
        // → ACP `bypass` mode). Read per stream so a mid-session preset switch
        // reaches the next prompt; skipped when the mode is already applied.
        const targetMode = this.config.resolveSessionMode?.();
        if (targetMode !== undefined && this.appliedMode.get(sessionId) !== targetMode) {
            try {
                await this.config.connection.setSessionMode(sessionId, targetMode);
                this.appliedMode.set(sessionId, targetMode);
            }
            catch (error) {
                // Best-effort: a server without mode support keeps its own default.
                this.appliedMode.set(sessionId, targetMode);
                this.config.onWarn?.(`llm-acp: failed to set ACP session mode "${targetMode}": ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        const emitReasoning = this.config.emitReasoning;
        // Context accounting is reported for conversation turns only. An auxiliary
        // call (compaction, session-title) renders a purpose-built prompt into a
        // throwaway session, so its occupancy describes that request rather than
        // the conversation — and, being the newest sample, it would displace the
        // real one in the harness's context-pressure fold.
        const reportUsage = options.purpose === undefined;
        // Tool recording likewise belongs to conversation turns: an auxiliary
        // call's ACP-side tool runs must not write `tool/call` pairs into the
        // calling session's transcript. A factory failure degrades to the
        // reasoning fallback rather than failing the stream over a
        // presentational record.
        let toolCallRecorder;
        if (options.purpose === undefined) {
            try {
                toolCallRecorder = this.config.toolCallRecorder?.();
            }
            catch (error) {
                this.config.onWarn?.(`llm-acp: tool call recorder unavailable: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        /** Call ids reported to the recorder but not yet finished. */
        const pendingToolCalls = new Set();
        let streamErrored = false;
        const finishPendingToolCalls = (isError) => {
            if (toolCallRecorder === undefined)
                return;
            for (const id of pendingToolCalls) {
                toolCallRecorder.callFinished({ id, output: '', isError });
            }
            pendingToolCalls.clear();
        };
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
            for await (const update of this.config.connection.promptStream(sessionId, prompt, signal, permissionRequester, subagentNotice)) {
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
                        if (this.config.emitProgress !== true || update.text.length === 0)
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
                    case 'usage': {
                        // The ACP server reports the tokens currently in ITS context along
                        // with the window they occupy. That figure is the prompt side of
                        // the request (ACP never splits out response tokens), so it maps to
                        // `inputTokens` and feeds the harness's context-occupancy display;
                        // `outputTokens` is unavailable from ACP and reported as 0.
                        if (reportUsage) {
                            yield { type: 'usage', usage: { inputTokens: update.used, outputTokens: 0 } };
                        }
                        break;
                    }
                    case 'tool': {
                        // Which tool the ACP server ran. With a recorder it lands in the
                        // session log as `tool/call` (tool cards); without one it degrades
                        // to a reasoning note — on by default: it is the answer to "what
                        // is it doing", and unlike `progress` (extension log text such as
                        // MCP server chatter) it is low-volume and structured.
                        if (toolCallRecorder !== undefined) {
                            toolCallRecorder.callStarted({ id: update.id, name: update.name, args: update.args, subagent: update.subagent, toolKind: update.toolKind });
                            pendingToolCalls.add(update.id);
                        }
                        else if (this.config.emitToolCalls !== false) {
                            if (open === undefined || open.type !== 'reasoning') {
                                yield* closeOpen();
                                open = { type: 'reasoning', index: nextIndex++, text: '' };
                                yield { type: 'block-start', index: open.index, blockType: 'reasoning' };
                            }
                            const note = `[${update.subagent ? 'subagent tool' : 'tool'}: ${update.name}]\n`;
                            open.text += note;
                            yield { type: 'reasoning-delta', index: open.index, text: note };
                        }
                        break;
                    }
                    case 'tool-end': {
                        // `tool-end` for an id never seen is dropped — the consumer owns
                        // the open-call set. A call the stream abandons is closed by
                        // `finishPendingToolCalls` instead of staying open in the log.
                        if (pendingToolCalls.delete(update.id)) {
                            toolCallRecorder?.callFinished({ id: update.id, output: update.output, isError: update.status === 'failed' });
                        }
                        break;
                    }
                    case 'notice': {
                        // Agent-side events the connection already decided are worth
                        // surfacing (subagent spawn/finish, mapped from the session's
                        // permission state). Unlike `progress` these are not gated by
                        // `emitProgress`: the mapping is the gate, and a subagent fan-out
                        // is a cost event rather than ordinary tool chatter.
                        if (update.text.length === 0)
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
                            const entry = { acpSessionId: sessionId, messagesSent: options.messages.length };
                            this.sessionMap.set(dshSessionId, entry);
                            this.sessionStore.set(dshSessionId, entry);
                        }
                        yield {
                            type: 'finish',
                            reason: acpFinishReason(update.reason, { code: 'ACP_STOP', message: `ACP stop reason: ${update.reason}` }),
                        };
                        return;
                    }
                    case 'error': {
                        yield* closeOpen();
                        streamErrored = true;
                        // Drop the mapping on error so the next turn creates a fresh session.
                        if (isReused && dshSessionId !== undefined) {
                            this.sessionMap.delete(dshSessionId);
                            this.sessionStore.delete(dshSessionId);
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
            streamErrored = true;
            if (isReused && dshSessionId !== undefined) {
                this.sessionMap.delete(dshSessionId);
                this.sessionStore.delete(dshSessionId);
            }
            throw new LlmError(`llm-acp: stream failed: ${error instanceof Error ? error.message : String(error)}`, 'SERVER');
        }
        finally {
            // Calls still open when the stream ends (prompt finished mid-call, abort,
            // failure) get a `tool/result` so the log never holds a dangling
            // `tool/call`; errored streams mark them failed, clean ends completed.
            finishPendingToolCalls(streamErrored);
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
            this.sessionStore.delete(dshSessionId);
        }
        yield {
            type: 'finish',
            reason: { kind: 'error', failure: { code: 'ACP_EOF', message: 'ACP stream ended without a stop reason' } },
        };
    }
    /** Create a fresh ACP session, throwing `LlmError` on failure. */
    async createSession(_options, cwd) {
        try {
            return await this.config.connection.newSession(cwd);
        }
        catch (error) {
            throw new LlmError(`llm-acp: failed to create ACP session: ${error instanceof Error ? error.message : String(error)}`, 'NO_ADAPTER');
        }
    }
    /**
     * Drop the in-memory reuse mappings. The ACP sessions themselves are left
     * alive: the durable store keeps their ids, so a later turn (same run after
     * a connection rebuild, or a future harness run) reattaches via
     * `session/load` instead of starting over. Called when the adapter's
     * connection is disposed.
     */
    disposeSessions() {
        this.sessionMap.clear();
    }
}
//# sourceMappingURL=adapter.js.map