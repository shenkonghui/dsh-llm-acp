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

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk'
import type { Message } from '@deepseek-ai/dsh-llm'
import { AcpConnection } from './connection.ts'
import type { AcpPermissionRequester } from './connection.ts'
import { acpFinishReason } from './types.ts'

/** Constructor options for {@link AcpAdapter}. */
export interface AcpAdapterOptions {
  /** The long-lived ACP client connection; ready after `connection.ready` resolves. */
  connection: AcpConnection
  /** Provider route name this adapter is registered under. */
  provider: string
  /** Whether to translate `agent_thought_chunk` into `reasoning-delta` chunks. */
  emitReasoning: boolean
  /** Model id to fall back to when ACP model discovery returns nothing. */
  defaultModel: { id: string; name: string }
  /**
   * Model ids to expose from the discovered catalog. When omitted or empty,
   * every discovered model is exposed. When non-empty, only the listed models
   * (intersected with the discovered set) appear in `listModels`.
   */
  enabledModels?: readonly string[] | undefined
  /**
   * User-defined models to expose in addition to the discovered catalog.
   * Each entry has an `id` (sent to the ACP server as the model name) and a
   * `name` (display label). Custom models with the same id as a discovered
   * model override its display name; custom models with unique ids are added.
   */
  customModels?: readonly { id: string; name: string }[] | undefined
  /** Capture an interactive permission requester from the current agent turn. */
  permissionRequester?: (() => AcpPermissionRequester | undefined) | undefined
}

/** Extract the concatenated text of a harness message (non-text blocks contribute nothing). */
function messageText(message: Message): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Render the full conversation (system + all messages) into one ACP text block. */
function renderPrompt(options: GenerateOptions): AcpContentBlock[] {
  const parts: string[] = []
  if (options.system !== undefined && options.system.length > 0) {
    parts.push(`[system]\n${options.system}`)
  }
  for (const message of options.messages) {
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const text = messageText(message)
    if (text.length > 0) parts.push(`[${role}]\n${text}`)
  }
  return [{ type: 'text', text: parts.join('\n\n') }]
}

/**
 * Render only new user messages since `fromIndex` as one ACP text block.
 * Assistant messages are skipped: the ACP server already has its own responses
 * in context. Used for session-reuse prompts where only the delta is sent.
 * ponytail: ceiling — assumes messages[fromIndex:] contains at most one new
 * user turn; multiple unsent user turns would be concatenated into one prompt.
 */
function renderPromptDelta(messages: readonly Message[], fromIndex: number): AcpContentBlock[] {
  const parts: string[] = []
  for (const message of messages.slice(fromIndex)) {
    if (message.role === 'assistant') continue
    const text = messageText(message)
    if (text.length > 0) parts.push(`[user]\n${text}`)
  }
  if (parts.length === 0) return [{ type: 'text', text: '' }]
  return [{ type: 'text', text: parts.join('\n\n') }]
}

/** Tracks one open streaming block so `block-end` carries the assembled text. */
interface OpenBlock {
  type: 'text' | 'reasoning'
  index: number
  text: string
}

/** One reused ACP session: remote id + how many dsh messages have been sent. */
interface ReusedSession {
  acpSessionId: string
  messagesSent: number
}

/** Deduplicate model entries by id, keeping the first occurrence (highest priority). */
function dedupModels(models: readonly LlmModelInfo[]): LlmModelInfo[] {
  const seen = new Set<string>()
  const result: LlmModelInfo[] = []
  for (const m of models) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    result.push(m)
  }
  return result
}

/** Merge custom models into a discovered catalog: custom entries override
 * matching ids' display names and append unique ids. */
function mergeCustomModels(
  discovered: readonly LlmModelInfo[],
  custom: readonly { id: string; name: string }[],
  provider: string,
): LlmModelInfo[] {
  const customMap = new Map<string, string>()
  for (const m of custom) {
    customMap.set(m.id, m.name.length > 0 ? m.name : m.id)
  }
  const result: LlmModelInfo[] = discovered.map(m => {
    const customName = customMap.get(m.id)
    return customName !== undefined ? { ...m, name: customName } : m
  })
  for (const [id, name] of customMap) {
    if (!discovered.some(m => m.id === id)) {
      result.push({ provider, id, name })
    }
  }
  return result
}

/**
 * The ACP-backed LLM adapter. One instance serves every model name under its
 * registered provider route. The model catalog is discovered once from the
 * ACP server's `session/new` config options at construction time; when a
 * specific model is selected, `stream()` sets it on the ACP session before
 * prompting.
 */
