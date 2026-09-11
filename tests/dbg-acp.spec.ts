import { it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { fileURLToPath } from 'node:url'
import AgentRuntime, { type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as acp from '../src/index.ts'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

const mockServer = fileURLToPath(new URL('../../deepseek-harness/packages/subagent/subagent-acp/tests/mock-acp-server.ts', import.meta.url))

it('debug', async () => {
  const ctx = new Context()
  await ctx.plugin(Loader)
  await ctx.plugin(AgentRuntime)
  await ctx.plugin(ApprovalService)
  ctx.provide('permissionPresets' as never, {
    names: ['workspace-write'],
    current: () => 'workspace-write',
    resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }),
  } as never)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  ctx.provide('settings' as never, {
    installSection(_o: unknown, _n: string, _s: unknown, entry: unknown, hooks: any) { hooks.setSource(() => entry) },
  } as never)
  await ctx.plugin(acp, {
    emitReasoning: false,
    env: { MOCK_PERMISSION: '1', MOCK_TEXT: 'approved' },
    servers: { test: { command: process.execPath, args: [mockServer], name: 'Test ACP' } },
  })
  console.log('agents?', typeof ctx.get('agents'), 'approval?', typeof ctx.get('approval'))
  const approval: any = ctx.get('approval')
  const origReq = approval.request.bind(approval)
  approval.request = async (req: any) => {
    console.log('approval.request called, tool:', req.toolName)
    try { const r = await origReq(req); console.log('approval outcome', r); return r }
    catch (e) { console.log('approval.request threw:', (e as Error).message); throw e }
  }
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [{ type: 'turn/start' }, { type: 'user/message' }]
  const fakeAgent = { session: { events, append: (t: string, d: Record<string, unknown>) => { const e = { type: t, data: d }; events.push(e); return e } } } as unknown as Agent
  const chunks: StreamChunk[] = []
  await ctx.agents.withInitiator(fakeAgent, async () => {
    for await (const c of ctx.llm.stream({ provider: 'acp-test', model: 'any', messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })] })) chunks.push(c)
  })
  console.log('CHUNKS', JSON.stringify(chunks.map(c => c.type === 'finish' ? c : c.type)))
  await ctx.fiber.dispose()
}, 30000)
