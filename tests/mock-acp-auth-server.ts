/**
 * A minimal mock ACP agent for auth-path and liveness tests, run as a
 * subprocess. Scripted by environment variables — no model, no network:
 *
 * - `MOCK_AUTH_METHODS` — if `1`, advertise one `oauth` auth method in the
 *   `initialize` response.
 * - `MOCK_REQUIRE_AUTH` — if `1` (with MOCK_AUTH_METHODS), `session/new` fails
 *   with an auth error until an `authenticate` call has completed.
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
const ADVERTISE_AUTH = process.env.MOCK_AUTH_METHODS === '1'
const REQUIRE_AUTH = process.env.MOCK_REQUIRE_AUTH === '1'
const POISON_AUTH = process.env.MOCK_AUTH_POISON === '1'
const SILENT = process.env.MOCK_SILENT_INIT === '1'
const PERMISSIONS = Number(process.env.MOCK_PERMISSIONS ?? '0')
const MODE_FILE = process.env.MOCK_MODE_FILE
const FAIL_CONFIG = process.env.MOCK_FAIL_CONFIG === '1'
const MODES = process.env.MOCK_MODES === '1'

if (SILENT) {
  // A spawned-but-deaf server: keep the process alive without ever answering
  // JSON-RPC, so the client's bounded initialize must time out on its own.
  process.stdin.resume()
  setInterval(() => { /* stay alive */ }, 1000)
} else {
  let authed = false
  const agent: Agent = {
    initialize: () => Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
      authMethods: ADVERTISE_AUTH ? [{ id: 'oauth', name: 'OAuth login' }] : [],
    }),
    authenticate: () => {
      if (POISON_AUTH) process.exit(23)
      authed = true
      return Promise.resolve({})
    },
    newSession: () => {
      if (REQUIRE_AUTH && !authed) return Promise.reject(RequestError.authRequired())
      return Promise.resolve({
        sessionId: randomUUID(),
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
      })
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
