/**
 * ACP Servers settings surface, browser half. Registers one settings section
 * that lets the user browse the ACP registry and add/remove ACP agent servers.
 * Servers are stored in the `llm-acp` settings namespace and picked up by the
 * host-side `@deepseek-ai/dsh-llm-acp` plugin.
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the ctx.remote merge and forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { AcpSettingsSection } from './AcpSettingsSection.tsx'
import type { AcpSettingsSectionInjected } from './AcpSettingsSection.tsx'
import { en, zh, type AcpSettingsLocaleKey } from './locales.ts'
// Registry data is bundled at build time from the ACP registry repository.
import registryData from '../registry.json' with { type: 'json' }

export type { AcpSettingsSectionInjected, AcpSettingsSectionProps } from './AcpSettingsSection.tsx'
export type { AcpRegistryAgent, AcpServerEntry } from './AcpSettingsSection.tsx'
export type { AcpSettingsLocaleKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.acp'

/** Settings namespace owned by the host-side llm-acp plugin. */
const LLM_ACP_NS = 'llm-acp'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote']

/**
 * Register the ACP Servers section once the `settings.section` declaration is
 * on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-acp: copy dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  const t = ctx.locale.bind(NS) as (key: AcpSettingsLocaleKey) => string
  const injected = (): AcpSettingsSectionInjected => ({
    registry: registryData as { version: string; agents: AcpSettingsSectionInjected['registry']['agents'] },
    api: connection.api,
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
}