export class AcpAdapter extends LlmAdapter {
  /** Discovered model catalog; populated after {@link modelsReady} resolves. */
  private models: readonly LlmModelInfo[] = []
  /** Resolves when the model discovery probe finishes (success or fallback). */
  private readonly modelsReady: Promise<void>
  /** Reused ACP sessions keyed by dsh session id (only when `loadSession` is supported). */
  private readonly sessionMap = new Map<string, ReusedSession>()

  constructor(private readonly config: AcpAdapterOptions) {
    super()
    const fallback = [{ provider: config.provider, id: config.defaultModel.id, name: config.defaultModel.name }]
    const allow = config.enabledModels
    const custom = config.customModels ?? []
    const customEntries = custom.map(m => ({ provider: config.provider, id: m.id, name: m.name.length > 0 ? m.name : m.id }))
    // Before discovery: start with custom models plus the fallback (when not
    // filtered out by enabledModels). This gives immediate model visibility
    // even when the ACP server is still initializing.
    let initial: LlmModelInfo[] = [...customEntries]
    if (!(allow !== undefined && allow.length > 0 && !allow.includes(config.defaultModel.id))) {
      initial = [...initial, ...fallback]
    }
    // Dedup by id: custom models take priority over the fallback placeholder.
    this.models = dedupModels(initial)
    this.modelsReady = this.discoverModels()
  }

