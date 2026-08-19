/** ACP Servers settings section: registry browser and configured-server list. */

import { useEffect, useMemo, useState } from 'react'
import type {
  InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { IApiClient, ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
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
}

/** Injected dependencies from the apply closure. */
export interface AcpSettingsSectionInjected {
  /** The ACP registry data (bundled at build time). */
  registry: { version: string; agents: AcpRegistryAgent[] }
  /** Wire face for settings reads/writes and model catalog discovery. */
  api: Pick<IApiClient, 'settings' | 'llm'>
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
}

/** Draft environment variable row for the editor. */
interface EnvDraftRow {
  key: string
  value: string
}

/** Load discovered models for one ACP provider route from the host catalog. */
async function loadProviderModels(
  api: AcpSettingsSectionInjected['api'],
  providerRoute: string,
): Promise<DiscoveredModel[]> {
  try {
    const response = await api.llm.models({})
    if (!response.result.ok) return []
    const groups: readonly ModelProviderGroup[] = response.result.value.groups
    const group = groups.find(g => g.id === providerRoute)
    if (group === undefined) return []
    return group.models.map(m => ({ id: m.id, name: m.name }))
  } catch {
    return []
  }
}

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
  const [discoveredModels, setDiscoveredModels] = useState<Record<string, DiscoveredModel[]>>({})
  const [modelsLoading, setModelsLoading] = useState<Set<string>>(new Set())
  const [savingId, setSavingId] = useState<string | undefined>()

  /** Load current servers from settings. */
  const loadServers = async (): Promise<void> => {
    try {
      const response = await api.settings.describe({})
      if (response.result.ok) {
        const views = response.result.value.namespaces
        const ns = views.find(v => v.ns === settingsNs)
        if (ns !== undefined) {
          const data = ns.value as { servers?: Record<string, AcpServerEntry> }
          setServers(data?.servers ?? {})
        }
      }
    } catch {
      // Settings section may not exist yet — that's the empty state.
      setServers({})
    }
    setLoading(false)
  }

  useEffect(() => { void loadServers() }, [])

  /** Add a registry agent as a configured server. */
  const addServer = async (agent: AcpRegistryAgent): Promise<void> => {
    const cmd = deriveCommand(agent)
    if (cmd === undefined) return
    setAddingId(agent.id)
    setError(undefined)
    try {
      const serverEntry = { command: cmd.command, args: cmd.args, name: agent.name, env: {}, models: [] }
      const response = await api.settings.mutate({
        ns: settingsNs,
        ops: [{ op: 'set', path: ['servers', agent.id], value: serverEntry }],
      })
      if (!response.result.ok) {
        setError(response.result.error.message)
      } else {
        await loadServers()
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setAddingId(undefined)
  }

  /** Remove a configured server. */
  const removeServer = async (id: string): Promise<void> => {
    setRemovingId(id)
    setError(undefined)
    try {
      const response = await api.settings.mutate({
        ns: settingsNs,
        ops: [{ op: 'unset', path: ['servers', id] }],
      })
      if (!response.result.ok) {
        setError(response.result.error.message)
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
    }
    // Fetch discovered models for this provider route.
    setModelsLoading(prev => new Set(prev).add(id))
    const models = await loadProviderModels(api, `acp-${id}`)
    setDiscoveredModels(prev => ({ ...prev, [id]: models }))
    setModelsLoading(prev => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  /** Save env and models drafts for one server to settings. */
  const saveServerConfig = async (id: string): Promise<void> => {
    setSavingId(id)
    setError(undefined)
    try {
      const env = draftsToEnv(envDrafts[id] ?? [])
      const models = modelDrafts[id] ?? []
      const response = await api.settings.mutate({
        ns: settingsNs,
        ops: [
          { op: 'set', path: ['servers', id, 'env'], value: env },
          { op: 'set', path: ['servers', id, 'models'], value: models },
        ],
      })
      if (!response.result.ok) {
        setError(response.result.error.message)
      } else {
        await loadServers()
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setSavingId(undefined)
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
          <input
            type="search"
            className={css.search}
            placeholder={t('registrySearch')}
            value={search}
            onChange={e => { setSearch(e.target.value) }}
          />
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
                return (
                  <div key={id} className={css.serverCardBlock}>
                    <div className={css.serverCard}>
                      <div className={css.agentInfo}>
                        <p className={css.agentName}>{server.name}</p>
                        <p className={css.serverCommand}>
                          {t('serverCommand')}: {server.command} {server.args.join(' ')}
                        </p>
                        <div className={css.agentMeta}>
                          <span>acp-{id}</span>
                        </div>
                      </div>
                      <div className={css.cardActions}>
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
                          <p className={css.detailHeading}>{t('modelSelect')}</p>
                          <p className={css.detailHint}>{t('modelSelectHint')}</p>
                          {isLoadingModels ? (
                            <p className={css.emptyInline}>{t('modelsLoading')}</p>
                          ) : models.length === 0 ? (
                            <p className={css.emptyInline}>{t('noModels')}</p>
                          ) : (
                            <div className={css.modelList}>
                              {models.map(model => {
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
    </div>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** ACP Servers settings section copy. */
    'settings.acp': AcpSettingsLocaleKey
  }
}
