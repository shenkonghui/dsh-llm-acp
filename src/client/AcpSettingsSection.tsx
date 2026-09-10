/** ACP Servers settings section: registry browser and configured-server list. */

import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { AcpSettingsLocaleKey } from './locales.ts'
import css from './AcpSettingsSection.module.css'

/** One ACP registry agent entry. */
export interface AcpRegistryAgent {
  id: string
  name: string
  version: string
  description: string
  repository?: string
  website?: string
  authors?: string[]
  license?: string
  distribution: {
    npx?: { package: string; args?: string[] }
    binary?: Record<string, { archive: string; cmd: string; args?: string[] }>
    uvx?: { package: string; args?: string[] }
  }
}

/** One configured ACP server from settings. */
export interface AcpServerEntry {
  command: string
  args: string[]
  name: string
  env?: Record<string, string>
  models?: string[]
  customModels?: { id: string; name: string }[]
}

/** Wire view of one registered settings namespace (the fields this section reads). */
interface AcpNamespaceView {
  ns: string
  value: unknown
  revision: number
}

/** One path-addressed settings edit (the wire op this section sends). */
export type AcpSettingsPathOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** Wire result of one Remote call: the ok branch carries the value, the failure branch the message. */
interface AcpRemoteResult<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly message: string }
}

/**
 * The narrow Remote face this section calls, adapted from `ctx.remote` by the
 * apply closure so the component stays free of transport types.
 */
export interface AcpSettingsSectionApi {
  describeSettings(): Promise<AcpRemoteResult<{ namespaces: readonly AcpNamespaceView[] }>>
  mutateSettings(
    ns: string,
    ops: readonly AcpSettingsPathOp[],
    expectedRevision: number | undefined,
  ): Promise<AcpRemoteResult<unknown>>
  discoverModels(settingsNs: string, provider: string): Promise<AcpRemoteResult<readonly DiscoveredModel[]>>
}

/** Injected dependencies from the apply closure. */
export interface AcpSettingsSectionInjected {
  /** The ACP registry data (bundled at build time). */
  registry: { version: string; agents: AcpRegistryAgent[] }
  /** Wire face for settings reads/writes and model catalog discovery. */
  api: AcpSettingsSectionApi
  /** Settings namespace for ACP servers. */
  settingsNs: string
}

/** Props the renderer binds for the section. */
export type AcpSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.acp'>
  & InjectFace<AcpSettingsSectionInjected>

/** Detect the current platform for binary distribution selection. */
function currentPlatform(): string {
  const platform = typeof navigator !== 'undefined' ? navigator.platform : ''
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const isMac = /mac/i.test(platform)
  const isWin = /win/i.test(platform)
  const isArm = /arm|aarch64/i.test(ua) || /arm|aarch64/i.test(platform)
  if (isMac) return isArm ? 'darwin-aarch64' : 'darwin-x86_64'
  if (isWin) return isArm ? 'windows-aarch64' : 'windows-x86_64'
  return isArm ? 'linux-aarch64' : 'linux-x86_64'
}

/** Derive command and args from a registry agent's distribution.
 * For binary distributions, the registry's `cmd` is a path relative to the
 * extracted archive directory (e.g. `./bin/devin`). Since the user typically
 * has the agent binary installed in PATH, extract the basename and use it
 * directly. */
