// Probe: spawn devin acp, authenticate via iOA, send a prompt,
// and dump every raw session/update payload to inspect thought chunk content.
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

const child = spawn('/Users/shenkonghui/.local/bin/devin', ['acp'], {
  cwd: '/Users/shenkonghui/Documents',
  stdio: ['pipe', 'pipe', 'inherit'],
})

const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout),
)

const client = {
  sessionUpdate: async (params) => {
    console.log('UPDATE>', JSON.stringify(params).slice(0, 500))
  },
  requestPermission: async (params) => {
    console.log('PERM>', JSON.stringify(params).slice(0, 300))
    const opt = params.options?.find(o => o.kind === 'allow_once') ?? params.options?.[0]
    return { outcome: opt ? { outcome: 'selected', optionId: opt.optionId } : { outcome: 'cancelled' } }
  },
  extNotification: async (method, params) => {
    console.log('EXT>', method, JSON.stringify(params).slice(0, 300))
  },
  extMethod: async (method) => {
    console.log('EXTMETHOD>', method)
    return {}
  },
}

const conn = new acp.ClientSideConnection(() => client, stream)

const init = await conn.initialize({ protocolVersion: 1, clientCapabilities: {} })
console.log('INIT>', JSON.stringify(init).slice(0, 400))



const ses = await conn.newSession({ cwd: '/Users/shenkonghui/Documents', mcpServers: [] })
console.log('SESSION>', ses.sessionId)

const res = await conn.prompt({
  sessionId: ses.sessionId,
  prompt: [{ type: 'text', text: '请一步一步思考: 17 * 23 等于多少?' }],
})
console.log('DONE>', JSON.stringify(res))

child.kill()
process.exit(0)
