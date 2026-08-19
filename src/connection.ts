/**
 * Long-lived ACP client connection: spawns one external ACP server subprocess
 * at plugin load and drives it over JSON-RPC stdio. Each {@link AcpConnection.promptStream}
 * call creates a fresh ACP session, sends one user message, and yields the
 * streamed assistant text/reasoning chunks plus a terminal stop reason.
 *
 * The connection is deliberately stateless across prompts (no session reuse):
 * every prompt creates a new ACP session and sends the full conversation as a
 * single user message. This avoids cross-prompt state synchronization with the
 * remote agent and stays safe under compaction/fork, at the cost of remote KV
 * cache reuse.
 *
 * @module @deepseek-ai/dsh-llm-acp/connection
 */

import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent as AcpAgent,
  type Client,
  type ContentBlock as AcpContentBlock,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { PermissionPolicy } from './types.ts'

/** EOF grace for child flush and nested-process teardown; wider than the signal grace. */
export const DEFAULT_DISPOSE_EOF_GRACE_MS = 6_000

/** Default POSIX grace between SIGTERM and SIGKILL on dispose. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** One queued update delivered to a {@link AcpConnection.promptStream} consumer. */
type QueuedUpdate =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'progress'; text: string }
  | { kind: 'done'; reason: StopReason }
  | { kind: 'error'; error: Error }

/** Per-session update queue, fed by the SDK push callback and drained by generators. */
interface SessionQueue {
  queue: QueuedUpdate[]
  resolve: (() => void) | undefined
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

/** Resolved spawn spec for the long-lived ACP server process. */
export interface AcpConnectionSpec {
  /** The executable to spawn (the external ACP agent server). */
  command: string
  /** Arguments passed to {@link command}. */
  args: string[]
  /** Absolute working directory for the child process and its ACP sessions. */
  cwd: string
  /** How to auto-answer the child's permission prompts. */
  permission: PermissionPolicy
  /** Extra environment variables merged on top of the scrubbed parent env. */
  env: Record<string, string>
  /** Grace (ms) for the child's EOF-driven quiesce on dispose. */
  disposeEofGraceMs: number
  /** Termination-escalation grace (ms) after SIGTERM before SIGKILL. */
  disposeGraceMs: number
  /** Spawn function from the subprocess seam (`ctx.subprocess.spawn`). */
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Sink for connection-level warnings (wired to `ctx.logger.warn`). */
  onWarn?: (message: string) => void
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
        if (spec.permission === 'allow') {
          const allow = params.options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always')
          if (allow !== undefined) {
            return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } })
          }
        }
        return Promise.resolve({ outcome: { outcome: 'cancelled' } })
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
    this.readyPromise = this.initialize()
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
    await Promise.race([
      this.conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
      spawnFailed,
    ])
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
    const session = await this.conn.newSession({ cwd: this.spec.cwd, mcpServers: [] })
    const returnedId: unknown = Reflect.get(session, 'sessionId')
    if (typeof returnedId !== 'string') {
      throw new Error('llm-acp: ACP server published a session without a string sessionId')
    }
    return returnedId
  }

  /**
   * Probe the ACP server for its model catalog by creating a throwaway session
   * and reading the `configOptions` (category `model`) from the `session/new`
   * response. The probe session is closed immediately. Returns `undefined` when
   * the server publishes no model config option.
   * @returns the model entries, or `undefined` if none were advertised.
   */
  async discoverModels(): Promise<readonly { id: string; name: string }[] | undefined> {
    await this.ready
    const session = await this.conn.newSession({ cwd: this.spec.cwd, mcpServers: [] })
    const configOptions: Array<SessionConfigOption> | null | undefined = Reflect.get(session, 'configOptions')
    const sessionId: unknown = Reflect.get(session, 'sessionId')
    if (typeof sessionId === 'string') {
      void this.conn.closeSession({ sessionId }).catch(() => { /* probe session best-effort close */ })
    }
    if (configOptions === undefined || configOptions === null) return undefined
    const modelOption = configOptions.find(opt => opt.category === 'model' && opt.type === 'select')
    if (modelOption === undefined || modelOption.type !== 'select') return undefined
    const options = Array.isArray(modelOption.options) ? modelOption.options : []
    const models: { id: string; name: string }[] = []
    for (const opt of options) {
      if ('value' in opt && typeof opt.value === 'string' && typeof opt.name === 'string') {
        models.push({ id: opt.value, name: opt.name })
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
    await this.conn.setSessionConfigOption({ sessionId, configId: 'model', value: modelId })
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
   */
  async *promptStream(
    sessionId: string,
    prompt: AcpContentBlock[],
    signal: AbortSignal,
  ): AsyncGenerator<QueuedUpdate> {
    const entry: SessionQueue = { queue: [], resolve: undefined }
    this.queues.set(sessionId, entry)
    const onAbort = (): void => {
      void this.conn.cancel({ sessionId }).catch(() => { /* child gone */ })
    }
    signal.addEventListener('abort', onAbort, { once: true })
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
