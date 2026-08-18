/** ACP Servers settings section: registry browser and configured-server list. */

import { useEffect, useMemo, useState } from 'react'
import type {
  InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
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
}

/** Injected dependencies from the apply closure. */
export interface AcpSettingsSectionInjected {
  /** The ACP registry data (bundled at build time). */
  registry: { version: string; agents: AcpRegistryAgent[] }
  /** Wire face for settings reads/writes. */
  api: Pick<IApiClient, 'settings'>
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
      const serverEntry = { command: cmd.command, args: cmd.args, name: agent.name }
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
              {serverList.map(([id, server]) => (
                <div key={id} className={css.serverCard}>
                  <div className={css.agentInfo}>
                    <p className={css.agentName}>{server.name}</p>
                    <p className={css.serverCommand}>
                      {t('serverCommand')}: {server.command} {server.args.join(' ')}
                    </p>
                    <div className={css.agentMeta}>
                      <span>acp-{id}</span>
                    </div>
                  </div>
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
              ))}
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
