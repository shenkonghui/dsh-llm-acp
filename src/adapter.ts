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

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk'
import type { Message } from '@deepseek-ai/dsh-llm'
import { AcpConnection } from './connection.ts'
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
}

/** Render the harness message history plus system prompt into one ACP text block. */
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

/** Extract the concatenated text of a harness message (non-text blocks contribute nothing). */
function messageText(message: Message): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Tracks one open streaming block so `block-end` carries the assembled text. */
interface OpenBlock {
  type: 'text' | 'reasoning'
  index: number
  text: string
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

  constructor(private readonly config: AcpAdapterOptions) {
    super()
    this.models = [{ provider: config.provider, id: config.defaultModel.id, name: config.defaultModel.name }]
    this.modelsReady = this.discoverModels()
  }

  /** Probe the ACP server for its model catalog and cache the result. */
  private async discoverModels(): Promise<void> {
    try {
      const discovered = await this.config.connection.discoverModels()
      if (discovered !== undefined && discovered.length > 0) {
        this.models = discovered.map(m => ({ provider: this.config.provider, id: m.id, name: m.name }))
      }
    } catch {
      // Keep the fallback model list; discovery is best-effort.
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

  /**
   * Stream one model call by opening a fresh ACP session and sending the full
   * conversation as one user message. Yields `text-delta` (and optionally
   * `reasoning-delta`) chunks as the ACP server streams assistant output, then
   * a terminal `finish` chunk. Tool-call deltas are never emitted.
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await this.config.connection.ready
    let sessionId: string
    try {
      sessionId = await this.config.connection.newSession()
    } catch (error: unknown) {
      throw new LlmError(
        `llm-acp: failed to create ACP session: ${error instanceof Error ? error.message : String(error)}`,
        'NO_ADAPTER',
      )
    }
    // Set the model on the ACP session when a specific model is selected.
    // Best-effort: if the server rejects the value, the prompt still proceeds
    // with the server's default model.
    if (options.model.length > 0 && options.model !== this.config.defaultModel.id) {
      try {
        await this.config.connection.setSessionModel(sessionId, options.model)
      } catch {
        // Model selection is best-effort; continue with the server default.
      }
    }
    const prompt = renderPrompt(options)
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
      for await (const update of this.config.connection.promptStream(sessionId, prompt, signal)) {
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
          case 'done': {
            yield* closeOpen()
            yield {
              type: 'finish',
              reason: acpFinishReason(update.reason, { code: 'ACP_STOP', message: `ACP stop reason: ${update.reason}` }),
            }
            return
          }
          case 'error': {
            yield* closeOpen()
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
      throw new LlmError(
        `llm-acp: stream failed: ${error instanceof Error ? error.message : String(error)}`,
        'SERVER',
      )
    }
    // The generator ended without a terminal update (e.g. the queue was disposed).
    yield* closeOpen()
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'ACP_EOF', message: 'ACP stream ended without a stop reason' } },
    }
  }
}
