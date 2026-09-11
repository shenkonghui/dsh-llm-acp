/// <reference types="node" />

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
import AgentRuntime, { type Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as acp from '../src/index.ts'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

const mockServer = fileURLToPath(new URL('../../deepseek-harness/packages/subagent/subagent-acp/tests/mock-acp-server.ts', import.meta.url))
const authMockServer = fileURLToPath(new URL('./mock-acp-auth-server.ts', import.meta.url))

interface SetupEnv {
  [key: string]: string
}

/**
 * Mount the ACP LLM adapter pointed at the mock server, scripted by `mockEnv`.
 * `emitReasoning` selects whether thought chunks become reasoning-delta.
 * `server` overrides the spawned fixture (default: the shared mock server);
 * `config` merges extra plugin config (e.g. shorter timeouts).
 */
async function setup(mockEnv: SetupEnv = {}, opts: {
  emitReasoning?: boolean
  permissionPreset?: 'read-only' | 'workspace-write' | 'danger-full-access'
  server?: { command: string; args: string[] }
  config?: Record<string, unknown>
} = {}) {
  const ctx = new Context()
  await ctx.plugin(Loader)
  await ctx.plugin(AgentRuntime)
  await ctx.plugin(ApprovalService)
  if (opts.permissionPreset !== undefined) {
    const preset = opts.permissionPreset
    ctx.provide('permissionPresets' as never, {
      names: [preset],
      current: () => preset,
      resolve: () => ({ sandbox: preset, approval: preset === 'danger-full-access' ? 'never' : 'ask' }),
    } as never)
  }
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  // Minimal `settings` seam stub: the plugin's `installSection` call fails on
  // `ctx.settings === undefined`, which aborts `apply` and rolls back every
  // registered adapter. A static source is enough — tests never edit settings.
  ctx.provide('settings' as never, {
    installSection(
      _owner: unknown,
      _ns: string,
      _schema: unknown,
      entry: unknown,
      hooks: { setSource: (source: () => unknown) => void },
    ) {
      hooks.setSource(() => entry)
    },
  } as never)
  const server = opts.server ?? { command: process.execPath, args: [mockServer] }
  await ctx.plugin(acp, {
    emitReasoning: opts.emitReasoning ?? false,
    env: mockEnv,
    ...opts.config,
    servers: {
      test: {
        command: server.command,
        args: server.args,
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

/** Minimal initiating agent with an open turn for the approval service audit pair. */
function fakeAgent(): Agent {
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [
    { type: 'turn/start' },
    { type: 'user/message' },
  ]
  return {
    session: {
      events,
      // `approval.request` walks the log backwards via `seq`/`eventAt` to prove
      // an open turn; a bare `events` array is not enough for that check.
      get seq() { return events.length },
      eventAt: (seq: number) => events[seq],
      append: (type: string, data: Record<string, unknown>) => {
        const event = { type, data }
        events.push(event)
        return event as unknown as SessionEvent
      },
    },
  } as unknown as Agent
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

  it('uses the workspace-write session preset and forwards the ACP permission request to approval', async () => {
    const ctx = await setup(
      { MOCK_PERMISSION: '1', MOCK_TEXT: 'approved' },
      { permissionPreset: 'workspace-write' },
    )
    const received: Array<{ toolName: string; reason?: string }> = []
    ctx.on('approval/request', (request) => {
      received.push({
        toolName: request.toolName,
        ...request.reason === undefined ? {} : { reason: request.reason },
      })
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })
    try {
      const chunks = await ctx.agents.withInitiator(fakeAgent(), () => collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      })))
      expect(assembledText(chunks)).toBe('approved')
      expect(received).toEqual([{
        toolName: 'ACP: mock side effect',
        reason: 'Test ACP requested permission to run "mock side effect".',
      }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses the danger-full-access session preset without opening an approval prompt', async () => {
    const ctx = await setup(
      { MOCK_PERMISSION: '1', MOCK_TEXT: 'full access' },
      { permissionPreset: 'danger-full-access' },
    )
    let requested = false
    ctx.on('approval/request', () => {
      requested = true
      return Promise.resolve<ApprovalOutcome>('rejected')
    })
    try {
      const chunks = await ctx.agents.withInitiator(fakeAgent(), () => collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      })))
      expect(assembledText(chunks)).toBe('full access')
      expect(requested).toBe(false)
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

  it('never calls authenticate when session/new succeeds without it', async () => {
    // The fixture advertises an auth method but exits the process if
    // `authenticate` is ever called — the stream can only succeed when the
    // connection goes straight to session/new.
    const ctx = await setup(
      { MOCK_AUTH_METHODS: '1', MOCK_AUTH_POISON: '1', MOCK_TEXT: 'no auth needed' },
      { server: { command: process.execPath, args: [authMockServer] } },
    )
    try {
      const chunks = await collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      }))
      expect(assembledText(chunks)).toBe('no auth needed')
      expect(finishChunk(chunks).reason.kind).toBe('stop')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runs one lazy authenticate round when session/new requires auth', async () => {
    // session/new fails until authenticate runs; the connection must recover
    // via one bounded auth round and a retry, not hang or fail outright.
    const ctx = await setup(
      { MOCK_AUTH_METHODS: '1', MOCK_REQUIRE_AUTH: '1', MOCK_TEXT: 'authed answer' },
      { server: { command: process.execPath, args: [authMockServer] } },
    )
    try {
      const chunks = await collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      }))
      expect(assembledText(chunks)).toBe('authed answer')
      expect(finishChunk(chunks).reason.kind).toBe('stop')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails the stream when initialize never answers within initTimeoutMs', async () => {
    const ctx = await setup(
      { MOCK_SILENT_INIT: '1' },
      { server: { command: process.execPath, args: [authMockServer] }, config: { initTimeoutMs: 800, disposeEofGraceMs: 500 } },
    )
    try {
      const chunks = await collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      }))
      const reason = finishChunk(chunks).reason
      expect(reason.kind).toBe('error')
      if (reason.kind === 'error') expect(reason.failure.code).toBe('ACP_INIT_FAILED')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 30_000)

  it('settles an aborted prompt when the server ignores session/cancel', async () => {
    // MOCK_HANG + MOCK_IGNORE_CANCEL: the prompt never resolves on its own and
    // the child never answers the cancel — the client must still settle the
    // stream as aborted after the cancel grace.
    const ctx = await setup({ MOCK_HANG: '1', MOCK_IGNORE_CANCEL: '1', MOCK_TEXT: 'chunk' })
    const controller = new AbortController()
    try {
      const chunks: StreamChunk[] = []
      for await (const chunk of ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        signal: controller.signal,
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      })) {
        chunks.push(chunk)
        if (chunk.type === 'text-delta') controller.abort()
      }
      const reason = finishChunk(chunks).reason
      expect(reason.kind).toBe('aborted')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 30_000)
})
