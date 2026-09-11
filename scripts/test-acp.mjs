#!/usr/bin/env node
/**
 * Headless ACP server test: handshake → model catalog → probe prompt.
 * Reuses the plugin's own AcpConnection, so the flow matches the host side
 * exactly (initialize, key auth, session/new, prompt streaming).
 *
 * Usage:
 *   make test-acp cmd="devin acp"
 *   node scripts/test-acp.mjs --cmd "devin acp"
 *   node scripts/test-acp.mjs devin acp
 *
 * API keys are read from the ambient environment (DEEPSEEK_API_KEY,
 * OPENAI_API_KEY, …) the same way the plugin resolves them.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import {
  AcpConnection,
  DEFAULT_AUTH_TIMEOUT_MS,
  DEFAULT_DISPOSE_EOF_GRACE_MS,
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_INIT_TIMEOUT_MS,
  DEFAULT_SESSION_TIMEOUT_MS,
} from '../lib/index.js'

const INIT_TIMEOUT_MS = 15_000
const PROMPT_TIMEOUT_MS = 60_000
const API_KEY_VARS = [
  'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'DEVIN_API_KEY', 'API_KEY', 'CODEBUDDY_API_KEY', 'LLM_API_KEY',
]

const ok = (label, detail) => console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
const bad = (label, detail) => console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
const info = (label, detail) => console.log(`  \x1b[33m…\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
const elapsed = since => `${((Date.now() - since) / 1000).toFixed(1)}s`

/** Minimal SubprocessHandle over node:child_process for the connection seam. */
function spawnHandle(spec) {
  const child = nodeSpawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const done = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  return {
    pid: child.pid ?? -1,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    collected: {},
    done,
    terminate() {
      child.kill('SIGTERM')
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, spec.graceMs)
    },
    async waitForExit() { await done; return true },
  }
}

/** Split a `--cmd "devin acp"` value the way a shell would. */
function splitCommand(raw) {
  const parts = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  return parts.map(part => part.replace(/^["']|["']$/g, ''))
}

function parseArgv(argv) {
  const cmdIndex = argv.indexOf('--cmd')
  if (cmdIndex >= 0) {
    const raw = argv[cmdIndex + 1]
    if (raw === undefined || raw.trim() === '') {
      console.error('usage: make test-acp cmd="devin acp"  (or: node scripts/test-acp.mjs --cmd "devin acp")')
      process.exit(2)
    }
    return splitCommand(raw)
  }
  const positional = argv.filter(arg => arg !== '--')
  if (positional.length > 0) return positional
  console.error('usage: make test-acp cmd="devin acp"  (or: node scripts/test-acp.mjs --cmd "devin acp")')
  process.exit(2)
}

const [command, ...args] = parseArgv(process.argv.slice(2))
console.log(`ACP server test: ${command} ${args.join(' ')}`)

const connection = new AcpConnection({
  command,
  args,
  cwd: process.cwd(),
  env: {},
  disposeEofGraceMs: DEFAULT_DISPOSE_EOF_GRACE_MS,
  disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
  initTimeoutMs: DEFAULT_INIT_TIMEOUT_MS,
  sessionTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
  authTimeoutMs: DEFAULT_AUTH_TIMEOUT_MS,
  spawn: spawnHandle,
  onWarn: message => console.log(`  [warn] ${message}`),
  resolveAuthApiKey: async () => {
    for (const key of API_KEY_VARS) {
      const value = process.env[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    return undefined
  },
})

let failed = false

// Step 1: handshake (initialize + authenticate).
{
  const t0 = Date.now()
  info('认证握手', 'initializing…')
  try {
    await connection.ready
    const server = connection.getServerInfo()
    ok('认证握手', server
      ? `${server.agentName} v${server.agentVersion} · ACP protocol ${server.protocolVersion} · ${elapsed(t0)}`
      : `initialize completed (no agentInfo published) · ${elapsed(t0)}`)
  } catch (error) {
    failed = true
    bad('认证握手', `${error instanceof Error ? error.message : String(error)} · ${elapsed(t0)}`)
  }
}

// Step 2: model catalog (throwaway session/new + configOptions).
let models = []
if (!failed) {
  const t0 = Date.now()
  info('获取模型', 'probing…')
  try {
    const discovered = await Promise.race([
      connection.discoverModels(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after 10s`)), 10_000)),
    ])
    models = discovered ?? []
    if (models.length > 0) {
      ok('获取模型', `${models.length} 个模型: ${models.slice(0, 8).map(m => m.id).join(', ')}${models.length > 8 ? ' …' : ''} · ${elapsed(t0)}`)
    } else {
      ok('获取模型', `服务未发布模型目录（将使用默认模型） · ${elapsed(t0)}`)
    }
  } catch (error) {
    failed = true
    bad('获取模型', `${error instanceof Error ? error.message : String(error)} · ${elapsed(t0)}`)
  }
}

// Step 3: end-to-end prompt (real session, real tokens).
if (!failed) {
  const t0 = Date.now()
  info('发送消息', 'sending probe prompt…')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROMPT_TIMEOUT_MS)
  let sessionId
  try {
    sessionId = await connection.newSession()
    let reply = ''
    for await (const update of connection.promptStream(
      sessionId,
      [{ type: 'text', text: 'Reply with exactly: pong' }],
      controller.signal,
    )) {
      if (update.kind === 'text') reply += update.text
      else if (update.kind === 'done') break
      else if (update.kind === 'error') throw new Error(update.error.message)
    }
    clearTimeout(timer)
    if (controller.signal.aborted) throw new Error(`prompt timed out after ${PROMPT_TIMEOUT_MS}ms`)
    ok('发送消息', `reply: ${JSON.stringify(reply.trim())} · ${elapsed(t0)}`)
  } catch (error) {
    failed = true
    bad('发送消息', `${error instanceof Error ? error.message : String(error)} · ${elapsed(t0)}`)
  } finally {
    clearTimeout(timer)
    if (sessionId !== undefined) connection.closeSession(sessionId)
  }
}

await connection.dispose().catch(() => {})
console.log(failed ? '\n结果: 失败' : '\n结果: 全部通过')
process.exit(failed ? 1 : 0)
