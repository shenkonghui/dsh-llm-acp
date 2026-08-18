/**
 * ACP Servers settings surface, browser half. Registers one settings section
 * that lets the user browse the ACP registry and add/remove ACP agent servers.
 * Servers are stored in the `llm-acp` settings namespace and picked up by the
 * host-side `@deepseek-ai/dsh-llm-acp` plugin.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
export type { AcpSettingsSectionInjected, AcpSettingsSectionProps } from './AcpSettingsSection.tsx';
export type { AcpRegistryAgent, AcpServerEntry } from './AcpSettingsSection.tsx';
export type { AcpSettingsLocaleKey } from './locales.ts';
/** Required services (cordis fiber inject). */
export declare const inject: string[];
/**
 * Register the ACP Servers section once the `settings.section` declaration is
 * on the ledger.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map