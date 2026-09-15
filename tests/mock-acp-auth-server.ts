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
      agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
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
