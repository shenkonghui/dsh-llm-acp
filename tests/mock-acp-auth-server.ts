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
 * - `MOCK_TEXT` — the assistant text streamed as one `agent_message_chunk`.
 *
 * @module @deepseek-ai/dsh-llm-acp/tests/mock-acp-auth-server
 */

import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
} from '@agentclientprotocol/sdk'

const TEXT = process.env.MOCK_TEXT ?? 'mock child answer'
const ADVERTISE_AUTH = process.env.MOCK_AUTH_METHODS === '1'
const REQUIRE_AUTH = process.env.MOCK_REQUIRE_AUTH === '1'
const POISON_AUTH = process.env.MOCK_AUTH_POISON === '1'
const SILENT = process.env.MOCK_SILENT_INIT === '1'

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
      if (REQUIRE_AUTH && !authed) return Promise.reject(new Error('authentication required'))
      return Promise.resolve({ sessionId: randomUUID() })
    },
    prompt: async (params) => {
      await connRef!.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: TEXT } },
      })
      return { stopReason: 'end_turn' }
    },
    cancel: () => Promise.resolve(),
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