  /** Probe the ACP server for its model catalog and cache the result. */
  private async discoverModels(): Promise<void> {
    try {
      const discovered = await this.config.connection.discoverModels()
      if (discovered !== undefined && discovered.length > 0) {
        const all = discovered.map(m => ({ provider: this.config.provider, id: m.id, name: m.name }))
        const allow = this.config.enabledModels
        const filtered = allow !== undefined && allow.length > 0
          ? all.filter(m => allow.includes(m.id))
          : all
        // Merge custom models: override names for matching ids, append unique ids.
        this.models = mergeCustomModels(filtered, this.config.customModels ?? [], this.config.provider)
      }
    } catch {
      // Keep the fallback + custom model list; discovery is best-effort.
    }
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  /**
   * Advertise the model catalog discovered from the ACP server's session config
   * options. Falls back to a single placeholder entry when the server publishes
   * no model config option.
   */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    await this.modelsReady
    return this.models.map(m => ({ ...m, provider }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    await this.modelsReady
    const found = this.models.find(m => m.id === model)
    return {
      provider,
      id: model,
      name: found?.name ?? model,
    }
  }

  override async prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const resolved = await this.resolveModel(provider, model)
    return {
      model: resolved,
      stream: (options: GenerateOptions) => this.stream(options),
    }
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
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const permissionRequester = this.config.permissionRequester?.()
    try {
      await this.config.connection.ready
    } catch (error: unknown) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'ACP_INIT_FAILED',
            message: `llm-acp: ACP server failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
          },
        },
      }
      return
    }

    const canReuse = this.config.connection.supportsLoadSession
      && options.sessionId !== undefined
      && options.purpose === undefined
    const dshSessionId = canReuse ? String(options.sessionId) : undefined
    const existing = dshSessionId !== undefined ? this.sessionMap.get(dshSessionId) : undefined

    // Determine whether we can reuse an existing ACP session.
    // Fall back to a fresh session when: compaction shrank the history, the
    // session mapping is stale, or loadSession fails.
    let sessionId: string
    let prompt: AcpContentBlock[]
    let isReused = false

    if (existing !== undefined && options.messages.length >= existing.messagesSent) {
      try {
        await this.config.connection.loadSession(existing.acpSessionId)
        sessionId = existing.acpSessionId
        prompt = renderPromptDelta(options.messages, existing.messagesSent)
        isReused = true
      } catch {
        // Session gone (server restart, eviction): drop mapping, create fresh.
        this.sessionMap.delete(dshSessionId!)
        sessionId = await this.createSession(options)
        prompt = renderPrompt(options)
      }
    } else {
      // No existing mapping or history shrank (compaction): create fresh.
      if (existing !== undefined && dshSessionId !== undefined) {
        this.sessionMap.delete(dshSessionId)
      }
      sessionId = await this.createSession(options)
      prompt = renderPrompt(options)
    }

    // Set the model on the ACP session when a specific model is selected.
    // Best-effort: if the server rejects the value, the prompt still proceeds
    // with the server's default model. On reuse, the session may already have
    // the right model; setting it again is harmless when the value matches.
    if (options.model.length > 0 && options.model !== this.config.defaultModel.id) {
      try {
        await this.config.connection.setSessionModel(sessionId, options.model)
      } catch {
        // Model selection is best-effort; continue with the server default.
      }
    }

    const emitReasoning = this.config.emitReasoning
    let nextIndex = 0
    let open: OpenBlock | undefined
    const signal = options.signal ?? new AbortController().signal

    const closeOpen = function* (): Generator<StreamChunk> {
      if (open === undefined) return
      yield {
        type: 'block-end',
        index: open.index,
        block: open.type === 'text' ? { type: 'text', text: open.text } : { type: 'reasoning', text: open.text },
      }
      open = undefined
    }

    try {
      for await (const update of this.config.connection.promptStream(sessionId, prompt, signal, permissionRequester)) {
        switch (update.kind) {
          case 'text': {
            if (update.text.length === 0) break
            if (open === undefined || open.type !== 'text') {
              yield* closeOpen()
              open = { type: 'text', index: nextIndex++, text: '' }
              yield { type: 'block-start', index: open.index, blockType: 'text' }
            }
            open.text += update.text
            yield { type: 'text-delta', index: open.index, text: update.text }
            break
          }
          case 'reasoning': {
            if (!emitReasoning || update.text.length === 0) break
            if (open === undefined || open.type !== 'reasoning') {
              yield* closeOpen()
              open = { type: 'reasoning', index: nextIndex++, text: '' }
              yield { type: 'block-start', index: open.index, blockType: 'reasoning' }
            }
            open.text += update.text
            yield { type: 'reasoning-delta', index: open.index, text: update.text }
            break
          }
          case 'progress': {
            // Extension notifications (e.g. Devin's _cognition.ai/output) that
            // carry human-readable progress text. Surface as reasoning so the
            // user sees activity during long operations without model text.
            if (!emitReasoning || update.text.length === 0) break
            if (open === undefined || open.type !== 'reasoning') {
              yield* closeOpen()
              open = { type: 'reasoning', index: nextIndex++, text: '' }
              yield { type: 'block-start', index: open.index, blockType: 'reasoning' }
            }
            open.text += update.text + '\n'
            yield { type: 'reasoning-delta', index: open.index, text: update.text + '\n' }
            break
          }
          case 'done': {
            yield* closeOpen()
            // Track the session for reuse after a successful prompt.
            if (canReuse) {
              this.sessionMap.set(dshSessionId!, { acpSessionId: sessionId, messagesSent: options.messages.length })
            }
            yield {
              type: 'finish',
              reason: acpFinishReason(update.reason, { code: 'ACP_STOP', message: `ACP stop reason: ${update.reason}` }),
            }
            return
          }
          case 'error': {
            yield* closeOpen()
            // Drop the mapping on error so the next turn creates a fresh session.
            if (isReused && dshSessionId !== undefined) {
              this.sessionMap.delete(dshSessionId)
            }
            yield {
              type: 'finish',
              reason: { kind: 'error', failure: { code: 'ACP_ERROR', message: update.error.message } },
            }
            return
          }
        }
      }
    } catch (error: unknown) {
      yield* closeOpen()
      if (isReused && dshSessionId !== undefined) {
        this.sessionMap.delete(dshSessionId)
      }
      throw new LlmError(
        `llm-acp: stream failed: ${error instanceof Error ? error.message : String(error)}`,
        'SERVER',
      )
    } finally {
      // Close one-shot sessions (no reuse mapping). Reused sessions stay alive
      // for subsequent turns; they are cleaned up by {@link disposeSessions}.
      if (!isReused && !canReuse) {
        this.config.connection.closeSession(sessionId)
      }
    }
    // The generator ended without a terminal update (e.g. the queue was disposed).
    yield* closeOpen()
    if (isReused && dshSessionId !== undefined) {
      this.sessionMap.delete(dshSessionId)
    }
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'ACP_EOF', message: 'ACP stream ended without a stop reason' } },
    }
  }

  /** Create a fresh ACP session, throwing `LlmError` on failure. */
  private async createSession(_options: GenerateOptions): Promise<string> {
    try {
      return await this.config.connection.newSession()
    } catch (error: unknown) {
      throw new LlmError(
        `llm-acp: failed to create ACP session: ${error instanceof Error ? error.message : String(error)}`,
        'NO_ADAPTER',
      )
    }
  }

  /** Close all reused ACP sessions. Called when the adapter's connection is disposed. */
  disposeSessions(): void {
    for (const { acpSessionId } of this.sessionMap.values()) {
      this.config.connection.closeSession(acpSessionId)
    }
    this.sessionMap.clear()
  }
}
