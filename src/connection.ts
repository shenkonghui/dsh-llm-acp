/**
 * Long-lived ACP client connection: spawns one external ACP server subprocess
 * at plugin load and drives it over JSON-RPC stdio. Each {@link AcpConnection.promptStream}
 * call targets one ACP session, sends one user message, and yields the
 * streamed assistant text/reasoning chunks plus a terminal stop reason.
 *
 * Authentication is lazy: `authenticate` runs eagerly only when a configured
 * API key resolves, and otherwise only after a `session/new`/`session/load`
 * failure — servers that accept env credentials or a cached login never see
 * an `authenticate` call, so a healthy server never triggers a browser login
 * it did not need. Every handshake and session operation is bounded by its
 * configured timeout so a wedged server fails fast instead of hanging the
 * harness.
 *
 * @module @deepseek-ai/dsh-llm-acp/connection
 */

import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent as AcpAgent,
  type AgentCapabilities,
  type AuthMethod,
  type Client,
  type ContentBlock as AcpContentBlock,
  type Implementation,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionCapabilities,
  type SessionConfigOption,
  type SessionInfo,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** EOF grace for child flush and nested-process teardown; wider than the signal grace. */
export const DEFAULT_DISPOSE_EOF_GRACE_MS = 6_000

/**
 * Grace after `session/cancel` for the server to settle a hanging prompt.
 * A non-cooperative server may never answer the cancel; the pending drain
 * is force-settled as `cancelled` once this elapses so consumers are not
 * stuck on a dead prompt.
 */
const CANCEL_SETTLE_GRACE_MS = 5_000

/** Resolve after `ms` milliseconds. */
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Reject `operation` with a labelled error when it does not settle within `ms`. */
function withTimeout<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`llm-acp: ${label} timed out after ${ms}ms`)), ms)
    operation.then(
      value => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

/**
 * Prefer an API-key-shaped auth method when several are advertised: the
 * first advertised method is often an interactive OAuth flow, which a keyed
 * `authenticate` call must not select.
 */
function pickAuthMethod(methods: readonly AuthMethod[]): AuthMethod | undefined {
  const keyed = methods.find(m => /api[-_]?key|token|credential/i.test(`${m.id} ${m.name}`))
  return keyed ?? methods[0]
}

/** Default POSIX grace between SIGTERM and SIGKILL on dispose. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** Default bound on the `initialize` handshake plus any keyed `authenticate` round. */
export const DEFAULT_INIT_TIMEOUT_MS = 120_000

/** Default bound on `session/new`, `session/load`, and `session/set_config_option`. */
export const DEFAULT_SESSION_TIMEOUT_MS = 60_000

/** Default bound on one `authenticate` round, keyed or key-less. */
export const DEFAULT_AUTH_TIMEOUT_MS = 15_000

/** One queued update delivered to a {@link AcpConnection.promptStream} consumer. */
type QueuedUpdate =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'progress'; text: string }
  | { kind: 'done'; reason: StopReason }
  | { kind: 'error'; error: Error }

/** Decision returned by an interactive ACP permission requester. */
export type AcpPermissionDecision = 'allow' | 'reject' | 'cancel'

/** Permission details forwarded from an ACP server to an interactive requester. */
export interface AcpPermissionRequest {
  title: string
  signal: AbortSignal
}

/** Interactive permission requester captured for one prompt session. */
export type AcpPermissionRequester = (request: AcpPermissionRequest) => Promise<AcpPermissionDecision>

/** Per-session update queue, fed by the SDK push callback and drained by generators. */
interface SessionQueue {
  queue: QueuedUpdate[]
  resolve: (() => void) | undefined
  permissionRequester: AcpPermissionRequester | undefined
  signal: AbortSignal
}