function deriveCommand(agent: AcpRegistryAgent): { command: string; args: string[] } | undefined {
  const dist = agent.distribution
  if (dist.npx) {
    return { command: 'npx', args: ['-y', dist.npx.package, ...(dist.npx.args ?? [])] }
  }
  if (dist.uvx) {
    return { command: 'uvx', args: [dist.uvx.package, ...(dist.uvx.args ?? [])] }
  }
  if (dist.binary) {
    const plat = currentPlatform()
    const entry = dist.binary[plat] ?? dist.binary[Object.keys(dist.binary)[0] ?? '']
    if (entry === undefined) return undefined
    // The registry `cmd` is relative to the archive's extraction directory
    // (e.g. `./bin/devin`). Use the basename so the command resolves through
    // PATH, where the user's installed binary lives.
    const cmd = entry.cmd.replace(/^.*\//, '')
    return { command: cmd, args: entry.args ?? [] }
  }
  return undefined
}

/** Derive the bin name an npm package installs (heuristic: last path segment
 * of the package name, without scope or version). `@scope/name@ver` → `name`,
 * `name@ver` → `name`. Used to probe PATH before falling back to `npx -y`. */
function npmBinName(pkg: string): string | undefined {
  if (pkg.startsWith('@')) {
    const scoped = pkg.split('@', 2)[1]
    return scoped?.split('/').pop()
  }
  return pkg.split('@')[0]
}

/** Probe the host PATH for `bin` via the `acp-resolve-<bin>` discovery route.
 * Returns the absolute path when found, `undefined` otherwise. */
async function resolveBinInPath(
  api: AcpSettingsSectionInjected['api'],
  settingsNs: string,
  bin: string,
): Promise<string | undefined> {
  try {
    const response = await api.discoverModels(settingsNs, `acp-resolve-${bin}`)
    if (!response.ok) return undefined
    return (response.value ?? [])[0]?.id
  } catch {
    return undefined
  }
}

/** Distribution type label for display. */
function distributionType(agent: AcpRegistryAgent): string {
  const dist = agent.distribution
  if (dist.npx) return 'npx'
  if (dist.uvx) return 'uvx'
  if (dist.binary) return 'binary'
  return 'unknown'
}

/** One discovered model from the host model catalog. */
interface DiscoveredModel {
  id: string
  name: string
  /** Carries the ACP protocol version on the `acp-info-<id>` route. */
  contextWindow?: number
}

/** Live server identity published by the ACP `initialize` response. */
interface ServerInfo {
  /** Agent name from `agentInfo.name`. */
  agentName: string
  /** Agent version from `agentInfo.version`. */
  agentVersion: string
  /** Negotiated ACP protocol version. */
  protocolVersion?: number
}

/** Load the full discovered model catalog for one ACP provider route.
 * Uses model discovery (not the filtered catalog) so the reply is the
 * unfiltered set — `listModels` already applies the server's `enabledModels`
 * selection, which would hide unselected models from the multi-select editor. */
async function loadProviderModels(
  api: AcpSettingsSectionInjected['api'],
  settingsNs: string,
  providerRoute: string,
): Promise<DiscoveredModel[]> {
  try {
    const response = await api.discoverModels(settingsNs, providerRoute)
    if (!response.ok) return []
    return (response.value ?? []).map(m => ({ id: m.id, name: m.name ?? m.id }))
  } catch {
    return []
  }
}

/** Load the live server identity (agent name/version, ACP protocol version)
 * via the `acp-info-<id>` discovery route. Returns `undefined` when the
 * server has not yet completed `initialize` or omits `agentInfo`. */
async function loadServerInfo(
  api: AcpSettingsSectionInjected['api'],
  settingsNs: string,
  serverId: string,
): Promise<ServerInfo | undefined> {
  try {
    const response = await api.discoverModels(settingsNs, `acp-info-${serverId}`)
    if (!response.ok) return undefined
    const entry = (response.value ?? [])[0]
    // The host reports failures as `{ id: 'error', name: <reason> }`; the
    // version label treats those as "no info yet".
    if (entry === undefined || entry.id === 'error') return undefined
    const protocolVersion = entry.contextWindow
    return {
      agentName: entry.id,
      agentVersion: entry.name ?? '',
      ...(protocolVersion === undefined ? {} : { protocolVersion }),
    }
  } catch {
    return undefined
  }
}

/** Load the pending interactive-auth browser login URL for one server via the
 * `acp-auth-<id>` discovery route. Returns `undefined` when no login is
 * pending or the host runs a stale build without the route. */
async function loadAuthUrl(
  api: AcpSettingsSectionInjected['api'],
  settingsNs: string,
  serverId: string,
): Promise<string | undefined> {
  try {
    const response = await api.discoverModels(settingsNs, `acp-auth-${serverId}`)
    if (!response.ok) return undefined
    const entry = (response.value ?? [])[0]
    return entry !== undefined && entry.id === 'auth' && entry.name.length > 0 ? entry.name : undefined
  } catch {
    return undefined
  }
}

/** Compact version label for a server card: live agent version first, then
 * the registry version as a fallback when the server has not reported yet. */
function serverVersionLabel(
  info: ServerInfo | undefined,
  registryAgent: AcpRegistryAgent | undefined,
): string | undefined {
  if (info !== undefined && info.agentVersion.length > 0) return `v${info.agentVersion}`
  if (registryAgent !== undefined) return `v${registryAgent.version}`
  return undefined
}

/** Draft environment variable row for the editor. */
interface EnvDraftRow {
  key: string
  value: string
}

/** Draft custom model row for the editor. */
interface CustomModelDraftRow {
  id: string
  name: string
}

/** Run state of one test step. */
interface TestStepState {
  status: 'running' | 'pass' | 'fail'
  detail?: string
}

const TEST_STEP_IDS = ['handshake', 'models', 'message'] as const
type TestStepId = typeof TEST_STEP_IDS[number]

/** Convert an env record to editable draft rows. */
function envToDrafts(env: Record<string, string> | undefined): EnvDraftRow[] {
  if (env === undefined) return []
  return Object.entries(env).map(([key, value]) => ({ key, value }))
}

/** Convert editable draft rows back to an env record, skipping empty keys. */
function draftsToEnv(rows: EnvDraftRow[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key.length > 0) env[key] = row.value
  }
  return env
}

/** Draft for the custom-agent form. */
interface CustomAgentDraft {
  id: string
  name: string
  command: string
  args: string
  env: EnvDraftRow[]
}

/** Empty custom-agent draft. */
function emptyCustomDraft(): CustomAgentDraft {
  return { id: '', name: '', command: '', args: '', env: [] }
}

/** Parse a space-separated args string into an array, handling simple quoting. */
function parseArgs(args: string): string[] {
  const trimmed = args.trim()
  if (trimmed.length === 0) return []
  // Simple split on whitespace; does not handle escaped quotes, but covers
  // the common case (e.g. `-y @scope/pkg --flag value`).
  return trimmed.split(/\s+/)
}

