/**
 * A minimal mock ACP agent for auth-path and liveness tests, run as a
 * subprocess. Scripted by environment variables — no model, no network:
 *
 * - `MOCK_AUTH_METHODS` — if `1`, advertise one `oauth` auth method (the
 *   historical shape). Otherwise a comma-separated list advertises those
 *   methods, each optionally carrying a display name after a colon
 *   (`'iOA:Login with iOA,external,internal'`; without a colon the name
 *   repeats the id), mimicking a server that offers the user a choice.
 * - `MOCK_REQUIRE_AUTH` — if `1` (with MOCK_AUTH_METHODS), `session/new` fails
 *   with an auth error until an `authenticate` call has completed.
 * - `MOCK_AUTH_REQUIRE_METHOD` — if set, only an `authenticate` naming this
 *   method id satisfies the requirement; other ids stay unauthenticated, so a
 *   test can prove which method the client picked.
 * - `MOCK_AUTH_FILE` — if set, `authenticate` appends `auth=<methodId>[ key]`
 *   per call, giving a test a direct record of how many rounds ran and with
 *   which method (and whether the keyed path carried `_meta.api_key`).
 * - `MOCK_AUTH_HANG_METHOD` — if set, `authenticate` naming this method id
 *   never resolves, standing in for a flow whose backend is unreachable.
 * - `MOCK_AUTH_POISON` — if `1`, exit the process on any `authenticate` call,
 *   proving the client never calls `authenticate` when `session/new` works.
 * - `MOCK_SILENT_INIT` — if `1`, never answer any JSON-RPC request and keep the
 *   process alive, exercising the client's `initialize` timeout.
 * - `MOCK_PERMISSIONS` — if set to a positive number N, `session/prompt` asks
 *   `session/request_permission` N times before answering.
 * - `MOCK_MODE_FILE` — if set, `session/set_config_option` appends
 *   `<configId>=<value>` and `session/set_mode` appends `mode=<modeId>` lines.
 * - `MOCK_FAIL_CONFIG` — if `1`, `session/set_config_option` rejects with
 *   method-not-found, exercising the client's `session/set_mode` fallback.
 * - `MOCK_MODES` — if `1`, `session/new` advertises a `mode` config option
 *   with `ask`/`bypass` values, exercising the client's mode discovery.
 * - `MOCK_USAGE_USED` — if set, `session/prompt` emits one `usage_update`
 *   reporting this many tokens in context before streaming its text. A
 *   comma-separated list scripts successive prompts (`100,200` → the first
 *   prompt reports 100, the second and every later one 200), so one process can
 *   exercise a window that appears, changes, or degrades across turns.
 * - `MOCK_USAGE_SIZE` — the context window reported alongside
 *   `MOCK_USAGE_USED`, scripted the same way (default `0`, standing for a
 *   server that knows its occupancy but not its capacity).
 * - `MOCK_USAGE_ON_SESSION` — if `1`, announce the first scripted usage sample
 *   from `session/new` itself, i.e. before any prompt, as a server that knows
 *   its occupancy at session setup does.
 * - `MOCK_SUBAGENT` — if `1`, `session/prompt` replays the subagent traffic a
 *   real Devin session produces, in the order it produced it: an ordinary
 *   `exec` call, a `run_subagent` call carrying `profile` in `rawInput` and
 *   `cognition.ai/inferenceToolName` in `_meta`, a tool call made *inside* the
 *   subagent (marked with `cognition.ai/subagent_context.parentAgentId`), and
 *   finally the subagent's own completion as a `tool_call_update` for its agent
 *   id — an id that never had a `tool_call` of its own.
 * - `MOCK_TOOLS` — if `1`, `session/prompt` replays a tool lifecycle spread:
 *   one call that completes with text output after an `in_progress` beat, one
 *   that fails, one left pending when the prompt ends — exercising the
 *   client's start/end pairing and its flush of calls that never report a
 *   terminal status — and one bare call with neither `rawInput` nor `kind`
 *   that arrives already completed.
 * - `MOCK_TEXT` — the assistant text streamed as one `agent_message_chunk`.
 *
 * @module @deepseek-ai/dsh-llm-acp/tests/mock-acp-auth-server
 */

