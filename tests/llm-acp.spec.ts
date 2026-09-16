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
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentRuntime, { type Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as acp from '../src/index.ts'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

const mockServer = fileURLToPath(new URL('../../deepseek-harness/packages/subagent/subagent-acp/tests/mock-acp-server.ts', import.meta.url))
const authMockServer = fileURLToPath(new URL('./mock-acp-auth-server.ts', import.meta.url))

interface SetupEnv {
  [key: string]: string
}

type PresetName = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * Mount the ACP LLM adapter pointed at the mock server, scripted by `mockEnv`.
 * `emitReasoning` selects whether thought chunks become reasoning-delta.
 * `server` overrides the spawned fixture (default: the shared mock server);
 * `config` merges extra plugin config (e.g. shorter timeouts).
 * `permissionPreset` accepts a getter so a test can switch the session preset
 * while a prompt is in flight.
 */
async function setup(mockEnv: SetupEnv = {}, opts: {
  emitReasoning?: boolean
  permissionPreset?: PresetName | (() => PresetName)
  sandboxMode?: string
  modeMap?: Record<string, string>
  subagentMap?: Record<string, string>
  authMethod?: string
  /** Collects host warnings, for asserting on diagnostics. */
  warnSink?: string[]
  server?: { command: string; args: string[] }
  config?: Record<string, unknown>
} = {}) {
  const ctx = new Context()
  await ctx.plugin(Loader)
  await ctx.plugin(AgentRuntime)
  await ctx.plugin(ApprovalService)
  if (opts.permissionPreset !== undefined) {
    const preset = opts.permissionPreset
    const current = typeof preset === 'function' ? preset : () => preset
    ctx.provide('permissionPresets' as never, {
      names: ['read-only', 'workspace-write', 'danger-full-access'],
      current,
      resolve: (name: string) => ({ sandbox: name, approval: name === 'danger-full-access' ? 'never' : 'ask' }),
    } as never)
  }
  if (opts.sandboxMode !== undefined) {
    const mode = opts.sandboxMode
    ctx.provide('sandboxPolicy' as never, {
      resolve: () => ({ mode }),
    } as never)
  }
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  // Minimal `settings` seam stub: the plugin's `installSection` call fails on
  // `ctx.settings === undefined`, which aborts `apply` and rolls back every
  // registered adapter. The holder stays mutable so a test can act as the
  // settings UI and drive a reconcile.
  let holder: { servers: Record<string, unknown> } = { servers: {} }
  let notifyChange: (() => void) | undefined
  ctx.provide('settings' as never, {
    installSection(
      _owner: unknown,
      _ns: string,
      _schema: unknown,
      entry: unknown,
      hooks: { setSource: (source: () => unknown) => void; onChange: () => void },
    ) {
      holder = entry as { servers: Record<string, unknown> }
      notifyChange = hooks.onChange
      hooks.setSource(() => holder)
    },
  } as never)
  const server = opts.server ?? { command: process.execPath, args: [mockServer] }
  if (opts.warnSink !== undefined) {
    const sink = opts.warnSink
    const original = ctx.logger.warn.bind(ctx.logger)
    ctx.logger.warn = (...args: unknown[]) => {
      sink.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '))
      original(...(args as [unknown]))
    }
  }
  await ctx.plugin(acp, {
    emitReasoning: opts.emitReasoning ?? false,
    env: mockEnv,
    ...opts.config,
    servers: {
      test: {
        command: server.command,
        args: server.args,
        name: 'Test ACP',
        modeMap: opts.modeMap ?? {},
        subagentMap: opts.subagentMap ?? {},
        authMethod: opts.authMethod ?? '',
      },
    },
  })
  // Act as the settings UI: replace the stored server map and notify, so the
  // plugin reconciles exactly as it would after a real write.
  const applyServers = (servers: Record<string, unknown>): void => {
    holder.servers = servers
    notifyChange?.()
  }
  return Object.assign(ctx, { applyServers })
}

/** Collect all StreamChunks from one adapter stream call. */
async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

/**
 * A fresh path for the mock to append its `authenticate` calls to. The file is
 * the observable proof of whether (and with which method) a round ran, which a
 * behavioural assertion alone cannot distinguish from "optimistically worked".
 */
function authLog(): string {
  return join(mkdtempSync(join(tmpdir(), 'llm-acp-auth-')), 'auth.log')
}

/** Recorded `authenticate` calls, one `auth=<methodId>[ key]` per line. */
function authCalls(file: string): string[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(line => line.trim().length > 0)
}

/** Read the auth-method picker state from the `acp-methods-<id>` route. */
async function methodState(ctx: Context): Promise<{
  methods: { id: string; name: string }[]
  selected: string
  needed: boolean
}> {
  const models = await ctx.llm.discoverModels('llm-acp', { provider: 'acp-methods-test' })
  const entry = models[0]
  if (entry === undefined) throw new Error('the acp-methods route returned no entry')
  return JSON.parse(entry.name) as { methods: { id: string; name: string }[]; selected: string; needed: boolean }
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

/** Assemble the reasoning text from a stream's chunks (notices and thoughts). */
function reasoningText(chunks: StreamChunk[]): string {
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return assembler.blocks()
    .filter(b => b.type === 'reasoning')
    .map(b => (b as { type: 'reasoning'; text: string }).text)
    .join('')
}

/** Find the terminal finish chunk. */
function finishChunk(chunks: StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> {
  const finish = chunks.find(c => c.type === 'finish')
  if (finish === undefined) throw new Error('no finish chunk emitted')
  return finish as Extract<StreamChunk, { type: 'finish' }>
}

/** Minimal initiating agent with an open turn for the approval service audit pair. */
function fakeAgent(extraEvents: Array<{ type: string; data?: Record<string, unknown> }> = []): Agent {
  const events: Array<Record<string, unknown>> = [
    { type: 'turn/start', seq: 0 },
    { type: 'user/message', seq: 1 },
    ...extraEvents.map((event, i) => ({ ...event, seq: 2 + i })),
  ]
  return {
    session: {
      events,
      // `approval.request` walks the log backwards via `seq`/`eventAt` to prove
      // an open turn; a bare `events` array is not enough for that check.
      get seq() { return events.length },
      eventAt: (seq: number) => events[seq],
      snapshotEvents: () => [...events],
      append: (type: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => {
        const event = { type, data, seq: events.length, ...opts }
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

  it('reports context occupancy as a usage chunk and advertises the server window as the model context', async () => {
    const ctx = await setup(
      { MOCK_TEXT: 'answer', MOCK_USAGE_USED: '64000', MOCK_USAGE_SIZE: '200000' },
      { server: { command: process.execPath, args: [authMockServer] } },
    )
    try {
      const chunks = await collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      }))
      // The server's occupancy is prompt-side only and ACP splits out no
      // response tokens, so it lands as `inputTokens` with a zero output side.
      expect(chunks.filter(c => c.type === 'usage')).toEqual([
        { type: 'usage', usage: { inputTokens: 64_000, outputTokens: 0 } },
      ])
      // The adapter contract puts usage before the terminal finish.
      expect(chunks.findIndex(c => c.type === 'usage'))
        .toBeLessThan(chunks.findIndex(c => c.type === 'finish'))
      // Capacity is what the harness pairs with the sample to render a percent.
      const resolved = await ctx.llm.resolveModelInfo('acp-test', 'any')
      expect(resolved.context).toEqual({ contextWindow: 200_000 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports occupancy without a model capacity when the server publishes no window', async () => {
    const ctx = await setup(
      { MOCK_TEXT: 'answer', MOCK_USAGE_USED: '512' },
      { server: { command: process.execPath, args: [authMockServer] } },
    )
    try {
      const chunks = await collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      }))
      expect(chunks.filter(c => c.type === 'usage')).toEqual([
        { type: 'usage', usage: { inputTokens: 512, outputTokens: 0 } },
      ])
      // A zero window is not a capacity: advertising one would fail the harness's
      // context-metadata validation and break every request on this route.
      const resolved = await ctx.llm.resolveModelInfo('acp-test', 'any')
      expect(resolved.context).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('advertises no capacity until a sample arrives, then keeps it across sessions', async () => {
    const ctx = await setup(
      { MOCK_TEXT: 'answer', MOCK_USAGE_USED: '64000', MOCK_USAGE_SIZE: '200000' },
      { server: { command: process.execPath, args: [authMockServer] } },
    )
    try {
      // Before any sample the route has no capacity, so the harness records a
      // capacity-less `request/context` and renders no occupancy at all. This
      // is the fallback a first turn runs under.
      expect((await ctx.llm.resolveModelInfo('acp-test', 'any')).context).toBeUndefined()

      const chunks = await collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      }))
      expect(chunks.filter(c => c.type === 'usage')).toEqual([
        { type: 'usage', usage: { inputTokens: 64_000, outputTokens: 0 } },
      ])

      // That sample is what supplies the capacity, so the NEXT request records
      // a second `request/context` (the harness re-records whenever it changes)
      // and both halves of the occupancy display are finally known. The window
      // is a route property, so it survives the throwaway session that
      // published it.
      expect((await ctx.llm.resolveModelInfo('acp-test', 'any')).context).toEqual({ contextWindow: 200_000 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the last known window when a later sample carries an unusable size', async () => {
    // Three sequential turns: a good window, then a fractional and a negative
    // one. Each unusable size must be refused WITHOUT evicting the window
    // already learned — a server that loses track of its window mid-conversation
    // must not make the display go dark.
    const ctx = await setup(
      { MOCK_TEXT: 'answer', MOCK_USAGE_USED: '100,200,300', MOCK_USAGE_SIZE: '200000,1.5,-3' },
      { server: { command: process.execPath, args: [authMockServer] } },
    )
    try {
      const turn = async (): Promise<number | undefined> => {
        const chunks = await collect(ctx.llm.stream({
          provider: 'acp-test',
          model: 'any',
          messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
        }))
        const usage = chunks.flatMap(c => c.type === 'usage' ? [c.usage.inputTokens] : [])
        expect(usage).toHaveLength(1)
        return (await ctx.llm.resolveModelInfo('acp-test', 'any')).context?.contextWindow
      }

      expect(await turn()).toBe(200_000)
      expect(await turn()).toBe(200_000)
      expect(await turn()).toBe(200_000)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('replaces the window when the server reports a new one', async () => {
    // The retention above must not turn into over-retention: a legitimate new
    // capacity (the user switched to a larger model behind the same server) is
    // adopted, which is what makes the harness re-record `request/context`.
    const ctx = await setup(
      { MOCK_TEXT: 'answer', MOCK_USAGE_USED: '100,200', MOCK_USAGE_SIZE: '200000,1000000' },
      { server: { command: process.execPath, args: [authMockServer] } },
    )
    try {
      const window = async (): Promise<number | undefined> => {
        await collect(ctx.llm.stream({
          provider: 'acp-test',
          model: 'any',
          messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
        }))
        return (await ctx.llm.resolveModelInfo('acp-test', 'any')).context?.contextWindow
      }
      expect(await window()).toBe(200_000)
      expect(await window()).toBe(1_000_000)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('learns the window from a session-setup sample that no prompt produced', async () => {
    // Some servers know their occupancy as soon as they open a session. The
    // probe session the adapter builds to discover models has no consumer
    // draining it, so the sample must still reach the route's capacity.
    const ctx = await setup(
      { MOCK_TEXT: 'answer', MOCK_USAGE_USED: '500', MOCK_USAGE_SIZE: '200000', MOCK_USAGE_ON_SESSION: '1' },
      { server: { command: process.execPath, args: [authMockServer] } },
    )
    try {
      expect((await ctx.llm.resolveModelInfo('acp-test', 'any')).context).toEqual({ contextWindow: 200_000 })

      const chunks = await collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      }))
      expect(chunks.filter(c => c.type === 'usage')).toEqual([
        { type: 'usage', usage: { inputTokens: 500, outputTokens: 0 } },
      ])
      expect((await ctx.llm.resolveModelInfo('acp-test', 'any')).context).toEqual({ contextWindow: 200_000 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('omits context accounting for auxiliary calls', async () => {
    // Compaction and session-title calls render a purpose-built prompt into a
    // throwaway session; reporting that occupancy would displace the
    // conversation's own sample in the harness's context-pressure fold.
    const ctx = await setup(
      { MOCK_TEXT: 'summary', MOCK_USAGE_USED: '64000', MOCK_USAGE_SIZE: '200000' },
      { server: { command: process.execPath, args: [authMockServer] } },
    )
    try {
      const chunks = await collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        purpose: 'compaction',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      }))
      expect(chunks.filter(c => c.type === 'usage')).toHaveLength(0)
      expect(assembledText(chunks)).toBe('summary')
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
        reason: 'Test ACP requested permission: mock side effect. Options: Allow, Reject.',
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
      // A preset switch writes `approval/policy` + `sandbox/mode` session
      // events; the auto-allow check reads those knobs, not the preset name.
      const agent = fakeAgent([{ type: 'approval/policy', data: { policy: 'never' } }])
      const chunks = await ctx.agents.withInitiator(agent, () => collect(ctx.llm.stream({
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

  it('re-reads the preset per permission request: a mid-turn switch to danger-full-access auto-allows', async () => {
    // The requester is captured once per stream, but the preset must be
    // evaluated at request time — under approval policy "never" the approval
    // seam auto-rejects, so a stale capture would deny the rest of the turn.
    let preset: PresetName = 'workspace-write'
    const ctx = await setup(
      { MOCK_PERMISSIONS: '2', MOCK_TEXT: 'mid-turn switch' },
      { permissionPreset: () => preset, server: { command: process.execPath, args: [authMockServer] } },
    )
    const agent = fakeAgent()
    let asked = 0
    ctx.on('approval/request', () => {
      asked += 1
      preset = 'danger-full-access'
      agent.session.append('approval/policy', { policy: 'never' })
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })
    try {
      const chunks = await ctx.agents.withInitiator(agent, () => collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      })))
      expect(assembledText(chunks)).toBe('mid-turn switch')
      expect(asked).toBe(1)
      const events = (agent.session as unknown as { events: Array<{ type: string; data?: { reason?: string } }> }).events
      const auditAsks = events.filter(e => e.type === 'approval/asked')
      expect(auditAsks).toHaveLength(2)
      expect(auditAsks.some(e => e.data?.reason?.includes('Auto-allowed'))).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('auto-allows a delegated child session whose knobs say full access without a named preset', async () => {
    // Delegation seeds `sandbox/mode` + `approval/policy` events on the child
    // session directly; no `permission/preset` event exists, so a preset-name
    // match derives `custom` and would deny every ACP permission request.
    const ctx = await setup(
      { MOCK_PERMISSION: '1', MOCK_TEXT: 'delegated full access' },
      { sandboxMode: 'danger-full-access' },
    )
    let requested = false
    ctx.on('approval/request', () => {
      requested = true
      return Promise.resolve<ApprovalOutcome>('rejected')
    })
    try {
      const agent = fakeAgent([{ type: 'approval/policy', data: { policy: 'never' } }])
      const chunks = await ctx.agents.withInitiator(agent, () => collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      })))
      expect(assembledText(chunks)).toBe('delegated full access')
      expect(requested).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('applies the configured modeMap to the ACP session before prompting', async () => {
    const modeFile = join(mkdtempSync(join(tmpdir(), 'llm-acp-mode-')), 'modes.txt')
    const ctx = await setup(
      { MOCK_MODE_FILE: modeFile, MOCK_TEXT: 'mode set' },
      {
        permissionPreset: 'danger-full-access',
        modeMap: { 'danger-full-access': 'bypass' },
        server: { command: process.execPath, args: [authMockServer] },
      },
    )
    try {
      const chunks = await ctx.agents.withInitiator(fakeAgent(), () => collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      })))
      expect(assembledText(chunks)).toBe('mode set')
      expect(readFileSync(modeFile, 'utf8')).toContain('mode=bypass\n')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('falls back to session/set_mode when the config option is unsupported', async () => {
    const modeFile = join(mkdtempSync(join(tmpdir(), 'llm-acp-mode-')), 'modes.txt')
    const ctx = await setup(
      { MOCK_MODE_FILE: modeFile, MOCK_FAIL_CONFIG: '1', MOCK_TEXT: 'mode set' },
      {
        permissionPreset: 'danger-full-access',
        modeMap: { 'danger-full-access': 'bypass' },
        server: { command: process.execPath, args: [authMockServer] },
      },
    )
    try {
      const chunks = await ctx.agents.withInitiator(fakeAgent(), () => collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      })))
      expect(assembledText(chunks)).toBe('mode set')
      expect(readFileSync(modeFile, 'utf8')).toBe('mode=bypass\n')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves the ACP session mode untouched when no mapping matches', async () => {
    const modeFile = join(mkdtempSync(join(tmpdir(), 'llm-acp-mode-')), 'modes.txt')
    const ctx = await setup(
      { MOCK_MODE_FILE: modeFile, MOCK_TEXT: 'unmapped' },
      {
        permissionPreset: 'read-only',
        modeMap: { 'danger-full-access': 'bypass' },
        server: { command: process.execPath, args: [authMockServer] },
      },
    )
    try {
      const chunks = await ctx.agents.withInitiator(fakeAgent(), () => collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      })))
      expect(assembledText(chunks)).toBe('unmapped')
      const lines = existsSync(modeFile) ? readFileSync(modeFile, 'utf8').split('\n') : []
      expect(lines.filter(l => l.startsWith('mode='))).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('maps a delegated child session to the ACP mode via its sandbox knob', async () => {
    // Delegation seeds `sandbox/mode` on the child session but no preset event,
    // so `permissionPresets.current` derives `custom`; the sandbox-mode
    // fallback in the modeMap lookup must still resolve the mapping.
    const modeFile = join(mkdtempSync(join(tmpdir(), 'llm-acp-mode-')), 'modes.txt')
    const ctx = await setup(
      { MOCK_MODE_FILE: modeFile, MOCK_TEXT: 'mode set' },
      {
        sandboxMode: 'danger-full-access',
        modeMap: { 'danger-full-access': 'bypass' },
        server: { command: process.execPath, args: [authMockServer] },
      },
    )
    try {
      const chunks = await ctx.agents.withInitiator(fakeAgent(), () => collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      })))
      expect(assembledText(chunks)).toBe('mode set')
      expect(readFileSync(modeFile, 'utf8')).toContain('mode=bypass\n')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lists the server-advertised session modes via the acp-modes route', async () => {
    const ctx = await setup(
      { MOCK_MODES: '1' },
      { server: { command: process.execPath, args: [authMockServer] } },
    )
    try {
      const modes = await ctx.llm.discoverModels('llm-acp', { provider: 'acp-modes-test' })
      expect(modes.map(m => m.id)).toEqual(['ask', 'bypass'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lists dsh permission presets via the acp-dsh-presets route', async () => {
    const ctx = await setup({}, { permissionPreset: 'workspace-write' })
    try {
      const presets = await ctx.llm.discoverModels('llm-acp', { provider: 'acp-dsh-presets' })
      expect(presets.map(m => m.id)).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
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

  it('uses the only advertised auth method without asking', async () => {
    // A server offering no choice needs no choice UI: the sole method is used
    // and the picker reports nothing pending.
    const file = authLog()
    const ctx = await setup(
      { MOCK_AUTH_METHODS: 'oauth', MOCK_REQUIRE_AUTH: '1', MOCK_AUTH_FILE: file, MOCK_TEXT: 'only one' },
      { server: { command: process.execPath, args: [authMockServer] } },
    )
    try {
      const chunks = await collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      }))
      expect(assembledText(chunks)).toBe('only one')
      expect(authCalls(file)).toEqual(['auth=oauth'])
      const state = await methodState(ctx)
      expect(state.methods.map(m => m.id)).toEqual(['oauth'])
      expect(state.needed).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('blocks instead of guessing when several methods are advertised and none is chosen', async () => {
    // codebuddy-style: the first advertised method is intranet-only. Guessing
    // it would hang for the whole interactive-auth window, so an unpicked
    // choice must fail fast, call nothing, and raise the picker instead.
    const file = authLog()
    const warns: string[] = []
    const ctx = await setup(
      {
        MOCK_AUTH_METHODS: 'iOA:Login with iOA,external:Login with Google/Github',
        MOCK_REQUIRE_AUTH: '1',
        MOCK_AUTH_FILE: file,
        MOCK_TEXT: 'never reached',
      },
      { server: { command: process.execPath, args: [authMockServer] }, warnSink: warns, config: { sessionTimeoutMs: 2_000 } },
    )
    try {
      const before = await methodState(ctx)
      expect(before.methods.map(m => m.id)).toEqual(['iOA', 'external'])
      expect(before.selected).toBe('')
      // Nothing has been attempted yet, so the user is not nagged merely for
      // having a multi-method server.
      expect(before.needed).toBe(false)

      const started = Date.now()
      const chunks = await collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      }))
      expect(finishChunk(chunks).reason.kind).toBe('error')
      // Far below the 5-minute interactive window: a blocked choice does not
      // park the turn on a guess.
      expect(Date.now() - started).toBeLessThan(30_000)

      expect(authCalls(file)).toEqual([])
      expect((await methodState(ctx)).needed).toBe(true)
      expect(warns.some(w => w.includes('iOA, external') && w.includes('none is selected'))).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses the selected method when several are advertised', async () => {
    const file = authLog()
    const ctx = await setup(
      {
        MOCK_AUTH_METHODS: 'iOA:Login with iOA,external:Login with Google/Github',
        MOCK_REQUIRE_AUTH: '1',
        MOCK_AUTH_REQUIRE_METHOD: 'external',
        MOCK_AUTH_FILE: file,
        MOCK_TEXT: 'picked method',
      },
      { server: { command: process.execPath, args: [authMockServer] }, authMethod: 'external' },
    )
    try {
      const chunks = await collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      }))
      expect(assembledText(chunks)).toBe('picked method')
      // Exactly the chosen method, never the first-advertised one.
      expect(authCalls(file)).toEqual(['auth=external'])
      const state = await methodState(ctx)
      expect(state.selected).toBe('external')
      expect(state.needed).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('treats a selection the server does not advertise as unresolved in a multi-method catalog', async () => {
    // A renamed or removed method must not silently fall back to the first
    // entry — that is the exact guess this feature exists to prevent.
    const file = authLog()
    const ctx = await setup(
      { MOCK_AUTH_METHODS: 'iOA,external', MOCK_REQUIRE_AUTH: '1', MOCK_AUTH_FILE: file },
      { server: { command: process.execPath, args: [authMockServer] }, authMethod: 'bogus', config: { sessionTimeoutMs: 2_000 } },
    )
    try {
      const chunks = await collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      }))
      expect(finishChunk(chunks).reason.kind).toBe('error')
      expect(authCalls(file)).toEqual([])
      const state = await methodState(ctx)
      expect(state.selected).toBe('bogus')
      expect(state.needed).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('falls back to the sole advertised method when the selection does not match it', async () => {
    // With one method there is nothing to choose between, so a stale selection
    // is not a reason to block authentication.
    const file = authLog()
    const ctx = await setup(
      { MOCK_AUTH_METHODS: 'oauth', MOCK_REQUIRE_AUTH: '1', MOCK_AUTH_FILE: file, MOCK_TEXT: 'fell back' },
      { server: { command: process.execPath, args: [authMockServer] }, authMethod: 'bogus' },
    )
    try {
      const chunks = await collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      }))
      expect(assembledText(chunks)).toBe('fell back')
      expect(authCalls(file)).toEqual(['auth=oauth'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('never authenticates eagerly with a configured API key while the choice is unresolved', async () => {
    // The eager keyed round used to pick an API-key-shaped method, or the first
    // one when none matched — codebuddy matches none, so a key silently
    // selected the intranet method during `initialize`.
    const file = authLog()
    const ctx = await setup(
      {
        CODEBUDDY_API_KEY: 'secret',
        MOCK_AUTH_METHODS: 'iOA:Login with iOA,external:Login with Google/Github',
        MOCK_AUTH_FILE: file,
        MOCK_TEXT: 'unused',
      },
      { server: { command: process.execPath, args: [authMockServer] } },
    )
    try {
      // Resolution awaits `initialize`, so the keyed decision has been made.
      await ctx.llm.resolveModelInfo('acp-test', 'any')
      expect(authCalls(file)).toEqual([])
      expect((await methodState(ctx)).needed).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('carries the API key on the eagerly authenticated selected method', async () => {
    const file = authLog()
    const ctx = await setup(
      {
        CODEBUDDY_API_KEY: 'secret',
        MOCK_AUTH_METHODS: 'iOA,external',
        MOCK_AUTH_FILE: file,
        MOCK_TEXT: 'keyed',
      },
      { server: { command: process.execPath, args: [authMockServer] }, authMethod: 'external' },
    )
    try {
      await ctx.llm.resolveModelInfo('acp-test', 'any')
      expect(authCalls(file)).toEqual(['auth=external key'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('applies a newly selected method by rebuilding the connection', async () => {
    // Selecting in the dialog only writes settings; nothing takes effect unless
    // the server config change rebuilds the connection, so this is the step
    // that turns the picker into a working login.
    const file = authLog()
    const ctx = await setup(
      {
        MOCK_AUTH_METHODS: 'iOA:Login with iOA,external:Login with Google/Github',
        MOCK_REQUIRE_AUTH: '1',
        MOCK_AUTH_REQUIRE_METHOD: 'external',
        MOCK_AUTH_FILE: file,
        MOCK_TEXT: 'after rebuild',
      },
      { server: { command: process.execPath, args: [authMockServer] }, config: { sessionTimeoutMs: 2_000 } },
    )
    try {
      // Blocked while unselected.
      const blocked = await collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      }))
      expect(finishChunk(blocked).reason.kind).toBe('error')
      expect(authCalls(file)).toEqual([])

      ctx.applyServers({
        test: {
          command: process.execPath,
          args: [authMockServer],
          name: 'Test ACP',
          authMethod: 'external',
        },
      })

      const chunks = await collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      }))
      expect(assembledText(chunks)).toBe('after rebuild')
      expect(authCalls(file)).toEqual(['auth=external'])
      const state = await methodState(ctx)
      expect(state.selected).toBe('external')
      expect(state.needed).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('notes a subagent spawn and finish by default, independently of the progress switch', async () => {
    // Detection keys on `_meta['cognition.ai/inferenceToolName']`, not on the
    // human-readable title.
    const ctx = await setup(
      { MOCK_TEXT: 'answer', MOCK_SUBAGENT: '1' },
      { server: { command: process.execPath, args: [authMockServer] } },
    )
    try {
      const chunks = await collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      }))
      const notes = reasoningText(chunks)
      expect(notes).toContain('[subagent: subagent_explore — Read two files and report contents]')
      // The subagent's own lifecycle is an id that never had a `tool_call`.
      expect(notes).toContain('[subagent: 08102184 finished]')
      // Identity comes from `_meta`, so a tool call that merely mentions a
      // subagent in its title is not one: it must come through as an ordinary
      // tool, never as a spawn.
      expect(notes).toContain('[tool: Read file subagent_notes.md]')
      expect(notes).not.toContain('[subagent: Read file subagent_notes.md]')
      // `emitProgress` is off and does not matter here: it carries extension
      // log chatter, while tool activity has its own default-on switch.
      expect(notes).toContain('[tool: Listed ./]')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('hides tool activity on request without hiding subagent notices', async () => {
    // The two switches are independent: turning tool chatter off must not take
    // the subagent events with it, since those are gated by the permission map.
    const ctx = await setup(
      { MOCK_TEXT: 'answer', MOCK_SUBAGENT: '1' },
      { server: { command: process.execPath, args: [authMockServer] }, config: { emitToolCalls: false } },
    )
    try {
      const chunks = await collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      }))
      const notes = reasoningText(chunks)
      expect(notes).not.toContain('[tool:')
      expect(notes).not.toContain('[subagent tool:')
      expect(notes).toContain('[subagent: subagent_explore — Read two files and report contents]')
      expect(notes).toContain('[subagent: 08102184 finished]')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stays silent for a permission state the map marks silent', async () => {
    const ctx = await setup(
      { MOCK_TEXT: 'answer', MOCK_SUBAGENT: '1' },
      {
        server: { command: process.execPath, args: [authMockServer] },
        permissionPreset: 'danger-full-access',
        subagentMap: { 'danger-full-access': 'silent' },
      },
    )
    try {
      // The mapping is keyed by the CALLING session's permission state, so the
      // stream has to run under an initiator for it to resolve at all.
      const chunks = await ctx.agents.withInitiator(fakeAgent(), () => collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      })))
      expect(reasoningText(chunks)).not.toContain('[subagent:')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('notes subagents for a supervised permission state in the same map', async () => {
    // Same map, different key: a supervised session hears about a fan-out
    // while a fully delegated one stays quiet.
    const ctx = await setup(
      { MOCK_TEXT: 'answer', MOCK_SUBAGENT: '1' },
      {
        server: { command: process.execPath, args: [authMockServer] },
        permissionPreset: 'workspace-write',
        subagentMap: { 'workspace-write': 'notice', 'danger-full-access': 'silent' },
      },
    )
    try {
      const chunks = await ctx.agents.withInitiator(fakeAgent(), () => collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      })))
      const notes = reasoningText(chunks)
      expect(notes).toContain('[subagent: subagent_explore — Read two files and report contents]')
      expect(notes).toContain('[subagent: 08102184 finished]')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('labels the calls a subagent makes so they are not read as the main agent\'s', async () => {
    const ctx = await setup(
      { MOCK_TEXT: 'answer', MOCK_SUBAGENT: '1' },
      { server: { command: process.execPath, args: [authMockServer] } },
    )
    try {
      const chunks = await collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      }))
      const notes = reasoningText(chunks)
      expect(notes).toContain('[subagent tool: Read file]')
      // The same tool name outside a subagent keeps its plain label.
      expect(notes).toContain('[tool: Listed ./]')
      expect(notes).not.toContain('[tool: Read file]')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records ACP tool calls as session tool/call + tool/result events instead of reasoning', async () => {
    const ctx = await setup(
      { MOCK_TEXT: 'answer', MOCK_TOOLS: '1' },
      { server: { command: process.execPath, args: [authMockServer] } },
    )
    try {
      const agent = fakeAgent([{ type: 'step/start', data: { turn: 1, step: 1 } }])
      const chunks = await ctx.agents.withInitiator(agent, () => collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      })))
      // Recorded calls leave the reasoning surface entirely…
      expect(reasoningText(chunks)).not.toContain('[tool:')
      // …and never become executable stream blocks, which the agent loop would
      // dispatch to the harness's own registry a second time.
      expect(chunks.some(c => c.type === 'tool-call-delta')).toBe(false)

      const events = (agent.session as unknown as { events: Array<Record<string, unknown>> }).events
      const calls = events.filter(e => e.type === 'tool/call')
      const results = events.filter(e => e.type === 'tool/result')
      // Names are the native row-family names the host maps each ACP tool
      // kind onto; a call with no kind keeps the server-provided title.
      expect(calls.map(c => (c.data as { name: string }).name)).toEqual(['read', 'bash', 'bash', 'Bare probe'])
      for (const call of calls) {
        expect(call.data).toMatchObject({ turn: 1, step: 1 })
      }
      expect((calls[0]!.data as { arguments: string }).arguments).toBe(JSON.stringify({ file_path: '/tmp/a.txt' }))
      // A call with no rawInput records `{}`, not the empty string whose
      // rendering falls back to the opaque callId.
      expect((calls[3]!.data as { arguments: string }).arguments).toBe('{}')
      // Every started call gets a result: the completed ones from their
      // terminal updates, the failed one with an error identity, and the
      // pending one flushed as a non-error empty result when the prompt ended.
      expect(results).toHaveLength(4)
      for (const result of results) {
        const callId = (result.data as { message: { source: { callId: string } } }).message.source.callId
        const callSeq = calls.find(c => (c.data as { callId: string }).callId === callId)!.seq
        expect(result.sourceEventSeqs).toEqual([callSeq])
        expect(result.surfaceOp).toBe('append')
      }
      const resultBlock = (id: string) => {
        const result = results.find(r => (r.data as { message: { source: { callId: string } } }).message.source.callId === id)!
        return result.data as {
          message: { content: Array<{ isError: boolean; content: Array<{ text: string }> }> }
          error?: { name: string; code: string }
        }
      }
      const ok = resultBlock('tool-ok')
      expect(ok.message.content[0]!.isError).toBe(false)
      expect(ok.message.content[0]!.content).toEqual([{ type: 'text', text: 'file body' }])
      expect(ok.error).toBeUndefined()
      const fail = resultBlock('tool-fail')
      expect(fail.message.content[0]!.isError).toBe(true)
      expect(fail.message.content[0]!.content).toEqual([{ type: 'text', text: 'exit 1' }])
      expect(fail.error).toEqual({ name: 'AcpToolError', code: 'ACP_TOOL_FAILED' })
      const pending = resultBlock('tool-pending')
      expect(pending.message.content[0]!.isError).toBe(false)
      expect(pending.message.content[0]!.content).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records subagent-owned calls as tool events while the lifecycle stays a notice', async () => {
    const ctx = await setup(
      { MOCK_TEXT: 'answer', MOCK_SUBAGENT: '1' },
      { server: { command: process.execPath, args: [authMockServer] } },
    )
    try {
      const agent = fakeAgent([{ type: 'step/start', data: { turn: 1, step: 1 } }])
      const chunks = await ctx.agents.withInitiator(agent, () => collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      })))
      const notes = reasoningText(chunks)
      // Spawn/finish stay notices; the calls themselves become session events.
      expect(notes).toContain('[subagent: subagent_explore — Read two files and report contents]')
      expect(notes).toContain('[subagent: 08102184 finished]')
      expect(notes).not.toContain('[tool:')
      const events = (agent.session as unknown as { events: Array<Record<string, unknown>> }).events
      const callIds = events.filter(e => e.type === 'tool/call').map(e => (e.data as { callId: string }).callId)
      expect(callIds).toEqual([
        'exec_0#2d03bd93760b45c5b48c85be71397a29',
        'read_9#decoy0000000000000000000000000000',
        'read_0#60294f38aa7448fe9392bd3b7e31d035',
      ])
      // Neither the spawn call nor the subagent's own lifecycle id is a tool
      // event: one is a notice, the other an update for an id never announced.
      const resultIds = events.filter(e => e.type === 'tool/result')
        .map(e => (e.data as { message: { source: { callId: string } } }).message.source.callId)
      expect(resultIds).toEqual(callIds)
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

  it('dumps every protocol event to DSH_LLM_ACP_DEBUG_DIR as JSONL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-acp-dump-'))
    process.env.DSH_LLM_ACP_DEBUG_DIR = dir
    const ctx = await setup({ MOCK_TEXT: 'dumped' })
    try {
      const chunks = await collect(ctx.llm.stream({
        provider: 'acp-test',
        model: 'any',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      }))
      expect(assembledText(chunks)).toBe('dumped')

      const files = readdirSync(dir).filter(name => name.endsWith('.jsonl'))
      expect(files).toHaveLength(1)
      const lines = readFileSync(join(dir, files[0] as string), 'utf8').trim().split('\n')
        .map(line => JSON.parse(line) as { time: number; dir: string; method: string; summary: string; detail?: string })
      expect(lines.some(line => line.dir === 'send' && line.method === 'initialize')).toBe(true)
      expect(lines.some(line => line.dir === 'send' && line.method === 'session/prompt')).toBe(true)
      expect(lines.some(line => line.dir === 'recv' && line.method === 'session/update' && line.detail !== undefined)).toBe(true)
      // One line per event with its own arrival time: the in-memory buffer
      // collapses consecutive same-key events, the dump must not.
      const times = lines.map(line => line.time)
      expect([...times].sort((a, b) => a - b)).toEqual(times)
      const trace = JSON.parse((await ctx.llm.discoverModels('llm-acp', { provider: 'acp-trace-test' }))[0]?.name ?? '[]') as
        Array<{ dir: string; method: string; count?: number }>
      const buffered = trace
        .filter(entry => entry.dir === 'recv' && entry.method === 'session/update')
        .reduce((sum, entry) => sum + (entry.count ?? 1), 0)
      const dumped = lines.filter(line => line.dir === 'recv' && line.method === 'session/update').length
      expect(dumped).toBe(buffered)
    } finally {
      delete process.env.DSH_LLM_ACP_DEBUG_DIR
      await ctx.fiber.dispose()
    }
  }, 30_000)

  it('resumes a reused session with only the new user message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-acp-reuse-'))
    process.env.DSH_LLM_ACP_DEBUG_DIR = dir
    const ctx = await setup(
      { MOCK_TEXT: 'resumed' },
      { server: { command: process.execPath, args: [authMockServer] } },
    )
    const sessionId = 'dsh-reuse' as SessionId
    try {
      const first = createUserMessage({ content: [{ type: 'text', text: 'first question' }], source: { kind: 'user' } })
      await collect(ctx.llm.stream({ provider: 'acp-test', model: 'any', sessionId, messages: [first] }))
      const second = createUserMessage({ content: [{ type: 'text', text: 'second question' }], source: { kind: 'user' } })
      const chunks = await collect(ctx.llm.stream({ provider: 'acp-test', model: 'any', sessionId, messages: [first, second] }))
      expect(assembledText(chunks)).toBe('resumed')

      // The dump records the round trips, which the ring buffer cannot show.
      // The second turn resumed the first turn's ACP session — no `session/load`
      // (the session is live on this connection) and no `session/new`: the
      // resumed prompt carries only the new message, since the server already
      // holds the history.
      const lines = readFileSync(join(dir, readdirSync(dir).find(name => name.endsWith('.jsonl')) as string), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line) as { dir: string; method: string; detail?: string })
      expect(lines.some(line => line.dir === 'send' && line.method === 'session/load')).toBe(false)
      const prompts = lines.filter(line => line.dir === 'send' && line.method === 'session/prompt')
      expect(prompts).toHaveLength(2)
      expect(prompts[0]?.detail).toContain('first question')
      expect(prompts[1]?.detail).toContain('second question')
      expect(prompts[1]?.detail).not.toContain('first question')
    } finally {
      delete process.env.DSH_LLM_ACP_DEBUG_DIR
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
