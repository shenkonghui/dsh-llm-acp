/**
 * ACP Servers settings surface, browser half. Registers one settings section
 * that lets the user browse the ACP registry and add/remove ACP agent servers.
 * Servers are stored in the `llm-acp` settings namespace and picked up by the
 * host-side `@deepseek-ai/dsh-llm-acp` plugin.
 */

import type {} from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the slots service merge (ctx.slots) and props-share types.
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the ctx.remote merge and forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { AcpSettingsSection } from './AcpSettingsSection.tsx'
import type { AcpSettingsPathOp, AcpSettingsSectionApi, AcpSettingsSectionInjected } from './AcpSettingsSection.tsx'
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
export const inject = ['slots', 'locale', 'remote', 'remote.settings', 'remote.llm']

/**
 * Register the ACP Servers section once the `settings.section` declaration is
 * on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-acp: copy dictionaries')

  const t = ctx.locale.bind(NS) as (key: AcpSettingsLocaleKey) => string
  // `TypertClientRemote` does not declare the settings/llm remote faces at this
  // dsh version; both exist at runtime, so narrow through the section's api face.
  const remote = ctx.remote as ClientContext['remote'] & {
    settings: {
      describe: AcpSettingsSectionApi['describeSettings']
      mutate: AcpSettingsSectionApi['mutateSettings']
    }
    llm: {
      discoverModels: (settingsNs: string, request: { provider: string }) => ReturnType<AcpSettingsSectionApi['discoverModels']>
    }
  }
  const injected = (): AcpSettingsSectionInjected => ({
    registry: registryData as { version: string; agents: AcpSettingsSectionInjected['registry']['agents'] },
    api: {
      describeSettings: () => remote.settings.describe(),
      mutateSettings: (ns, ops, expectedRevision) =>
        remote.settings.mutate(ns, ops as AcpSettingsPathOp[], expectedRevision),
      discoverModels: (settingsNs, provider) => remote.llm.discoverModels(settingsNs, { provider }),
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
}