import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
} from '@agentclientprotocol/sdk'

const TEXT = process.env.MOCK_TEXT ?? 'mock child answer'
const AUTH_METHODS_SPEC = process.env.MOCK_AUTH_METHODS
const REQUIRE_AUTH = process.env.MOCK_REQUIRE_AUTH === '1'
const REQUIRE_METHOD = process.env.MOCK_AUTH_REQUIRE_METHOD
const AUTH_FILE = process.env.MOCK_AUTH_FILE
const HANG_METHOD = process.env.MOCK_AUTH_HANG_METHOD
const POISON_AUTH = process.env.MOCK_AUTH_POISON === '1'
const SILENT = process.env.MOCK_SILENT_INIT === '1'
const PERMISSIONS = Number(process.env.MOCK_PERMISSIONS ?? '0')
const MODE_FILE = process.env.MOCK_MODE_FILE
const FAIL_CONFIG = process.env.MOCK_FAIL_CONFIG === '1'
const MODES = process.env.MOCK_MODES === '1'
const USAGE_USED = process.env.MOCK_USAGE_USED
const USAGE_SIZE = process.env.MOCK_USAGE_SIZE
const USAGE_ON_SESSION = process.env.MOCK_USAGE_ON_SESSION === '1'
const SUBAGENT = process.env.MOCK_SUBAGENT === '1'
const TOOLS = process.env.MOCK_TOOLS === '1'

/** The agent id a replayed subagent reports as its parent. */
const SUBAGENT_AGENT_ID = '08102184'

/**
 * Replay the tool-call traffic of one real Devin turn that delegates to a
 * subagent. Field names, `_meta` keys and the order are taken verbatim from a
 * captured session so the client's detection is exercised against reality
 * rather than against an invented shape.
 */
async function emitSubagentTraffic(
  conn: AgentSideConnection,
  sessionId: string,
): Promise<void> {
  const update = (u: unknown): Promise<void> =>
    conn.sessionUpdate({ sessionId, update: u as never })

  await update({
    sessionUpdate: 'tool_call',
    toolCallId: 'exec_0#2d03bd93760b45c5b48c85be71397a29',
    title: 'Listed ./',
    kind: 'execute',
    rawInput: { command: 'ls -la' },
    _meta: { 'cognition.ai/commandNames': ['ls'], 'cognition.ai/inferenceToolName': 'exec' },
  })
  await update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'exec_0#2d03bd93760b45c5b48c85be71397a29',
    status: 'completed',
  })
  await update({
    sessionUpdate: 'tool_call',
    toolCallId: 'run_subagent_1#6f36d0db0ee84149aa7a716514aec40b',
    title: 'Ran explore subagent Read two files and report contents',
    rawInput: {
      title: 'Read two files and report contents',
      task: 'Read these two files and report each one\'s exact contents verbatim.',
      profile: 'subagent_explore',
    },
    _meta: { 'cognition.ai/inferenceToolName': 'run_subagent' },
  })
  // Decoy: a tool call whose TITLE mentions a subagent but which is not one.
  // Detection must key on `_meta.inferenceToolName`, so a file, command or log
  // line that merely says "subagent" cannot be mistaken for a spawn.
  await update({
    sessionUpdate: 'tool_call',
    toolCallId: 'read_9#decoy0000000000000000000000000000',
    title: 'Read file subagent_notes.md',
    kind: 'read',
    rawInput: { file_path: '/tmp/subagent_notes.md' },
    _meta: { 'cognition.ai/inferenceToolName': 'read' },
  })
  await update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'run_subagent_1#6f36d0db0ee84149aa7a716514aec40b',
    status: 'in_progress',
  })
  // The subagent's own lifecycle: an id with no preceding `tool_call`.
  await update({
    sessionUpdate: 'tool_call_update',
    toolCallId: SUBAGENT_AGENT_ID,
    status: 'in_progress',
  })
  await update({
    sessionUpdate: 'tool_call',
    toolCallId: 'read_0#60294f38aa7448fe9392bd3b7e31d035',
    title: 'Read file',
    kind: 'read',
    rawInput: { file_path: '/tmp/alpha.txt' },
    _meta: {
      'cognition.ai/inferenceToolName': 'read',
      'cognition.ai/subagent_context': { parentAgentId: SUBAGENT_AGENT_ID },
    },
  })
  await update({
    sessionUpdate: 'tool_call_update',
    toolCallId: SUBAGENT_AGENT_ID,
    status: 'completed',
  })
  await update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'run_subagent_1#6f36d0db0ee84149aa7a716514aec40b',
    status: 'completed',
  })
}

