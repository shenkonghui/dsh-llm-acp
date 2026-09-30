/**
 * ACP Servers settings surface, browser half. Registers one settings section
 * that lets the user browse the ACP registry and add/remove ACP agent servers,
 * plus a conversation view tab that inspects recent ACP protocol interactions.
 * Servers are stored in the `llm-acp` settings namespace (the host plugin's
 * volatile config fields) of the host-side `@deepseek-ai/dsh-llm-acp` plugin.
 */

// Type-only: the remote service merge (ctx.remote).
import type {} from '@deepseek-ai/dsh-api-gateway/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the slots service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// The client context is the cordis Context with the above service merges.
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the sidebar shell's SlotMap merge (sidebar.footer.action entry).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: the conversation shell's SlotMap merge (conversation.view entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the remote.settings / remote.llm namespace merges and wire types.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { AcpSettingsSection } from './AcpSettingsSection.tsx'
import type { AcpSettingsSectionApi, AcpSettingsSectionInjected } from './AcpSettingsSection.tsx'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { AcpProtocolView } from './AcpProtocolView.tsx'
import type { AcpProtocolViewInjected } from './AcpProtocolView.tsx'
import { AcpAuthBanner } from './AcpAuthBanner.tsx'
import type { AcpAuthBannerInjected } from './AcpAuthBanner.tsx'
import { AcpStatusBar } from './AcpStatusBar.tsx'
import { en, zh, type AcpSettingsLocaleKey } from './locales.ts'
// Registry data is bundled at build time from the ACP registry repository.
import registryData from '../registry.json' with { type: 'json' }

export type { AcpSettingsSectionInjected, AcpSettingsSectionProps } from './AcpSettingsSection.tsx'
export type { AcpRegistryAgent, AcpServerEntry } from './AcpSettingsSection.tsx'
export type { AcpProtocolViewInjected, AcpProtocolViewProps } from './AcpProtocolView.tsx'
export type { AcpAuthBannerInjected, AcpAuthBannerProps } from './AcpAuthBanner.tsx'
export type { AcpSettingsLocaleKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.acp'

/** Settings namespace owned by the host-side llm-acp plugin. */
const LLM_ACP_NS = 'llm-acp'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.settings', 'remote.llm']

/**
 * Register the ACP Servers section once the `settings.section` declaration is
 * on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-acp: copy dictionaries')

  const t = ctx.locale.bind(NS) as (key: AcpSettingsLocaleKey) => string
  const remote = ctx.remote
  // The llm discovery wire type makes `name` optional; the section's face
  // requires it, so the id stands in at the seam.
  const discoverModels: AcpSettingsSectionApi['discoverModels'] = async (settingsNs, provider) => {
    const result = await remote.llm.discoverModels(settingsNs, { provider })
    if (!result.ok) return result
    return { ok: true, value: result.value.map(m => ({ id: m.id, name: m.name ?? m.id, contextWindow: m.contextWindow })) }
  }
  const injected = (): AcpSettingsSectionInjected => ({
    registry: registryData as { version: string; agents: AcpSettingsSectionInjected['registry']['agents'] },
    api: {
      describeSettings: () => remote.settings.describe(),
      mutateSettings: (ns, ops, expectedRevision) =>
        remote.settings.mutate(ns, ops as SettingsPathOpView[], expectedRevision),
      discoverModels,
    },
    settingsNs: LLM_ACP_NS,
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'acp-servers',
    order: 15,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, AcpSettingsSection))

  // Sidebar footer indicator: ACP server connection status.
  const footerApi: AcpSettingsSectionApi = {
    describeSettings: () => remote.settings.describe(),
    mutateSettings: (ns, ops, expectedRevision) =>
      remote.settings.mutate(ns, ops as SettingsPathOpView[], expectedRevision),
    discoverModels,
  }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'acp-status',
    order: 50,
    locale: NS,
    inject: () => ({ api: footerApi, settingsNs: LLM_ACP_NS }),
  }, AcpStatusBar))

  // Conversation view tab: ACP protocol inspector. Shows the most recent 10
  // JSON-RPC interactions (initialize, authenticate, session/new, prompt,
  // notifications) from all configured ACP servers, polled every 3 seconds.
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'acp-protocol',
    order: 20,
    locale: NS,
    label: () => t('viewProtocol'),
    inject: (): AcpProtocolViewInjected => ({ api: footerApi, settingsNs: LLM_ACP_NS }),
  }, AcpProtocolView))

  // Composer-dock banner: pending interactive-login URLs. While a server waits
  // on browser sign-in, the failed session call stays pending on the host and
  // retries automatically once the login completes.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'acp-auth',
    order: 10,
    locale: NS,
    inject: (): AcpAuthBannerInjected => ({ api: footerApi, settingsNs: LLM_ACP_NS }),
  }, AcpAuthBanner))
}
