/** Sidebar footer indicator showing ACP server connection status. */

import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AcpServerEntry, AcpSettingsSectionApi } from './AcpSettingsSection.tsx'
import css from './AcpStatusBar.module.css'

/** Wire view of one registered settings namespace. */
interface AcpNamespaceView {
  ns: string
  value: unknown
  revision: number
}

/** Status of one ACP server probe. */
type ServerStatus = 'checking' | 'connected' | 'disconnected'

/** One server row in the status popover. */
interface ServerRow {
  id: string
  name: string
  status: ServerStatus
  modelCount: number
}

/** Props the renderer binds for the footer action. */
export type AcpStatusBarProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<'settings.acp'>
  & {
    api: AcpSettingsSectionApi
    settingsNs: string
  }

/** Probe one ACP server by calling discoverModels; resolve to a status row. */
async function probeServer(
  api: AcpSettingsSectionApi,
  settingsNs: string,
  id: string,
  server: AcpServerEntry,
): Promise<ServerRow> {
  const row: ServerRow = { id, name: server.name, status: 'checking', modelCount: 0 }
  try {
    const response = await api.discoverModels(settingsNs, `acp-${id}`)
    if (response.ok) {
      const models = response.value ?? []
      row.status = 'connected'
      row.modelCount = models.length
    } else {
      row.status = 'disconnected'
    }
  } catch {
    row.status = 'disconnected'
  }
  return row
}

/** Fetch configured servers from settings, then probe each in parallel. */
async function loadServerStatuses(
  api: AcpSettingsSectionApi,
  settingsNs: string,
): Promise<ServerRow[]> {
  let servers: Record<string, AcpServerEntry> = {}
  try {
    const response = await api.describeSettings()
    if (response.ok) {
      const ns = response.value?.namespaces.find((v: AcpNamespaceView) => v.ns === settingsNs)
      if (ns !== undefined) {
        const data = ns.value as { servers?: Record<string, AcpServerEntry> }
        servers = data?.servers ?? {}
      }
    }
  } catch {
    // Settings read failure — show nothing.
    return []
  }
  const entries = Object.entries(servers)
  if (entries.length === 0) return []
  return Promise.all(entries.map(([id, server]) => probeServer(api, settingsNs, id, server)))
}

/** Render the ACP connection-status indicator for the sidebar footer. */
export function AcpStatusBar(props: AcpStatusBarProps) {
  const { t, api, settingsNs } = props
  const [rows, setRows] = useState<ServerRow[]>([])
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    const refresh = async (): Promise<void> => {
      const next = await loadServerStatuses(api, settingsNs)
      if (!cancelled) setRows(next)
    }
    void refresh()
    const timer = setInterval(refresh, 30_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [api, settingsNs])

  if (rows.length === 0) return null

  const connected = rows.filter(r => r.status === 'connected').length
  const total = rows.length
  const allConnected = connected === total
  const noneConnected = connected === 0

  const dotClass = allConnected
    ? css.dotOk
    : noneConnected
      ? css.dotErr
      : css.dotWarn

  const summary = t('statusSummary')
    .replace('{connected}', String(connected))
    .replace('{total}', String(total))

  return (
    <div className={css.wrapper}>
      <button
        type="button"
        className={css.trigger}
        onClick={() => { setExpanded(v => !v) }}
        title={summary}
      >
        <span className={`${css.dot} ${dotClass}`} />
        <span className={css.label}>{t('statusLabel')}</span>
        <span className={css.count}>{connected}/{total}</span>
      </button>
      {expanded && (
        <div className={css.popover}>
          {rows.map(row => (
            <div key={row.id} className={css.serverRow}>
              <span className={`${css.dot} ${
                row.status === 'connected'
                  ? css.dotOk
                  : row.status === 'disconnected'
                    ? css.dotErr
                    : css.dotPending
              }`} />
              <span className={css.serverName}>{row.name}</span>
              <span className={css.serverDetail}>
                {row.status === 'connected'
                  ? t('statusConnected').replace('{n}', String(row.modelCount))
                  : row.status === 'disconnected'
                    ? t('statusDisconnected')
                    : t('statusChecking')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