/**
 * Replay one of each tool-call lifecycle the client must pair: a call that
 * completes carrying text output, a call that fails, and a call the prompt
 * abandons without a terminal update.
 */
async function emitToolTraffic(
  conn: AgentSideConnection,
  sessionId: string,
): Promise<void> {
  const update = (u: unknown): Promise<void> =>
    conn.sessionUpdate({ sessionId, update: u as never })

  await update({
    sessionUpdate: 'tool_call',
    toolCallId: 'tool-ok',
    title: 'Read file',
    kind: 'read',
    rawInput: { file_path: '/tmp/a.txt' },
  })
  await update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-ok',
    status: 'in_progress',
  })
  await update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-ok',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'file body' } }],
  })
  await update({
    sessionUpdate: 'tool_call',
    toolCallId: 'tool-fail',
    title: 'Bash',
    kind: 'execute',
    rawInput: { command: 'false' },
  })
  await update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-fail',
    status: 'failed',
    content: [{ type: 'content', content: { type: 'text', text: 'exit 1' } }],
  })
  // Left pending: no terminal `tool_call_update` ever arrives for this id.
  await update({
    sessionUpdate: 'tool_call',
    toolCallId: 'tool-pending',
    title: 'Slow op',
    kind: 'execute',
    rawInput: { command: 'sleep 60' },
  })
  // No `rawInput` and no `kind`: args serialize to `{}` and the server title
  // stays the row name (no kind to map onto a native tool family).
  await update({
    sessionUpdate: 'tool_call',
    toolCallId: 'tool-bare',
    title: 'Bare probe',
    status: 'completed',
  })
}

/**
 * Parse `MOCK_AUTH_METHODS` into the advertised method list. `'1'` keeps the
 * historical single-`oauth` fixture so existing tests are unaffected.
 */
function parseAuthMethods(spec: string | undefined): { id: string; name: string }[] {
  if (spec === undefined || spec === '' || spec === '0') return []
  if (spec === '1') return [{ id: 'oauth', name: 'OAuth login' }]
  return spec.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0).map((entry) => {
    const [id, name] = entry.split(':', 2)
    return { id, name: name !== undefined && name.length > 0 ? name : id }
  })
}

const AUTH_METHODS = parseAuthMethods(AUTH_METHODS_SPEC)

/**
 * Read the `index`th entry of a comma-separated env script, clamping past the
 * end so a single value applies to every sample and a list scripts successive
 * ones. Numbers are passed through raw — a fractional or negative entry tests
 * the client's refusal to treat a malformed count as a capacity.
 */
function scriptedNumber(raw: string | undefined, index: number): number | undefined {
  if (raw === undefined) return undefined
  const entries = raw.split(',')
  return Number(entries[Math.min(index, entries.length - 1)])
}