/** Render the ACP Servers settings section. */
export function AcpSettingsSection(props: AcpSettingsSectionProps) {
  const { t, registry, api, settingsNs } = props
  const [tab, setTab] = useState<'registry' | 'servers'>('registry')
  const [search, setSearch] = useState('')
  const [servers, setServers] = useState<Record<string, AcpServerEntry>>({})
  const [loading, setLoading] = useState(true)
  const [addingId, setAddingId] = useState<string | undefined>()
  const [removingId, setRemovingId] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [expandedId, setExpandedId] = useState<string | undefined>()
  const [envDrafts, setEnvDrafts] = useState<Record<string, EnvDraftRow[]>>({})
  const [modelDrafts, setModelDrafts] = useState<Record<string, string[]>>({})
  const [customModelDrafts, setCustomModelDrafts] = useState<Record<string, CustomModelDraftRow[]>>({})
  const [discoveredModels, setDiscoveredModels] = useState<Record<string, DiscoveredModel[]>>({})
  const [modelsLoading, setModelsLoading] = useState<Set<string>>(new Set())
  const [modelSearch, setModelSearch] = useState<Record<string, string>>({})
  const [savingId, setSavingId] = useState<string | undefined>()
  const [serverInfo, setServerInfo] = useState<Record<string, ServerInfo | undefined>>({})
  const [authUrls, setAuthUrls] = useState<Record<string, string | undefined>>({})
  const [testServer, setTestServer] = useState<{ id: string; name: string } | undefined>()
  const [testSteps, setTestSteps] = useState<Record<TestStepId, TestStepState>>({
    handshake: { status: 'running' },
    models: { status: 'running' },
    message: { status: 'running' },
  })
  const [showCustomForm, setShowCustomForm] = useState(false)
  const [customDraft, setCustomDraft] = useState<CustomAgentDraft>(emptyCustomDraft())
  const [customSaving, setCustomSaving] = useState(false)
  const [customError, setCustomError] = useState<string | undefined>()

  /** Revision of the `llm-acp` namespace at the last read; sent back on writes
   * so a stale editor is refused instead of silently overwriting. */
  const revisionRef = useRef<number | undefined>(undefined)

  /** Load current servers from settings. */
  const loadServers = async (): Promise<void> => {
    try {
      const response = await api.describeSettings()
      if (response.ok) {
        const ns = response.value?.namespaces.find(v => v.ns === settingsNs)
        if (ns !== undefined) {
          revisionRef.current = ns.revision
          const data = ns.value as { servers?: Record<string, AcpServerEntry> }
          const next = data?.servers ?? {}
          setServers(next)
          // Best-effort: refresh live server version info. The `acp-info-<id>`
          // route reads the cached `initialize` identity (no session), so the
          // parallel fetches are cheap; each resolves independently and may
          // stay `undefined` until the connection finishes initializing.
          for (const id of Object.keys(next)) {
            void loadServerInfo(api, settingsNs, id).then(info => {
              setServerInfo(prev => (prev[id] === info ? prev : { ...prev, [id]: info }))
            })
            void loadAuthUrl(api, settingsNs, id).then(url => {
              setAuthUrls(prev => (prev[id] === url ? prev : { ...prev, [id]: url }))
            })
          }
        }
      }
    } catch {
      // Settings section may not exist yet — that's the empty state.
      setServers({})
    }
    setLoading(false)
  }

  useEffect(() => { void loadServers() }, [])

  /** Add a registry agent as a configured server. For `npx -y <pkg>` agents,
   * probe the host PATH first and store the local bin directly when present,
   * so the UI shows and the spawn uses the installed binary without an npm
   * fetch on every start. */
  const addServer = async (agent: AcpRegistryAgent): Promise<void> => {
    const cmd = deriveCommand(agent)
    if (cmd === undefined) return
    setAddingId(agent.id)
    setError(undefined)
    try {
      let command = cmd.command
      let args = cmd.args
      if (command === 'npx' && agent.distribution.npx !== undefined) {
        const bin = npmBinName(agent.distribution.npx.package)
        if (bin !== undefined) {
          const resolved = await resolveBinInPath(api, settingsNs, bin)
          if (resolved !== undefined) {
            command = resolved
            args = agent.distribution.npx.args ?? []
          }
        }
      }
      const serverEntry = { command, args, name: agent.name, env: {}, models: [] }
      const response = await api.mutateSettings(
        settingsNs,
        [{ op: 'set', path: ['servers', agent.id], value: serverEntry }],
        revisionRef.current,
      )
      if (!response.ok) {
        setError(response.error?.message ?? 'unknown error')
      } else {
        await loadServers()
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setAddingId(undefined)
  }

  /** Add a custom ACP agent from the user-filled form. Validates the ID
   * (required, not already in use) and command (required), then writes the
   * server entry to settings — same shape as a registry agent. */
  const addCustomServer = async (): Promise<void> => {
    setCustomError(undefined)
    const id = customDraft.id.trim()
    const command = customDraft.command.trim()
    const name = customDraft.name.trim() || id
    if (id.length === 0) { setCustomError(t('customIdRequired')); return }
    if (command.length === 0) { setCustomError(t('customCommandRequired')); return }
    if (servers[id] !== undefined) { setCustomError(t('customIdExists')); return }
    setCustomSaving(true)
    try {
      const serverEntry: AcpServerEntry = {
        command,
        args: parseArgs(customDraft.args),
        name,
        env: draftsToEnv(customDraft.env),
        models: [],
      }
      const response = await api.mutateSettings(
        settingsNs,
        [{ op: 'set', path: ['servers', id], value: serverEntry }],
        revisionRef.current,
      )
      if (!response.ok) {
        setCustomError(response.error?.message ?? 'unknown error')
      } else {
        setShowCustomForm(false)
        setCustomDraft(emptyCustomDraft())
        await loadServers()
      }
    } catch (err: unknown) {
      setCustomError(err instanceof Error ? err.message : String(err))
    }
    setCustomSaving(false)
  }

  /** Update one custom-form env draft row. */
  const updateCustomEnvRow = (index: number, patch: Partial<EnvDraftRow>): void => {
    setCustomDraft(prev => {
      const rows = [...prev.env]
      const row = rows[index]
      if (row === undefined) return prev
      rows[index] = { ...row, ...patch }
      return { ...prev, env: rows }
    })
  }

  /** Add an empty env row to the custom form. */
  const addCustomEnvRow = (): void => {
    setCustomDraft(prev => ({ ...prev, env: [...prev.env, { key: '', value: '' }] }))
  }

  /** Remove one env row from the custom form. */
  const removeCustomEnvRow = (index: number): void => {
    setCustomDraft(prev => {
      const rows = [...prev.env]
      rows.splice(index, 1)
      return { ...prev, env: rows }
    })
  }

  /** Remove a configured server. */
  const removeServer = async (id: string): Promise<void> => {
    setRemovingId(id)
    setError(undefined)
    try {
      const response = await api.mutateSettings(
        settingsNs,
        [{ op: 'unset', path: ['servers', id] }],
        revisionRef.current,
      )
      if (!response.ok) {
        setError(response.error?.message ?? 'unknown error')
      } else {
        await loadServers()
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setRemovingId(undefined)
  }

  /** Expand a server card, loading drafts and discovered models. */
  const expandServer = async (id: string): Promise<void> => {
    if (expandedId === id) {
      setExpandedId(undefined)
      return
    }
    const server = servers[id]
    setExpandedId(id)
    if (server !== undefined) {
      setEnvDrafts(prev => ({ ...prev, [id]: envToDrafts(server.env) }))
      setModelDrafts(prev => ({ ...prev, [id]: server.models ?? [] }))
      setCustomModelDrafts(prev => ({
        ...prev,
        [id]: (server.customModels ?? []).map(m => ({ id: m.id, name: m.name })),
      }))
    }
    // Fetch discovered models and live server info for this provider route.
    setModelsLoading(prev => new Set(prev).add(id))
    const [models, info, authUrl] = await Promise.all([
      loadProviderModels(api, settingsNs, `acp-${id}`),
      loadServerInfo(api, settingsNs, id),
      loadAuthUrl(api, settingsNs, id),
    ])
    setDiscoveredModels(prev => ({ ...prev, [id]: models }))
    setServerInfo(prev => (prev[id] === info ? prev : { ...prev, [id]: info }))
    setAuthUrls(prev => (prev[id] === authUrl ? prev : { ...prev, [id]: authUrl }))
    setModelsLoading(prev => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  /** Re-fetch the model catalog and live server info for one server. */
  const refreshModels = async (id: string): Promise<void> => {
    setModelsLoading(prev => new Set(prev).add(id))
    const [models, info, authUrl] = await Promise.all([
      loadProviderModels(api, settingsNs, `acp-${id}`),
      loadServerInfo(api, settingsNs, id),
      loadAuthUrl(api, settingsNs, id),
    ])
    setDiscoveredModels(prev => ({ ...prev, [id]: models }))
    setServerInfo(prev => (prev[id] === info ? prev : { ...prev, [id]: info }))
    setAuthUrls(prev => (prev[id] === authUrl ? prev : { ...prev, [id]: authUrl }))
    setModelsLoading(prev => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  /** Save the editable drafts for one server to settings. */
  const saveServerConfig = async (id: string): Promise<void> => {
    setSavingId(id)
    setError(undefined)
    try {
      const env = draftsToEnv(envDrafts[id] ?? [])
      const models = modelDrafts[id] ?? []
      const customModels = (customModelDrafts[id] ?? [])
        .filter(m => m.id.trim().length > 0)
        .map(m => ({ id: m.id.trim(), name: m.name.trim() }))
      const response = await api.mutateSettings(
        settingsNs,
        [
          { op: 'set', path: ['servers', id, 'env'], value: env },
          { op: 'set', path: ['servers', id, 'models'], value: models },
          { op: 'set', path: ['servers', id, 'customModels'], value: customModels },
        ],
        revisionRef.current,
      )
      if (!response.ok) {
        setError(response.error?.message ?? 'unknown error')
      } else {
        await loadServers()
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setSavingId(undefined)
  }

  /** Update one test step's state. */
  const setTestStep = (step: TestStepId, state: TestStepState): void => {
    setTestSteps(prev => ({ ...prev, [step]: state }))
  }

  /** Run the end-to-end server test: handshake → model catalog → probe prompt.
   * Each step runs only when the previous one passed; failures short-circuit
   * the remaining steps so a dead server doesn't burn three timeouts. Every
   * failure surfaces the underlying error message in its detail line. */
  const runTest = async (id: string, name: string): Promise<void> => {
    setTestServer({ id, name })
    setTestSteps({
      handshake: { status: 'running' },
      models: { status: 'running' },
      message: { status: 'running' },
    })

    /** Call one discovery route, converting thrown transport errors into the
     * failure branch so every step can show a concrete reason. */
    const rawDiscover = async (provider: string): Promise<AcpRemoteResult<readonly DiscoveredModel[]>> => {
      try {
        return await api.discoverModels(settingsNs, provider)
      } catch (err: unknown) {
        return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } }
      }
    }

    // Step 1: handshake — the `acp-info-<id>` route reads the cached
    // `initialize` identity and reports the concrete failure reason.
    const infoRes = await rawDiscover(`acp-info-${id}`)
    const infoEntry = (infoRes.ok ? infoRes.value ?? [] : [])[0]
    if (infoRes.error !== undefined) {
      setTestStep('handshake', { status: 'fail', detail: infoRes.error.message })
      setTestStep('models', { status: 'fail', detail: t('testSkipped') })
      setTestStep('message', { status: 'fail', detail: t('testSkipped') })
      return
    }
    if (infoEntry === undefined || infoEntry.id === 'error') {
      setTestStep('handshake', {
        status: 'fail',
        detail: infoEntry?.name ?? t('testHandshakeFail'),
      })
      setTestStep('models', { status: 'fail', detail: t('testSkipped') })
      setTestStep('message', { status: 'fail', detail: t('testSkipped') })
      return
    }
    // `id: 'unknown'` means initialize succeeded but agentInfo was missing
    // (the SDK silently drops invalid agentInfo). The server may still be
    // functional, so the handshake passes with a warning; the detail carries
    // the full diagnostic from the host.
    if (infoEntry.id === 'unknown') {
      setTestStep('handshake', {
        status: 'pass',
        detail: infoEntry.name,
      })
    } else {
      setTestStep('handshake', {
        status: 'pass',
        detail: `${infoEntry.id} v${infoEntry.name}`
          + (infoEntry.contextWindow !== undefined ? ` · ${t('serverProtocol')}: ${infoEntry.contextWindow}` : ''),
      })
    }

    // Step 2: model catalog via the provider route.
    const modelsRes = await rawDiscover(`acp-${id}`)
    const models = (modelsRes.ok ? modelsRes.value ?? [] : []).map(m => ({ id: m.id, name: m.name ?? m.id }))
    if (!modelsRes.ok) {
      setTestStep('models', {
        status: 'fail',
        detail: modelsRes.error?.message ?? t('testNoModels'),
      })
      setTestStep('message', { status: 'fail', detail: t('testSkipped') })
      return
    }
    if (models.length === 0) {
      setTestStep('models', {
        status: 'fail',
        detail: `${t('testNoModels')} — the server connected but returned an empty model catalog; the agent may not have discovered any models yet, or it may manage models internally`,
      })
      setTestStep('message', { status: 'fail', detail: t('testSkipped') })
      return
    }
    setTestStep('models', {
      status: 'pass',
      detail: `${models.length} · ${models.slice(0, 5).map(m => m.id).join(', ')}${models.length > 5 ? '…' : ''}`,
    })

    // Step 3: end-to-end prompt via the `acp-test-<id>` route. An empty reply
    // means the host never hit the route — typically a stale host build.
    const msgRes = await rawDiscover(`acp-test-${id}`)
    const entry = (msgRes.ok ? msgRes.value ?? [] : [])[0]
    if (entry?.id === 'ok') {
      setTestStep('message', { status: 'pass', detail: entry.name })
    } else if (entry?.id === 'error') {
      setTestStep('message', {
        status: 'fail',
        detail: entry.name,
      })
    } else {
      setTestStep('message', {
        status: 'fail',
        detail: msgRes.error?.message ?? t('testNoResponse'),
      })
    }
  }

  /** Update one env draft row. */
  const updateEnvRow = (serverId: string, index: number, patch: Partial<EnvDraftRow>): void => {
    setEnvDrafts(prev => {
      const rows = [...(prev[serverId] ?? [])]
      const row = rows[index]
      if (row === undefined) return prev
      rows[index] = { ...row, ...patch }
      return { ...prev, [serverId]: rows }
    })
  }

  /** Add an empty env draft row. */
  const addEnvRow = (serverId: string): void => {
    setEnvDrafts(prev => ({
      ...prev,
      [serverId]: [...(prev[serverId] ?? []), { key: '', value: '' }],
    }))
  }

  /** Remove one env draft row. */
  const removeEnvRow = (serverId: string, index: number): void => {
    setEnvDrafts(prev => {
      const rows = [...(prev[serverId] ?? [])]
      rows.splice(index, 1)
      return { ...prev, [serverId]: rows }
    })
  }

  /** Toggle one model in the model draft selection. */
  const toggleModel = (serverId: string, modelId: string): void => {
    setModelDrafts(prev => {
      const current = new Set(prev[serverId] ?? [])
      if (current.has(modelId)) {
        current.delete(modelId)
      } else {
        current.add(modelId)
      }
      return { ...prev, [serverId]: [...current] }
    })
  }

  /** Update one custom model draft row. */
  const updateCustomModelRow = (serverId: string, index: number, patch: Partial<CustomModelDraftRow>): void => {
    setCustomModelDrafts(prev => {
      const rows = [...(prev[serverId] ?? [])]
      const row = rows[index]
      if (row === undefined) return prev
      rows[index] = { ...row, ...patch }
      return { ...prev, [serverId]: rows }
    })
  }

  /** Add an empty custom model draft row. */
  const addCustomModelRow = (serverId: string): void => {
    setCustomModelDrafts(prev => ({
      ...prev,
      [serverId]: [...(prev[serverId] ?? []), { id: '', name: '' }],
    }))
  }

  /** Remove one custom model draft row. */
  const removeCustomModelRow = (serverId: string, index: number): void => {
    setCustomModelDrafts(prev => {
      const rows = [...(prev[serverId] ?? [])]
      rows.splice(index, 1)
      return { ...prev, [serverId]: rows }
    })
  }

  const filteredAgents = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (q === '') return registry.agents
    return registry.agents.filter((a: AcpRegistryAgent) =>
      a.name.toLowerCase().includes(q) ||
      a.id.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q),
    )
  }, [registry.agents, search])

  const serverList = Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))

  return (
    <div className={css.section}>
      <h2 className={css.heading}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>

      <div className={css.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          className={css.tab}
          aria-selected={tab === 'registry'}
          data-active={tab === 'registry' ? 'true' : undefined}
          onClick={() => { setTab('registry') }}
        >
          {t('registryTab')}
        </button>
        <button
          type="button"
          role="tab"
          className={css.tab}
          aria-selected={tab === 'servers'}
          data-active={tab === 'servers' ? 'true' : undefined}
          onClick={() => { setTab('servers') }}
        >
          {t('serversTab')}
        </button>
      </div>

      {error !== undefined && <div className={css.error}>{error}</div>}

      {tab === 'registry' && (
        <div className={css.panel}>
          <div className={css.registryToolbar}>
            <input
              type="search"
              className={css.search}
              placeholder={t('registrySearch')}
              value={search}
              onChange={e => { setSearch(e.target.value) }}
            />
            <button
              type="button"
              className={css.customAddButton}
              onClick={() => { setCustomError(undefined); setShowCustomForm(true) }}
            >
              + {t('customAdd')}
            </button>
          </div>
          {filteredAgents.length === 0 ? (
            <p className={css.empty}>{t('registryEmpty')}</p>
          ) : (
            <div className={css.list}>
              {filteredAgents.map((agent: AcpRegistryAgent) => {
                const isAdded = servers[agent.id] !== undefined
                const distType = distributionType(agent)
                return (
                  <div key={agent.id} className={css.agentCard}>
                    <div className={css.agentInfo}>
                      <p className={css.agentName}>{agent.name}</p>
                      <p className={css.agentDesc}>{agent.description}</p>
                      <div className={css.agentMeta}>
                        <span className={css.distBadge}>{distType}</span>
                        <span>{t('version')}: {agent.version}</span>
                        {agent.authors !== undefined && agent.authors.length > 0 && (
                          <span>{t('authors')}: {agent.authors.join(', ')}</span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={css.addButton}
                      disabled={isAdded || addingId === agent.id}
                      onClick={() => { void addServer(agent) }}
                    >
                      {isAdded ? t('added') : addingId === agent.id ? t('adding') : t('add')}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'servers' && (
        <div className={css.panel}>
          {!loading && serverList.length === 0 ? (
            <p className={css.empty}>{t('noServers')}</p>
          ) : (
            <div className={css.list}>
              {serverList.map(([id, server]) => {
                const isExpanded = expandedId === id
                const rows = envDrafts[id] ?? []
                const selectedModels = modelDrafts[id] ?? []
                const models = discoveredModels[id] ?? []
                const isLoadingModels = modelsLoading.has(id)
                const info = serverInfo[id]
                const registryAgent = registry.agents.find(a => a.id === id)
                const versionLabel = serverVersionLabel(info, registryAgent)
                const authUrl = authUrls[id]
                return (
                  <div key={id} className={css.serverCardBlock}>
                    {authUrl !== undefined && (
                      <div className={css.authBanner}>
                        <span>{t('authPending')}</span>
                        <a
                          href={authUrl}
                          target="_blank"
                          rel="noreferrer"
                          className={css.authLink}
                        >
                          {t('authOpen')}
                        </a>
                      </div>
                    )}
                    <div className={css.serverCard}>
                      <div className={css.agentInfo}>
                        <p className={css.agentName}>{server.name}</p>
                        <p className={css.serverCommand}>
                          {t('serverCommand')}: {server.command} {server.args.join(' ')}
                        </p>
                        <div className={css.agentMeta}>
                          <span>acp-{id}</span>
                          {versionLabel !== undefined && (
                            <span>{t('serverVersion')}: {versionLabel}</span>
                          )}
                        </div>
                      </div>
                      <div className={css.cardActions}>
                        <button
                          type="button"
                          className={css.editButton}
                          onClick={() => { void runTest(id, server.name) }}
                        >
                          {t('test')}
                        </button>
                        <button
                          type="button"
                          className={css.editButton}
                          onClick={() => { void expandServer(id) }}
                        >
                          {isExpanded ? t('collapse') : t('edit')}
                        </button>
                        <button
                          type="button"
                          className={css.removeButton}
                          disabled={removingId === id}
                          onClick={() => {
                            if (window.confirm(t('removeConfirm'))) {
                              void removeServer(id)
                            }
                          }}
                        >
                          {removingId === id ? '…' : t('remove')}
                        </button>
                      </div>
                    </div>
                    {isExpanded && (
                      <div className={css.serverDetail}>
                        <div className={css.detailSection}>
                          <p className={css.detailHeading}>{t('serverVersion')}</p>
                          {info !== undefined ? (
                            <div className={css.versionInfo}>
                              <span className={css.versionName}>{info.agentName}</span>
                              <span className={css.versionTag}>v{info.agentVersion}</span>
                              {info.protocolVersion !== undefined && (
                                <span className={css.versionTag}>
                                  {t('serverProtocol')}: {info.protocolVersion}
                                </span>
                              )}
                            </div>
                          ) : registryAgent !== undefined ? (
                            <div className={css.versionInfo}>
                              <span className={css.versionName}>{registryAgent.name}</span>
                              <span className={css.versionTag}>v{registryAgent.version}</span>
                            </div>
                          ) : (
                            <p className={css.emptyInline}>{t('serverVersionUnknown')}</p>
                          )}
                        </div>

                        <div className={css.detailSection}>
                          <p className={css.detailHeading}>{t('envVars')}</p>
                          <p className={css.detailHint}>{t('envVarsHint')}</p>
                          {rows.length === 0 ? (
                            <p className={css.emptyInline}>{t('noEnvVars')}</p>
                          ) : (
                            <div className={css.envList}>
                              {rows.map((row, index) => (
                                <div key={index} className={css.envRow}>
                                  <input
                                    type="text"
                                    className={css.envKey}
                                    placeholder={t('envKey')}
                                    value={row.key}
                                    onChange={e => { updateEnvRow(id, index, { key: e.target.value }) }}
                                  />
                                  <input
                                    type="text"
                                    className={css.envValue}
                                    placeholder={t('envValue')}
                                    value={row.value}
                                    onChange={e => { updateEnvRow(id, index, { value: e.target.value }) }}
                                  />
                                  <button
                                    type="button"
                                    className={css.envRemove}
                                    onClick={() => { removeEnvRow(id, index) }}
                                  >
                                    ×
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                          <button
                            type="button"
                            className={css.addEnvButton}
                            onClick={() => { addEnvRow(id) }}
                          >
                            + {t('addEnvVar')}
                          </button>
                        </div>

                        <div className={css.detailSection}>
                          <div className={css.modelSelectHeader}>
                            <p className={css.detailHeading}>{t('modelSelect')}</p>
                            <button
                              type="button"
                              className={css.refreshButton}
                              disabled={isLoadingModels}
                              onClick={() => { void refreshModels(id) }}
                            >
                              {isLoadingModels ? t('refreshingModels') : t('refreshModels')}
                            </button>
                          </div>
                          <p className={css.detailHint}>{t('modelSelectHint')}</p>
                          {isLoadingModels ? (
                            <p className={css.emptyInline}>{t('modelsLoading')}</p>
                          ) : models.length === 0 ? (
                            <p className={css.emptyInline}>
                              {info !== undefined ? t('noModelsConnected') : t('noModels')}
                            </p>
                          ) : (
                            <>
                              <input
                                type="search"
                                className={css.modelSearch}
                                placeholder={t('modelSearch')}
                                value={modelSearch[id] ?? ''}
                                onChange={e => { setModelSearch(prev => ({ ...prev, [id]: e.target.value })) }}
                              />
                              <div className={css.modelList}>
                                {models
                                  .filter(model => {
                                    const q = (modelSearch[id] ?? '').trim().toLowerCase()
                                    if (q === '') return true
                                    return model.name.toLowerCase().includes(q) || model.id.toLowerCase().includes(q)
                                  })
                                  .sort((a, b) => {
                                    const aSelected = selectedModels.includes(a.id) ? 0 : 1
                                    const bSelected = selectedModels.includes(b.id) ? 0 : 1
                                    return aSelected - bSelected
                                  })
                                  .map(model => {
                                    const checked = selectedModels.includes(model.id)
                                    return (
                                      <label key={model.id} className={css.modelRow}>
                                        <input
                                          type="checkbox"
                                          checked={checked}
                                          onChange={() => { toggleModel(id, model.id) }}
                                        />
                                        <span className={css.modelName}>{model.name}</span>
                                        <span className={css.modelId}>{model.id}</span>
                                      </label>
                                    )
                                  })}
                              </div>
                            </>
                          )}
                          {models.length > 0 && (
                            <div className={css.modelActions}>
                              <button
                                type="button"
                                className={css.linkButton}
                                onClick={() => { setModelDrafts(prev => ({ ...prev, [id]: models.map(m => m.id) })) }}
                              >
                                {t('selectAll')}
                              </button>
                              <button
                                type="button"
                                className={css.linkButton}
                                onClick={() => { setModelDrafts(prev => ({ ...prev, [id]: [] })) }}
                              >
                                {t('selectNone')}
                              </button>
                            </div>
                          )}
                        </div>

                        <div className={css.detailSection}>
                          <p className={css.detailHeading}>{t('customModels')}</p>
                          <p className={css.detailHint}>{t('customModelsHint')}</p>
                          {(customModelDrafts[id] ?? []).length === 0 ? (
                            <p className={css.emptyInline}>{t('noCustomModels')}</p>
                          ) : (
                            <div className={css.envList}>
                              {(customModelDrafts[id] ?? []).map((row, index) => (
                                <div key={index} className={css.envRow}>
                                  <input
                                    type="text"
                                    className={css.envKey}
                                    placeholder={t('customModelId')}
                                    value={row.id}
                                    onChange={e => { updateCustomModelRow(id, index, { id: e.target.value }) }}
                                  />
                                  <input
                                    type="text"
                                    className={css.envValue}
                                    placeholder={t('customModelName')}
                                    value={row.name}
                                    onChange={e => { updateCustomModelRow(id, index, { name: e.target.value }) }}
                                  />
                                  <button
                                    type="button"
                                    className={css.envRemove}
                                    onClick={() => { removeCustomModelRow(id, index) }}
                                  >
                                    ×
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                          <button
                            type="button"
                            className={css.addEnvButton}
                            onClick={() => { addCustomModelRow(id) }}
                          >
                            + {t('addCustomModel')}
                          </button>
                        </div>

                        <button
                          type="button"
                          className={css.saveButton}
                          disabled={savingId === id}
                          onClick={() => { void saveServerConfig(id) }}
                        >
                          {savingId === id ? t('saving') : t('save')}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {testServer !== undefined && (
        <div className={css.modalOverlay} onClick={() => { setTestServer(undefined) }}>
          <div className={css.modal} onClick={e => { e.stopPropagation() }}>
            <div className={css.modalHeader}>
              <p className={css.modalTitle}>{t('testTitle')} — {testServer.name}</p>
              <button
                type="button"
                className={css.modalClose}
                onClick={() => { setTestServer(undefined) }}
              >
                ×
              </button>
            </div>
            <div className={css.testSteps}>
              {TEST_STEP_IDS.map(stepId => {
                const step = testSteps[stepId]
                return (
                  <div key={stepId} className={css.testStep}>
                    <span className={`${css.testStepStatus} ${css[`test_${step.status}`]}`}>
                      {step.status === 'pass' ? '✓' : step.status === 'fail' ? '✗' : '…'}
                    </span>
                    <div className={css.testStepBody}>
                      <p className={css.testStepLabel}>{t(`testStep_${stepId}` as AcpSettingsLocaleKey)}</p>
                      {step.detail !== undefined && <p className={css.testStepDetail}>{step.detail}</p>}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {showCustomForm && (
        <div className={css.modalOverlay} onClick={() => { setShowCustomForm(false) }}>
          <div className={css.modal} onClick={e => { e.stopPropagation() }}>
            <div className={css.modalHeader}>
              <p className={css.modalTitle}>{t('customTitle')}</p>
              <button
                type="button"
                className={css.modalClose}
                onClick={() => { setShowCustomForm(false) }}
              >
                ×
              </button>
            </div>
            <div className={css.customForm}>
              {customError !== undefined && <div className={css.error}>{customError}</div>}
              <div className={css.detailSection}>
                <p className={css.detailHeading}>{t('customId')}</p>
                <p className={css.detailHint}>{t('customIdHint')}</p>
                <input
                  type="text"
                  className={css.customInput}
                  placeholder="my-agent"
                  value={customDraft.id}
                  onChange={e => { setCustomDraft(prev => ({ ...prev, id: e.target.value })) }}
                />
              </div>
              <div className={css.detailSection}>
                <p className={css.detailHeading}>{t('customName')}</p>
                <input
                  type="text"
                  className={css.customInput}
                  placeholder={t('customName')}
                  value={customDraft.name}
                  onChange={e => { setCustomDraft(prev => ({ ...prev, name: e.target.value })) }}
                />
              </div>
              <div className={css.detailSection}>
                <p className={css.detailHeading}>{t('customCommand')}</p>
                <p className={css.detailHint}>{t('customCommandHint')}</p>
                <input
                  type="text"
                  className={css.customInput}
                  placeholder="npx"
                  value={customDraft.command}
                  onChange={e => { setCustomDraft(prev => ({ ...prev, command: e.target.value })) }}
                />
              </div>
              <div className={css.detailSection}>
                <p className={css.detailHeading}>{t('customArgs')}</p>
                <p className={css.detailHint}>{t('customArgsHint')}</p>
                <input
                  type="text"
                  className={css.customInput}
                  placeholder="-y @my-org/my-acp-agent"
                  value={customDraft.args}
                  onChange={e => { setCustomDraft(prev => ({ ...prev, args: e.target.value })) }}
                />
              </div>
              <div className={css.detailSection}>
                <p className={css.detailHeading}>{t('customEnv')}</p>
                <p className={css.detailHint}>{t('customEnvHint')}</p>
                {customDraft.env.length === 0 ? (
                  <p className={css.emptyInline}>{t('noEnvVars')}</p>
                ) : (
                  <div className={css.envList}>
                    {customDraft.env.map((row, index) => (
                      <div key={index} className={css.envRow}>
                        <input
                          type="text"
                          className={css.envKey}
                          placeholder={t('envKey')}
                          value={row.key}
                          onChange={e => { updateCustomEnvRow(index, { key: e.target.value }) }}
                        />
                        <input
                          type="text"
                          className={css.envValue}
                          placeholder={t('envValue')}
                          value={row.value}
                          onChange={e => { updateCustomEnvRow(index, { value: e.target.value }) }}
                        />
                        <button
                          type="button"
                          className={css.envRemove}
                          onClick={() => { removeCustomEnvRow(index) }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  className={css.addEnvButton}
                  onClick={() => { addCustomEnvRow() }}
                >
                  + {t('addEnvVar')}
                </button>
              </div>
              <button
                type="button"
                className={css.saveButton}
                disabled={customSaving}
                onClick={() => { void addCustomServer() }}
              >
                {customSaving ? t('customSaving') : t('customSave')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** ACP Servers settings section copy. */
    'settings.acp': AcpSettingsLocaleKey
  }
}
