/** ACP auth banner: conversation composer-dock entry that surfaces pending
 * interactive-login URLs published by ACP servers. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AcpSettingsSectionApi } from './AcpSettingsSection.tsx'
import css from './AcpSettingsSection.module.css'

/** Wire result of one Remote call (mirrors the settings section's type). */
interface AcpRemoteResult<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly message: string }
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
export interface AcpAuthBannerInjected {
  /** Wire face for settings reads and model catalog discovery. */
  api: AcpSettingsSectionApi
  /** Settings namespace for ACP servers. */
  settingsNs: string
}

/** Props the renderer binds for the auth banner. */
export type AcpAuthBannerProps =
  PropsLocale<'settings.acp'>
  & InjectFace<AcpAuthBannerInjected>

/** Poll interval for pending auth URLs. */
const POLL_MS = 3_000

/** One pending login: server display name, the auth method id, and the
 * published browser URL when the method produced one. */
interface PendingAuth {
  serverName: string
  methodId: string
  url?: string
}

/**
 * Poll all configured ACP servers for pending interactive-login URLs and show
 * a banner with a clickable link while any server awaits browser sign-in. The
 * host keeps the failed session call pending for the interactive-auth window,
 * so the prompt retries automatically once the login completes; the banner
 * disappears on the next poll after `pendingAuthUrl` clears.
 */
export function AcpAuthBanner({
  api, settingsNs, t,
}: AcpAuthBannerProps): JSX.Element | null {
  const [pending, setPending] = useState<PendingAuth[]>([])
  const mountedRef = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const desc = await api.describeSettings() as AcpRemoteResult<{ namespaces: readonly AcpNamespaceView[] }>
      if (!desc.ok || desc.value === undefined) {
        if (mountedRef.current) setPending([])
        return
      }
      const ns = desc.value.namespaces.find(v => v.ns === settingsNs)
      const servers = (ns?.value as { servers?: Record<string, AcpServerEntry> } | undefined)?.servers ?? {}
      const found: PendingAuth[] = []
      await Promise.all(Object.entries(servers).map(async ([id, server]) => {
        const res = await api.discoverModels(settingsNs, `acp-auth-${id}`) as AcpRemoteResult<readonly { id: string; name: string }[]>
        if (!res.ok || res.value === undefined) return
        const entry = res.value[0]
        if (entry === undefined) return
        const serverName = server.name.length > 0 ? server.name : id
        if (entry.id === 'auth' && entry.name.length > 0) {
          found.push({ serverName, methodId: '', url: entry.name })
        } else if (entry.id === 'pending') {
          found.push({ serverName, methodId: entry.name })
        }
      }))
      if (mountedRef.current) setPending(found)
    } catch { /* network or settings error */ }
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

  if (pending.length === 0) return null
  return (
    <>
      {pending.map(p => (
        <div key={p.serverName} className={css.authBanner}>
          <span>
            {p.serverName}: {p.url !== undefined
              ? t('authPending')
              : `${t('authWaiting')}${p.methodId.length > 0 ? ` (${p.methodId})` : ''}`}
          </span>
          {p.url !== undefined && (
            <a href={p.url} target="_blank" rel="noreferrer" className={css.authLink}>
              {t('authOpen')}
            </a>
          )}
        </div>
      ))}
    </>
  )
}