if (SILENT) {
  // A spawned-but-deaf server: keep the process alive without ever answering
  // JSON-RPC, so the client's bounded initialize must time out on its own.
  process.stdin.resume()
  setInterval(() => { /* stay alive */ }, 1000)
} else {
  let authed = false
  /** Prompts served so far, indexing the {@link scriptedNumber} usage scripts. */
  let prompts = 0
  const agent: Agent = {
    initialize: () => Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      authMethods: AUTH_METHODS,
    }),
    authenticate: (params: { methodId: string; _meta?: { api_key?: string } }) => {
      if (POISON_AUTH) process.exit(23)
      if (AUTH_FILE !== undefined) {
        appendFileSync(AUTH_FILE, `auth=${params.methodId}${params._meta?.api_key !== undefined ? ' key' : ''}\n`)
      }
      if (HANG_METHOD !== undefined && params.methodId === HANG_METHOD) {
        // Never settles — stands in for a method whose backend is unreachable.
        return new Promise<void>(() => { /* hangs by design */ })
      }
      if (REQUIRE_METHOD !== undefined && params.methodId !== REQUIRE_METHOD) {
        // The flow ran but is not the one this server accepts: stay
        // unauthenticated so the caller's retry fails and a test can see which
        // method was picked.
        return Promise.reject(RequestError.authRequired())
      }
      authed = true
      return Promise.resolve({})
    },
    newSession: () => {
      if (REQUIRE_AUTH && !authed) return Promise.reject(RequestError.authRequired())
      const sessionId = randomUUID()
      // A server may know its occupancy as soon as it opens a session. Awaiting
      // the notification keeps the sample strictly before the response, so a
      // client that reads the window right after `session/new` sees it.
      const announce = USAGE_ON_SESSION
        ? connRef!.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'usage_update',
            used: scriptedNumber(USAGE_USED, 0) ?? 0,
            size: scriptedNumber(USAGE_SIZE, 0) ?? 0,
          },
        })
        : Promise.resolve()
      return announce.then(() => ({
        sessionId,
        ...(MODES ? {
          configOptions: [{
            id: 'mode',
            name: 'Session Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'ask',
            options: [
              { value: 'ask', name: 'Ask' },
              { value: 'bypass', name: 'Bypass Permissions' },
            ],
          }],
        } : {}),
      }))
    },
    prompt: async (params) => {
      for (let i = 0; i < PERMISSIONS; i++) {
        const decision = await connRef!.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId: `mock-call-${i}`, title: `mock side effect ${i}` },
          options: [
            { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
        })
        if (decision.outcome.outcome === 'cancelled') return { stopReason: 'cancelled' }
      }
      if (SUBAGENT) await emitSubagentTraffic(connRef!, params.sessionId)
      if (TOOLS) await emitToolTraffic(connRef!, params.sessionId)
      const sample = prompts++
      const used = scriptedNumber(USAGE_USED, sample)
      if (used !== undefined) {
        await connRef!.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: 'usage_update', used, size: scriptedNumber(USAGE_SIZE, sample) ?? 0 },
        })
      }
      await connRef!.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: TEXT } },
      })
      return { stopReason: 'end_turn' }
    },
    cancel: () => Promise.resolve(),
    setSessionConfigOption: (params: { configId: string; value: unknown }) => {
      if (FAIL_CONFIG) return Promise.reject(RequestError.methodNotFound('session/set_config_option'))
      if (MODE_FILE !== undefined) appendFileSync(MODE_FILE, `${params.configId}=${String(params.value)}\n`)
      return Promise.resolve({ configOptions: [] })
    },
    setSessionMode: (params: { modeId: string }) => {
      if (MODE_FILE !== undefined) appendFileSync(MODE_FILE, `mode=${params.modeId}\n`)
      return Promise.resolve()
    },
  }
  let connRef: AgentSideConnection | undefined
  new AgentSideConnection(
    (conn) => {
      connRef = conn
      return agent
    },
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    ),
  )
}