/** Bounded whole-tree exit wait: polls the handle's tree liveness until it exits or `ms` elapses. */
async function treeExitsWithin(child: SubprocessHandle, ms: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, ms)
  try {
    return await child.waitForExit(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Cooperative teardown ladder over the subprocess seam's public verbs: stdin
 * EOF (the child's window to flush and reap descendants), then the
 * `terminate()` escalation (SIGTERM → grace → SIGKILL) and its whole-tree exit
 * proof. Resolves only at whole-tree quiescence.
 * @param child - the spawned ACP child's handle.
 * @param eofGraceMs - tier-1 window after stdin EOF.
 */
export async function disposeAcpChild(child: SubprocessHandle, eofGraceMs: number): Promise<void> {
  if (child.pid <= 0) {
    await child.done.catch(() => {})
    return
  }
  child.stdin?.end()
  if (await treeExitsWithin(child, eofGraceMs)) return
  child.terminate()
  await child.waitForExit()
}

/** Extract text from an ACP content block (non-text blocks contribute nothing). */
function acpContentText(content: AcpContentBlock): string {
  return content.type === 'text' ? content.text : ''
}

/** Truncate a string to a display-friendly length for permission prompts. */
function truncate(s: string, max = 120): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** Best-effort stringification of a non-string `rawInput` value. */
function tryStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Build a human-readable description of the tool call needing permission.
 * Prefers the server-provided `title`; when absent, derives one from
 * `kind`, `locations` (file paths), and `rawInput` so the user sees what
 * they are approving instead of a generic "ACP operation". */
function describePermissionToolCall(toolCall: RequestPermissionRequest['toolCall']): string {
  const title = typeof toolCall.title === 'string' && toolCall.title.length > 0
    ? toolCall.title
    : ''
  if (title.length > 0) return title
  const kind = toolCall.kind ?? ''
  const locations = toolCall.locations ?? []
  const paths = locations
    .map(loc => loc.path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
  const rawInput = toolCall.rawInput
  const inputSummary = typeof rawInput === 'string' && rawInput.length > 0
    ? rawInput
    : rawInput !== undefined && rawInput !== null
      ? tryStringify(rawInput)
      : ''
  if (kind.length > 0 && paths.length > 0) return `${kind}: ${paths.join(', ')}`
  if (kind.length > 0 && inputSummary.length > 0) return `${kind}: ${truncate(inputSummary)}`
  if (kind.length > 0) return kind
  if (paths.length > 0) return paths.join(', ')
  if (inputSummary.length > 0) return truncate(inputSummary)
  return 'ACP operation'
}

/** Resolved spawn spec for the long-lived ACP server process. */
export interface AcpConnectionSpec {
  /** The executable to spawn (the external ACP agent server). */
  command: string
  /** Arguments passed to {@link command}. */
  args: string[]
  /** Absolute working directory for the child process and its ACP sessions. */
  cwd: string
  /** Extra environment variables merged on top of the scrubbed parent env. */
  env: Record<string, string>
  /** Grace (ms) for the child's EOF-driven quiesce on dispose. */
  disposeEofGraceMs: number
  /** Termination-escalation grace (ms) after SIGTERM before SIGKILL. */
  disposeGraceMs: number
  /** Bound (ms) on the `initialize` handshake plus any keyed `authenticate` round. */
  initTimeoutMs: number
  /** Bound (ms) on `session/new`, `session/load`, and `session/set_config_option`. */
  sessionTimeoutMs: number
  /** Bound (ms) on one `authenticate` round, keyed or key-less. */
  authTimeoutMs: number
  /** Spawn function from the subprocess seam (`ctx.subprocess.spawn`). */
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Sink for connection-level warnings (wired to `ctx.logger.warn`). */
  onWarn?: (message: string) => void
  /**
   * Notified with the browser login URL when the server publishes it via the
   * `_codebuddy.ai/authUrl` extension notification during an interactive
   * `authenticate` round. The host decides how to surface it (e.g. open the
   * system browser); failures must not affect the connection.
   */
  onAuthUrl?: (url: string) => void
  /**
   * Resolves the API key to pass to `authenticate` when the ACP server
   * advertises auth methods. Returns `undefined` to skip authentication
   * (the server will reject `session/new` if it requires auth).
   */
  resolveAuthApiKey?: () => Promise<string | undefined>
}

/**
 * One long-lived ACP client connection backed by a single child server
 * process. The connection is ready after {@link AcpConnection.ready}
 * resolves; dispose runs the full teardown ladder.
 */
export class AcpConnection {
  private readonly child: SubprocessHandle
  private readonly conn: ClientSideConnection
  private readonly spec: AcpConnectionSpec
  private readonly queues = new Map<string, SessionQueue>()
  private readonly readyPromise: Promise<void>
  private disposed = false
  private disposal: Promise<void> | undefined
  /** Capabilities advertised by the agent in its `initialize` response. */
  private agentCapabilities: AgentCapabilities | undefined
  /** Session lifecycle capabilities advertised by the agent. */
  private sessionCapabilities: SessionCapabilities | undefined
  /** Agent name/version published in the `initialize` response (`agentInfo`). */
  private agentInfo: Implementation | undefined
  /** Negotiated ACP protocol version from the `initialize` response. */
  private protocolVersion: number | undefined
  /** Auth methods advertised in the `initialize` response. */
  private authMethods: AuthMethod[] | undefined
  /**
   * The connection's single `authenticate` round — the eager keyed attempt
   * during `initialize`, or the lazy key-less attempt started on the first
   * `session/new`/`session/load` failure. Set at most once; a second round
   * cannot succeed where the first did not.
   */
  private authRound: Promise<void> | undefined
  /**
   * Browser login URL published via the `_codebuddy.ai/authUrl` extension
   * notification while an interactive `authenticate` round is in flight.
   * Captured so a key-less auth timeout can tell the user where to log in.
   */
  private pendingAuthUrl: string | undefined

  constructor(spec: AcpConnectionSpec) {
    this.spec = spec
    this.child = spec.spawn({
      argv: [spec.command, ...spec.args],
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: spec.disposeGraceMs,
      env: spec.env,
    })
    if (this.child.stdin === undefined || this.child.stdout === undefined) {
      throw new Error('llm-acp: subprocess implementation dropped a piped protocol stream')
    }
    const makeClient = (_agent: AcpAgent): Client => ({
      sessionUpdate: (params: SessionNotification): Promise<void> => {
        this.enqueueUpdate(params)
        return Promise.resolve()
      },
      requestPermission: (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        return this.requestPermission(params)
      },
      extNotification: (method: string, params: Record<string, unknown>): Promise<void> => {
        this.handleExtNotification(method, params)
        return Promise.resolve()
      },
      extMethod: (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
        return this.handleExtMethod(method, params)
      },
    })
    this.conn = new ClientSideConnection(
      makeClient,
      ndJsonStream(
        NodeWritable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
        NodeReadable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>,
      ),
    )
    this.readyPromise = withTimeout(
      this.initialize(),
      spec.initTimeoutMs,
      `initialize of "${spec.command}"`,
    )
  }

  /** Resolves when the ACP server has completed `initialize`. */
  get ready(): Promise<void> {
    return this.readyPromise
  }

  private async initialize(): Promise<void> {
    const spawnFailed = this.child.done.then(
      () => new Promise<never>(() => {}),
      (err: unknown) => Promise.reject(err instanceof Error ? err : new Error(String(err))),
    )
    spawnFailed.catch(() => { /* observed by the startup race */ })
    let initResult: InitializeResponse
    try {
      initResult = await Promise.race([
        this.conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
        spawnFailed,
      ])
    } catch (error: unknown) {
      throw new Error(
        `ACP server "${this.spec.command}" failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    this.agentCapabilities = initResult.agentCapabilities
    this.sessionCapabilities = initResult.agentCapabilities?.sessionCapabilities
    this.agentInfo = initResult.agentInfo ?? undefined
    this.protocolVersion = initResult.protocolVersion
    this.authMethods = initResult.authMethods ?? undefined
    try {
      await this.authenticateWithKey()
    } catch (error: unknown) {
      throw new Error(
        `ACP server "${this.spec.command}" failed to authenticate: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** Whether the agent advertises `session/load` (session reuse). */
  get supportsLoadSession(): boolean {
    return this.agentCapabilities?.loadSession === true
  }

  /** Whether the agent advertises `session/list` via sessionCapabilities. */
  get supportsListSessions(): boolean {
    return this.sessionCapabilities?.list != null && this.sessionCapabilities.list !== null
  }

  /** Whether the agent advertises `session/delete` via sessionCapabilities. */
  get supportsDeleteSession(): boolean {
    return this.sessionCapabilities?.delete != null && this.sessionCapabilities.delete !== null
  }

  /**
   * Server identity published in the `initialize` response: the agent's
   * reported name/version and the negotiated ACP protocol version. Returns
   * `undefined` before {@link ready} settles or when no protocol version was
   * negotiated. When the agent omitted or published an invalid `agentInfo`
   * (the SDK silently drops `agentInfo` failing schema validation —
   * `name`/`version` are required non-empty strings), `agentInfoMissing`
   * is `true` and `agentName`/`agentVersion` are empty; callers that need a
   * populated answer should `await ready` first.
   * @returns the agent name/version, protocol version, and whether
   * `agentInfo` was missing; or `undefined` when no protocol version exists.
   */
  getServerInfo(): { agentName: string; agentVersion: string; protocolVersion: number; agentInfoMissing: boolean } | undefined {
    const protocolVersion = this.protocolVersion
    if (protocolVersion === undefined) return undefined
    const info = this.agentInfo
    if (info === undefined) {
      return { agentName: '', agentVersion: '', protocolVersion, agentInfoMissing: true }
    }
    return { agentName: info.name, agentVersion: info.version, protocolVersion, agentInfoMissing: false }
  }

  /**
   * The browser login URL most recently published via the
   * `_codebuddy.ai/authUrl` extension notification, or `undefined` when no
   * interactive login is pending. The settings UI surfaces it as a clickable
   * link so a headless host can still complete the browser login.
   */
  getPendingAuthUrl(): string | undefined {
    return this.pendingAuthUrl
  }

  /**
   * Eager `authenticate` round, run during `initialize` only when the server
   * advertises auth methods AND a configured API key resolves. The key rides
   * as `_meta.api_key` for servers that accept direct key authentication; an
   * API-key-shaped method is preferred over an interactive OAuth one when
   * several are advertised. Without a key no `authenticate` call is made:
   * servers that accept env credentials or a cached login go straight to
   * `session/new`, and servers that truly require an interactive round reach
   * it lazily through {@link ensureAuthenticated} on the first failed
   * `session/new` — so a well-configured server never triggers a browser
   * login it did not need.
   */
  private async authenticateWithKey(): Promise<void> {
    const methods = this.authMethods
    if (methods === undefined || methods.length === 0) return
    const apiKey = this.spec.resolveAuthApiKey !== undefined
      ? await this.spec.resolveAuthApiKey().catch(() => undefined)
      : undefined
    if (apiKey === undefined) return
    const method = pickAuthMethod(methods)
    if (method === undefined) return
    this.authRound = withTimeout(
      this.conn.authenticate({ methodId: method.id, _meta: { api_key: apiKey } }).then(() => {}),
      this.spec.authTimeoutMs,
      'authenticate',
    )
    await this.authRound
  }

  /**
   * The connection's single key-less `authenticate` round, started lazily by
   * {@link withAuthRetry} when `session/new`/`session/load` fails on a server
   * that advertised auth methods. Servers with cached credentials (e.g.
   * codebuddy) resolve the call immediately — and only then accept
   * `session/new`. The round is bounded and best-effort: on timeout or error
   * the connection stays usable, and a browser login URL published via the
   * `_codebuddy.ai/authUrl` extension notification is surfaced in the
   * warning so the user can complete an interactive login.
   */
  private ensureAuthenticated(): Promise<void> {
    if (this.authRound !== undefined) return this.authRound
    // Key-less auth uses the first advertised method — the server's default,
    // which is the method its cached-credential and interactive flows share.
    const method = this.authMethods?.[0]
    if (method === undefined) return Promise.resolve()
    this.pendingAuthUrl = undefined
    this.authRound = (async (): Promise<void> => {
      const attempt = this.conn.authenticate({ methodId: method.id })
      const settled = await Promise.race([
        attempt.then(
          () => ({ done: true as const, error: undefined }),
          (error: unknown) => ({ done: true as const, error }),
        ),
        sleep(this.spec.authTimeoutMs).then(() => ({ done: false as const, error: undefined })),
      ])
      if (settled.done) {
        if (settled.error !== undefined) {
          const message = settled.error instanceof Error ? settled.error.message : String(settled.error)
          this.spec.onWarn?.(`llm-acp: key-less authentication for "${this.spec.command}" failed: ${message}`)
        }
        return
      }
      const url = this.pendingAuthUrl
      this.spec.onWarn?.(
        `llm-acp: interactive authentication for "${this.spec.command}" is still pending after ${this.spec.authTimeoutMs}ms`
        + (url !== undefined ? ` — complete the login in a browser: ${url}` : ''),
      )
    })()
    return this.authRound
  }

  /**
   * Run one session operation bounded by `sessionTimeoutMs`. On failure —
   * once, and only while no `authenticate` round has run yet and the server
   * advertised auth methods — run {@link ensureAuthenticated} and retry.
   * This is the lazy-auth path: servers that accept env credentials or a
   * cached login never see an `authenticate` call at all.
   */
  private async withAuthRetry<T>(label: string, call: () => Promise<T>): Promise<T> {
    try {
      return await withTimeout(call(), this.spec.sessionTimeoutMs, label)
    } catch (error: unknown) {
      if (this.authRound !== undefined || this.authMethods === undefined || this.authMethods.length === 0) throw error
      const message = error instanceof Error ? error.message : String(error)
      this.spec.onWarn?.(`llm-acp: ${label} failed for "${this.spec.command}" (${message}); running one authenticate round then retrying`)
      await this.ensureAuthenticated()
      return await withTimeout(call(), this.spec.sessionTimeoutMs, label)
    }
  }

  /** Resolve one ACP permission request through its owning session. */
  private async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const entry = this.queues.get(params.sessionId)
    if (entry?.permissionRequester === undefined) {
      this.spec.onWarn?.('llm-acp: interactive permission request failed closed because no active harness approval requester was available')
      return this.rejectPermission(params)
    }
    let decision: AcpPermissionDecision
    try {
      const title = describePermissionToolCall(params.toolCall)
      this.spec.onWarn?.(`llm-acp: permission request toolCall=${JSON.stringify(params.toolCall)} -> title="${title}"`)
      decision = await entry.permissionRequester({ title, signal: entry.signal })
    } catch (error: unknown) {
      this.spec.onWarn?.(`llm-acp: permission request failed closed: ${error instanceof Error ? error.message : String(error)}`)
      return this.rejectPermission(params)
    }
    if (decision === 'cancel') return { outcome: { outcome: 'cancelled' } }
    if (decision === 'reject') return this.rejectPermission(params)
    const option = params.options.find(item => item.kind === 'allow_once')
    return option === undefined
      ? this.rejectPermission(params)
      : { outcome: { outcome: 'selected', optionId: option.optionId } }
  }

  /** Select an advertised rejection option, or cancel when none is available. */
  private rejectPermission(params: RequestPermissionRequest): RequestPermissionResponse {
    const option = params.options.find(item => item.kind === 'reject_once' || item.kind === 'reject_always')
    return option === undefined
      ? { outcome: { outcome: 'cancelled' } }
      : { outcome: { outcome: 'selected', optionId: option.optionId } }
  }

  /** Push an inbound session/update into the owning session's queue. */
  private enqueueUpdate(params: SessionNotification): void {
    const entry = this.queues.get(params.sessionId)
    if (entry === undefined) return
    const update = params.update
    if (update.sessionUpdate === 'agent_message_chunk') {
      entry.queue.push({ kind: 'text', text: acpContentText(update.content) })
    } else if (update.sessionUpdate === 'agent_thought_chunk') {
      entry.queue.push({ kind: 'reasoning', text: acpContentText(update.content) })
    } else if (update.sessionUpdate === 'tool_call') {
      // Tool calls are consumed but not surfaced as text; the ACP server
      // executes its own tools internally. Surface a progress note so the
      // user sees activity rather than a silent hang.
      const title = update.title ?? 'tool'
      entry.queue.push({ kind: 'progress', text: `[tool: ${title}]` })
    } else if (update.sessionUpdate === 'tool_call_update') {
      // Intermediate tool-call updates are consumed silently.
    } else if (update.sessionUpdate === 'plan') {
      // Plan updates are consumed but not surfaced.
    } else if (update.sessionUpdate === 'user_message_chunk') {
      // Echo of user input; consumed silently.
    }
    // Other update variants are consumed but not surfaced.
    this.signal(entry)
  }

  /**
   * Handle extension notifications from ACP servers that use non-standard
   * protocols (e.g. Devin's `_cognition.ai/*` notifications). These are
   * silently consumed to prevent SDK error logs, with progress notifications
   * surfaced to keep the user informed during long operations.
   */
  private handleExtNotification(method: string, params: Record<string, unknown>): void {
    // Devin sends `_cognition.ai/output` with a `message` field for logging.
    if (method === '_cognition.ai/output') {
      const message = typeof params.message === 'string' ? params.message : ''
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
      if (message.length > 0 && sessionId.length > 0) {
        const entry = this.queues.get(sessionId)
        if (entry !== undefined) {
          entry.queue.push({ kind: 'progress', text: message })
          this.signal(entry)
        }
      }
      return
    }
    // `_cognition.ai/thinking_complete` indicates the agent finished a
    // thinking block; no text payload to surface.
    if (method === '_cognition.ai/thinking_complete') return
    // `_cognition.ai/agent_stopped` indicates the agent finished its turn;
    // the terminal stopReason arrives via the `session/prompt` response.
    if (method === '_cognition.ai/agent_stopped') return
    // `_cognition.ai/mcp/serversChanged` indicates MCP server topology change.
    if (method === '_cognition.ai/mcp/serversChanged') return
    // `_cognition.ai/connection_retry` indicates a backend retry.
    if (method === '_cognition.ai/connection_retry') return
    // `_codebuddy.ai/authUrl` publishes the browser login URL for an
    // in-flight `authenticate` round (codebuddy). Captured so a key-less
    // interactive auth can surface it to the user instead of hanging silently.
    if (method === '_codebuddy.ai/authUrl') {
      const authUrl = typeof params.authUrl === 'string' ? params.authUrl : ''
      if (authUrl.length > 0) {
        this.pendingAuthUrl = authUrl
        this.spec.onAuthUrl?.(authUrl)
      }
      return
    }
    // Unknown extension notifications are silently consumed.
  }

  /**
   * Handle extension requests from ACP servers. Currently no extension
   * requests are expected; return an empty object to satisfy the protocol.
   */
  private handleExtMethod(method: string, _params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.spec.onWarn?.(`llm-acp: unhandled extension request: ${method}`)
    return Promise.resolve({})
  }

  /** Wake a consumer waiting on an empty queue. */
  private signal(entry: SessionQueue): void {
    const resolve = entry.resolve
    if (resolve !== undefined) {
      entry.resolve = undefined
      resolve()
    }
  }

  /** Drain the queue for one session, awaiting new updates when it is empty. */
  private async *drainQueue(sessionId: string): AsyncGenerator<QueuedUpdate> {
    const entry = this.queues.get(sessionId)
    if (entry === undefined) return
    while (true) {
      while (entry.queue.length > 0) {
        yield entry.queue.shift() as QueuedUpdate
      }
      if (entry.queue.length === 0) {
        await new Promise<void>((resolve) => { entry.resolve = resolve })
      }
    }
  }

  /**
   * Create a fresh ACP session for one prompt. The session is removed from the
   * connection's queue map after the generator completes or is abandoned.
   * @returns the remote session id.
   */
  async newSession(): Promise<string> {
    const session = await this.withAuthRetry('session/new', () =>
      this.conn.newSession({ cwd: this.spec.cwd, mcpServers: [] }))
    const returnedId: unknown = Reflect.get(session, 'sessionId')
    if (typeof returnedId !== 'string') {
      throw new Error('llm-acp: ACP server published a session without a string sessionId')
    }
    return returnedId
  }

  /**
   * Load an existing ACP session by id (`session/load`). Only available when
   * the agent advertises the `loadSession` capability. Returns the session's
   * current config options (models, modes, etc.) if the server publishes them.
   * @param sessionId - the remote session id to resume.
   * @returns the config options published by the server, or `undefined`.
   */
  async loadSession(sessionId: string): Promise<SessionConfigOption[] | undefined> {
    const session = await this.withAuthRetry('session/load', () =>
      this.conn.loadSession({ sessionId, cwd: this.spec.cwd, mcpServers: [] }))
    const configOptions: Array<SessionConfigOption> | null | undefined = Reflect.get(session, 'configOptions')
    return configOptions ?? undefined
  }

  /**
   * List existing ACP sessions (`session/list`). Only available when the agent
   * advertises the `session/list` capability. Returns `undefined` when the
   * agent does not support listing.
   * @param cursor - optional pagination cursor from a previous response.
   * @returns the session list and optional next cursor, or `undefined`.
   */
  async listSessions(cursor?: string): Promise<{ sessions: SessionInfo[]; nextCursor?: string } | undefined> {
    if (!this.supportsListSessions) return undefined
    const result = await withTimeout(
      this.conn.listSessions({ cursor: cursor ?? null }),
      this.spec.sessionTimeoutMs,
      'session/list',
    )
    const nextCursor = result.nextCursor
    return nextCursor !== null && nextCursor !== undefined
      ? { sessions: result.sessions, nextCursor }
      : { sessions: result.sessions }
  }

  /**
   * Delete an ACP session (`session/delete`). Only available when the agent
   * advertises the `session/delete` capability. Best-effort: errors are
   * swallowed because the session may already be gone.
   * @param sessionId - the remote session id to delete.
   * @returns `true` if the session was deleted, `false` if unsupported or failed.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    if (!this.supportsDeleteSession) return false
    try {
      await this.conn.deleteSession({ sessionId })
      return true
    } catch {
      return false
    }
  }

  /**
   * Probe the ACP server for its model catalog by creating a throwaway session
   * and reading the `configOptions` (category `model`) from the `session/new`
   * response. The probe session is closed immediately. Returns `undefined` when
   * the server publishes no model config option.
   * @returns the model entries, or `undefined` if none were advertised.
   */
  async discoverModels(): Promise<readonly { id: string; name: string }[] | undefined> {
    const options = await this.discoverConfigOptions()
    if (options === undefined) return undefined
    return this.extractModels(options)
  }

  /**
   * Probe the ACP server for its full config option catalog by creating a
   * throwaway session and reading `configOptions` from the `session/new`
   * response. The probe session is closed immediately. Returns `undefined`
   * when the server publishes no config options.
   * @returns all config options (models, modes, thought levels, etc.).
   */
  async discoverConfigOptions(): Promise<readonly SessionConfigOption[] | undefined> {
    await this.ready
    const session = await this.withAuthRetry('session/new', () =>
      this.conn.newSession({ cwd: this.spec.cwd, mcpServers: [] }))
    const configOptions: Array<SessionConfigOption> | null | undefined = Reflect.get(session, 'configOptions')
    const sessionId: unknown = Reflect.get(session, 'sessionId')
    if (typeof sessionId === 'string') {
      void this.conn.closeSession({ sessionId }).catch(() => { /* probe session best-effort close */ })
    }
    if (configOptions === undefined || configOptions === null) return undefined
    return configOptions
  }

  /** Extract model entries from a config option list (category `model`, type `select`).
   * Handles both flat option lists and grouped option lists per the ACP
   * `SessionConfigSelectOptions` union: a group entry carries its own
   * `options` array of leaf values, so flatten one level before collecting. */
  private extractModels(options: readonly SessionConfigOption[]): { id: string; name: string }[] | undefined {
    const modelOption = options.find(opt => opt.category === 'model' && opt.type === 'select')
    if (modelOption === undefined || modelOption.type !== 'select') return undefined
    const selectOptions = Array.isArray(modelOption.options) ? modelOption.options : []
    const models: { id: string; name: string }[] = []
    for (const opt of selectOptions) {
      if ('value' in opt && typeof opt.value === 'string' && typeof opt.name === 'string') {
        models.push({ id: opt.value, name: opt.name })
      } else if ('group' in opt && Array.isArray(opt.options)) {
        for (const leaf of opt.options) {
          if ('value' in leaf && typeof leaf.value === 'string' && typeof leaf.name === 'string') {
            models.push({ id: leaf.value, name: leaf.name })
          }
        }
      }
    }
    return models.length > 0 ? models : undefined
  }

  /**
   * Set the model for one ACP session via `session/set_config_option`. Best-effort:
   * if the server rejects the config id or value, the error surfaces from the
   * caller. Only called when the model differs from the server's current value.
   * @param sessionId - the remote session id from {@link AcpConnection.newSession}.
   * @param modelId - the model value id to select.
   */
  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    await withTimeout(
      this.conn.setSessionConfigOption({ sessionId, configId: 'model', value: modelId }),
      this.spec.sessionTimeoutMs,
      'session/set_config_option',
    )
  }

  /**
   * Send one user message to `sessionId` and yield streamed assistant updates
   * until the prompt call settles. The SDK v1 contract delivers the terminal
   * `stopReason` in the `session/prompt` response; streamed
   * `agent_message_chunk` updates arrive first via the sessionUpdate callback.
   * The generator emits text/reasoning chunks followed by a single terminal
   * `done` or `error` update, then removes the session queue.
   *
   * Cancellation: when `signal` aborts, a best-effort `session/cancel` is sent
   * and the generator ends after draining any already-queued updates.
   * @param sessionId - the remote session id from {@link AcpConnection.newSession}.
   * @param prompt - ACP content blocks forming the single user message.
   * @param signal - cancellation; abort triggers a best-effort ACP cancel.
   * @param permissionRequester - interactive requester captured for this prompt.
   */
  async *promptStream(
    sessionId: string,
    prompt: AcpContentBlock[],
    signal: AbortSignal,
    permissionRequester?: AcpPermissionRequester,
  ): AsyncGenerator<QueuedUpdate> {
    const entry: SessionQueue = { queue: [], resolve: undefined, permissionRequester, signal }
    this.queues.set(sessionId, entry)
    // On abort the server gets `session/cancel`; a non-cooperative server may
    // never answer it, so after CANCEL_SETTLE_GRACE_MS the pending drain is
    // force-settled as `cancelled` instead of waiting on a dead prompt.
    let cancelTimer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      void this.conn.cancel({ sessionId }).catch(() => { /* child gone */ })
      cancelTimer = setTimeout(() => {
        entry.queue.push({ kind: 'done', reason: 'cancelled' })
        this.signal(entry)
      }, CANCEL_SETTLE_GRACE_MS)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    // An already-aborted signal never fires 'abort' again — settle now.
    if (signal.aborted) onAbort()
    const settled = this.conn.prompt({ sessionId, prompt }).then(
      (result) => {
        const stopReason: StopReason | undefined = Reflect.get(result, 'stopReason')
        entry.queue.push({ kind: 'done', reason: stopReason ?? 'end_turn' })
        this.signal(entry)
      },
      (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err))
        entry.queue.push({ kind: 'error', error })
        this.signal(entry)
      },
    )
    void settled.catch(() => { /* handled in the then rejection arm */ })
    try {
      for await (const update of this.drainQueue(sessionId)) {
        yield update
        if (update.kind === 'done' || update.kind === 'error') break
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (cancelTimer !== undefined) clearTimeout(cancelTimer)
      this.queues.delete(sessionId)
    }
  }

  /**
   * Close one ACP session after a prompt completes. Best-effort: errors are
   * swallowed because the session may already be gone.
   * @param sessionId - the remote session id to close.
   */
  closeSession(sessionId: string): void {
    void this.conn.closeSession({ sessionId }).catch(() => { /* best-effort close */ })
  }

  /** Best-effort cancel of one in-flight session; unknown ids are no-ops. */
  cancel(sessionId: string): void {
    void this.conn.cancel({ sessionId }).catch(() => { /* child gone */ })
  }

  /** Idempotent disposal: runs the teardown ladder once and resolves at quiescence. */
  dispose(): Promise<void> {
    if (this.disposed) return this.disposal ?? Promise.resolve()
    this.disposed = true
    this.disposal = (async (): Promise<void> => {
      for (const [, entry] of this.queues) {
        entry.queue.push({ kind: 'error', error: new Error('llm-acp: connection disposed') })
        this.signal(entry)
      }
      this.queues.clear()
      await disposeAcpChild(this.child, this.spec.disposeEofGraceMs)
    })()
    return this.disposal
  }
}
