/** ACP Protocol inspector: conversation view showing recent JSON-RPC interactions. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AcpSettingsSectionApi } from './AcpSettingsSection.tsx'
import css from './AcpProtocolView.module.css'

/** Wire result of one Remote call (mirrors the settings section's type). */
interface AcpRemoteResult<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly message: string }
}

/** One trace entry decoded from the `acp-trace-<id>` route. */
interface ProtocolTraceEntry {
  time: number
  dir: 'send' | 'recv'
  method: string
  summary: string
  /** How many consecutive interactions this entry represents (default 1). */
  count?: number
}

/** One configured ACP server from settings (mirrors the settings section's type). */
interface AcpServerEntry {
  command: string
  args: string[]
  name: string
  env?: Record<string, string>
  models?: string[]
  customModels?: { id: string; name: string }[]
}

/** Wire view of one registered settings namespace. */
interface AcpNamespaceView {
  ns: string
  value: unknown
  revision: number
}

/** Injected dependencies from the apply closure. */
export interface AcpProtocolViewInjected {
  /** Wire face for settings reads and model catalog discovery. */
  api: AcpSettingsSectionApi
  /** Settings namespace for ACP servers. */
  settingsNs: string
}

/** Props the renderer binds for the protocol view. */
export type AcpProtocolViewProps =
  ConvViewProps
  & PropsLocale<'settings.acp'>
  & InjectFace<AcpProtocolViewInjected>

/** Poll interval for trace data. */
const POLL_MS = 3_000

/** Format a timestamp as HH:MM:SS.mmm. */
function formatTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number, l = 2): string => n.toString().padStart(l, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/**
 * Poll all configured ACP servers for their recent protocol trace entries and
 * render them in a scrollable list. The view refreshes every 3 seconds while
 * visible.
 */
export function AcpProtocolView({
  api, settingsNs, t,
}: AcpProtocolViewProps): JSX.Element {
  const [traces, setTraces] = useState<{ server: string; entry: ProtocolTraceEntry }[]>([])
  const [loading, setLoading] = useState(false)
  const [serverIds, setServerIds] = useState<string[]>([])
  const mountedRef = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const desc = await api.describeSettings() as AcpRemoteResult<{ namespaces: readonly AcpNamespaceView[] }>
      if (!desc.ok || desc.value === undefined) {
        setServerIds([])
        setTraces([])
        return
      }
      const ns = desc.value.namespaces.find(v => v.ns === settingsNs)
      const data = ns?.value as { servers?: Record<string, AcpServerEntry> } | undefined
      const ids = Object.keys(data?.servers ?? {})
      setServerIds(ids)
      const all: { server: string; entry: ProtocolTraceEntry }[] = []
      await Promise.all(ids.map(async (id) => {
        const res = await api.discoverModels(settingsNs, `acp-trace-${id}`) as AcpRemoteResult<readonly { id: string; name: string }[]>
        if (!res.ok || res.value === undefined) return
        const entry = res.value[0]
        if (entry === undefined || entry.id !== 'trace') return
        try {
          const parsed = JSON.parse(entry.name) as ProtocolTraceEntry[]
          for (const e of parsed) all.push({ server: id, entry: e })
        } catch { /* malformed trace payload */ }
      }))
      all.sort((a, b) => b.entry.time - a.entry.time)
      if (mountedRef.current) setTraces(all.slice(0, 10))
    } catch { /* network or settings error */ }
    finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [api, settingsNs])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => {
      mountedRef.current = false
      clearInterval(timer)
    }
  }, [refresh])

  return (
    <div className={css.container}>
      <div className={css.header}>
        <span className={css.title}>{t('protocolTitle')}</span>
        <button
          type="button"
          className={css.refreshBtn}
          onClick={() => { void refresh() }}
          disabled={loading}
        >
          {loading ? t('protocolRefreshing') : t('protocolRefresh')}
        </button>
      </div>
      {serverIds.length === 0
        ? <div className={css.empty}>{t('protocolNoServers')}</div>
        : traces.length === 0
          ? <div className={css.empty}>{t('protocolEmpty')}</div>
          : (
            <ul className={css.list}>
              {traces.map(({ server, entry }, i) => (
                <li key={i} className={css.item}>
                  <span className={css.time}>{formatTime(entry.time)}</span>
                  <span className={`${css.dir} ${css[entry.dir]}`}>
                    {entry.dir === 'send' ? t('protocolSend') : t('protocolRecv')}
                  </span>
                  <span className={css.method}>{entry.method}</span>
                  <span className={css.server}>{server}</span>
                  <span className={css.summary}>
                    {entry.summary}
                    {entry.count !== undefined && entry.count > 1 && (
                      <span className={css.count}>×{entry.count}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
    </div>
  )
}
