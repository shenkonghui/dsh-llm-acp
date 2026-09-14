// End-to-end probe: built AcpConnection + AcpAdapter, stream() one prompt,
// print every emitted StreamChunk type to verify reasoning-delta output.
import { spawn } from 'node:child_process'
import { AcpConnection, AcpAdapter } from './lib/index.js'

function makeSpawn() {
  return (spec) => {
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ...spec.env },
      detached: true,
    })
    return {
      pid: child.pid ?? -1,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: undefined,
      collected: {},
      done: new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal }))),
      terminate: () => { try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch {} } },
      waitForExit: async () => new Promise((resolve) => child.on('close', () => resolve(true))),
    }
  }
}

const connection = new AcpConnection({
  command: '/Users/shenkonghui/.local/bin/devin',
  args: ['acp'],
  cwd: '/Users/shenkonghui/Documents',
  env: {},
  disposeEofGraceMs: 500,
  disposeGraceMs: 2000,
  initTimeoutMs: 15000,
  sessionTimeoutMs: 15000,
  authTimeoutMs: 15000,
  spawn: makeSpawn(),
  onWarn: (m) => console.log('WARN>', m),
})

await connection.ready
console.log('READY>')

const adapter = new AcpAdapter({
  connection,
  provider: 'acp-devin',
  emitReasoning: true,
  defaultModel: { id: 'devin', name: 'Devin (ACP)' },
})

const model = process.argv[2] ?? 'swe-2-high'
const bigSystem = process.argv[3] === 'full'
  ? 'You are an AI agent powered by DeepSeek Harness.\n\nYou are a coding agent powered by the swe-2-high model.\n\n' + 'Use the read tool to inspect text files. '.repeat(200)
  : 'You are a helpful assistant.'
const stream = adapter.stream({
  system: bigSystem,
  messages: [{ role: 'user', content: [{ type: 'text', text: '请一步一步思考: 17 * 23 等于多少?' }] }],
  model,
  sessionId: 'probe-session-1',
})

for await (const chunk of stream) {
  const brief = chunk.type === 'text-delta' || chunk.type === 'reasoning-delta'
    ? `${chunk.type} idx=${chunk.index} text=${JSON.stringify(chunk.text.slice(0, 80))}`
    : JSON.stringify(chunk).slice(0, 160)
  console.log('CHUNK>', brief)
}

await connection.dispose()
process.exit(0)
