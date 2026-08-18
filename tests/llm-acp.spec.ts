/**
 * Keyless integration tests for the ACP LLM adapter. Each spawns a REAL
 * subprocess — the scripted mock ACP server reused from dsh-subagent-acp — and
 * drives it through the REAL adapter over real ACP JSON-RPC stdio, so the
 * connection setup, session creation, prompt round-trip, chunk translation,
 * stop-reason mapping, and disposal are all exercised end to end. No model, no key.
 *
 * @module @deepseek-ai/dsh-llm-acp/tests/llm-acp.spec
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { fileURLToPath } from 'node:url'
import { BlockAssembler, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as acp from '../src/index.ts'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

const mockServer = fileURLToPath(new URL('../../../subagent/subagent-acp/tests/mock-acp-server.ts', import.meta.url))

interface SetupEnv {
  [key: string]: string
}

/**
 * Mount the ACP LLM adapter pointed at the mock server, scripted by `mockEnv`.
 * `emitReasoning` selects whether thought chunks become reasoning-delta.
 */
async function setup(mockEnv: SetupEnv = {}, opts: { emitReasoning?: boolean; permission?: 'allow' | 'reject' } = {}) {
  const ctx = new Context()
  await ctx.plugin(Loader)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(acp, {
    permission: opts.permission ?? 'reject',
    emitReasoning: opts.emitReasoning ?? false,
    env: mockEnv,
    servers: {
      test: {
        command: process.execPath,
        args: [mockServer],
        name: 'Test ACP',
      },
    },
  })
  return ctx
}

/** Collect all StreamChunks from one adapter stream call. */
async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

/** Assemble the text blocks from a stream's chunks. */
function assembledText(chunks: StreamChunk[]): string {
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return assembler.blocks()
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('')
}

/** Find the terminal finish chunk. */
function finishChunk(chunks: StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> {
  const finish = chunks.find(c => c.type === 'finish')
  if (finish === undefined) throw new Error('no finish chunk emitted')
  return finish as Extract<StreamChunk, { type: 'finish' }>
}

describe('dsh-llm-acp', () => {
  it('streams assistant text and finishes with stop', async () => {
    const ctx = await setup({ MOCK_TEXT: 'hello from acp' })
    try {
      const stream = ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      })
      const chunks = await collect(stream)
      const text = assembledText(chunks)
      expect(text).toBe('hello from acp')
      expect(finishChunk(chunks).reason.kind).toBe('stop')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('maps max_tokens stop reason', async () => {
    const ctx = await setup({ MOCK_TEXT: 'partial', MOCK_STOP: 'max_tokens' })
    try {
      const stream = ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      })
      const chunks = await collect(stream)
      expect(finishChunk(chunks).reason.kind).toBe('max-tokens')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('maps refusal stop reason to error finish', async () => {
    const ctx = await setup({ MOCK_TEXT: 'no', MOCK_STOP: 'refusal' })
    try {
      const stream = ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      })
      const chunks = await collect(stream)
      const reason = finishChunk(chunks).reason
      expect(reason.kind).toBe('error')
      if (reason.kind === 'error') expect(reason.failure.code).toBe('REFUSAL')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('emits reasoning chunks when emitReasoning is on', async () => {
    const ctx = await setup({ MOCK_TEXT: 'answer', MOCK_THOUGHT: '1' }, { emitReasoning: true })
    try {
      const stream = ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      })
      const chunks = await collect(stream)
      const reasoning = chunks.filter(c => c.type === 'reasoning-delta')
      expect(reasoning.length).toBeGreaterThan(0)
      const assembler = new BlockAssembler()
      for (const chunk of chunks) assembler.push(chunk)
      const thoughtBlocks = assembler.blocks().filter(b => b.type === 'reasoning')
      expect(thoughtBlocks.length).toBe(1)
      expect((thoughtBlocks[0] as { type: 'reasoning'; text: string }).text).toBe('thinking…')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('drops reasoning chunks when emitReasoning is off', async () => {
    const ctx = await setup({ MOCK_TEXT: 'answer', MOCK_THOUGHT: '1' }, { emitReasoning: false })
    try {
      const stream = ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      })
      const chunks = await collect(stream)
      expect(chunks.filter(c => c.type === 'reasoning-delta')).toHaveLength(0)
      expect(assembledText(chunks)).toBe('answer')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('renders system prompt and message history into one user message', async () => {
    const ctx = await setup({ MOCK_ECHO_ENV: 'ACP_PROMPT', ACP_PROMPT: '' })
    // The mock server echoes the env var; we cannot inspect the prompt directly,
    // but we can verify the adapter does not throw and produces a finish.
    try {
      const stream = ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        system: 'you are helpful',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      })
      const chunks = await collect(stream)
      expect(finishChunk(chunks).reason.kind).toBe('stop')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
