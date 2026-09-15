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

/** One server's auth-method catalog, as published by the `acp-methods-<id>` route. */
interface MethodState {
  methods: readonly { id: string; name: string }[]
  selected: string
  /** Whether authentication is blocked until a method is chosen. */
  needed: boolean
}

/**
 * Identity of one choice request, used to remember a dismissal. Polling
 * re-reports the same pending choice every few seconds, so the dialog must be
 * keyed on something that only changes when the question itself does —
 * otherwise closing it reopens it on the next poll.
 */
function choiceSignature(state: MethodState): string {
  return `${state.methods.map(m => m.id).join(',')}|${state.selected}`
}

/** Parse the JSON carrier of the `acp-methods-<id>` route. */
function parseMethodState(entry: { id: string; name: string } | undefined): MethodState | undefined {
  if (entry === undefined || entry.id !== 'methods') return undefined
  try {
    const parsed = JSON.parse(entry.name) as Partial<MethodState>
    if (!Array.isArray(parsed.methods)) return undefined
    return {
      methods: parsed.methods.filter((m): m is { id: string; name: string } =>
        typeof m?.id === 'string' && typeof m?.name === 'string'),
      selected: typeof parsed.selected === 'string' ? parsed.selected : '',
      needed: parsed.needed === true,
    }
  } catch {
    return undefined
  }
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
  /** Server id → auth-method catalog, for the picker. */
  const [methods, setMethods] = useState<Record<string, MethodState>>({})
  /** Server id → the choice signature the user closed; suppresses re-opening. */
  const [dismissed, setDismissed] = useState<Record<string, string>>({})
  /** Server id → display name, for the dialog's per-server heading. */
  const [names, setNames] = useState<Record<string, string>>({})
  const [savingId, setSavingId] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const mountedRef = useRef(true)
  /** Revision of the `llm-acp` namespace at the last read, to write against. */
  const revisionRef = useRef<number | undefined>(undefined)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const desc = await api.describeSettings() as AcpRemoteResult<{ namespaces: readonly AcpNamespaceView[] }>
      if (!desc.ok || desc.value === undefined) {
        if (mountedRef.current) {
          setPending([])
          setMethods({})
        }
        return
      }
      const ns = desc.value.namespaces.find(v => v.ns === settingsNs)
      revisionRef.current = ns?.revision
      const servers = (ns?.value as { servers?: Record<string, AcpServerEntry> } | undefined)?.servers ?? {}
      const found: PendingAuth[] = []
      const catalogs: Record<string, MethodState> = {}
      const display: Record<string, string> = {}
      await Promise.all(Object.entries(servers).map(async ([id, server]) => {
        display[id] = server.name.length > 0 ? server.name : id
        const [authRes, methodRes] = await Promise.all([
          api.discoverModels(settingsNs, `acp-auth-${id}`),
          api.discoverModels(settingsNs, `acp-methods-${id}`),
        ])
        const state = parseMethodState(
          (methodRes as AcpRemoteResult<readonly { id: string; name: string }[]>).value?.[0],
        )
        if (state !== undefined) catalogs[id] = state

        const res = authRes as AcpRemoteResult<readonly { id: string; name: string }[]>
        if (!res.ok || res.value === undefined) return
        const entry = res.value[0]
        if (entry === undefined) return
        const serverName = display[id]
        if (entry.id === 'auth' && entry.name.length > 0) {
          found.push({ serverName, methodId: '', url: entry.name })
        } else if (entry.id === 'pending') {
          found.push({ serverName, methodId: entry.name })
        }
      }))
      if (!mountedRef.current) return
      // Value-compare before publishing: a fresh object every 3s would re-render
      // (and disturb) the open dialog for no reason.
      setPending(prev => JSON.stringify(prev) === JSON.stringify(found) ? prev : found)
      setMethods(prev => JSON.stringify(prev) === JSON.stringify(catalogs) ? prev : catalogs)
      setNames(prev => JSON.stringify(prev) === JSON.stringify(display) ? prev : display)
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

  /**
   * Persist the picked method. A concurrent write (the settings page's Save)
   * can invalidate our revision, so retry once against a fresh one.
   */
  const choose = useCallback(async (id: string, methodId: string): Promise<void> => {
    setSavingId(id)
    setError(undefined)
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await api.mutateSettings(
          settingsNs,
          [{ op: 'set', path: ['servers', id, 'authMethod'], value: methodId }],
          revisionRef.current,
        )
        if (response.ok) {
          // Mark this question answered before the poll catches up, so the
          // dialog does not flash back open.
          setDismissed(prev => ({
            ...prev,
            [id]: choiceSignature({
              methods: methods[id]?.methods ?? [],
              selected: methodId,
              needed: false,
            }),
          }))
          await refresh()
          return
        }
        if (attempt === 0) {
          // Re-read the revision and try once more before surfacing a failure.
          await refresh()
          continue
        }
        setError(response.error?.message ?? 'unknown error')
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mountedRef.current) setSavingId(undefined)
    }
  }, [api, methods, refresh, settingsNs])

  // One dialog for every server waiting on a choice. A single overlay avoids
  // stacking several fixed-position modals on the same z-index.
  const awaiting = Object.entries(methods).filter(([id, state]) =>
    state.needed && state.methods.length > 0 && dismissed[id] !== choiceSignature(state))
  const showDialog = awaiting.length > 0
  /** Remember every currently-asked question as answered-by-dismissal. */
  const dismiss = useCallback((): void => {
    setDismissed(prev => ({
      ...prev,
      ...Object.fromEntries(awaiting.map(([id, state]) => [id, choiceSignature(state)])),
    }))
  }, [awaiting])

  if (pending.length === 0 && !showDialog) return null
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
      {showDialog && (
        <div className={css.modalOverlay} onClick={dismiss}>
          <div className={css.modal} onClick={e => { e.stopPropagation() }}>
            <div className={css.modalHeader}>
              <p className={css.modalTitle}>{t('chooseMethodTitle')}</p>
              <button type="button" className={css.modalClose} onClick={dismiss}>
                ×
              </button>
            </div>
            <p className={css.detailHint}>{t('chooseMethodIntro')}</p>
            {error !== undefined && <div className={css.error}>{`${t('chooseMethodFailed')} ${error}`}</div>}
            <div className={css.methodList}>
              {awaiting.map(([id, state]) => (
                <div key={id} className={css.detailSection}>
                  <p className={css.detailHeading}>{names[id] ?? id}</p>
                  {state.methods.map(method => (
                    <button
                      key={method.id}
                      type="button"
                      className={css.methodButton}
                      disabled={savingId !== undefined}
                      onClick={() => { void choose(id, method.id) }}
                    >
                      <span className={css.methodName}>{method.name.length > 0 ? method.name : method.id}</span>
                      <span className={css.methodId}>{method.id}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
