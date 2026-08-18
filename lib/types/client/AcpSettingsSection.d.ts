/** ACP Servers settings section: registry browser and configured-server list. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client';
import type { AcpSettingsLocaleKey } from './locales.ts';
/** One ACP registry agent entry. */
export interface AcpRegistryAgent {
    id: string;
    name: string;
    version: string;
    description: string;
    repository?: string;
    website?: string;
    authors?: string[];
    license?: string;
    distribution: {
        npx?: {
            package: string;
            args?: string[];
        };
        binary?: Record<string, {
            archive: string;
            cmd: string;
            args?: string[];
        }>;
        uvx?: {
            package: string;
            args?: string[];
        };
    };
}
/** One configured ACP server from settings. */
export interface AcpServerEntry {
    command: string;
    args: string[];
    name: string;
}
/** Injected dependencies from the apply closure. */
export interface AcpSettingsSectionInjected {
    /** The ACP registry data (bundled at build time). */
    registry: {
        version: string;
        agents: AcpRegistryAgent[];
    };
    /** Wire face for settings reads/writes. */
    api: Pick<IApiClient, 'settings'>;
    /** Settings namespace for ACP servers. */
    settingsNs: string;
}
/** Props the renderer binds for the section. */
export type AcpSettingsSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'settings.acp'> & InjectFace<AcpSettingsSectionInjected>;
/** Render the ACP Servers settings section. */
export declare function AcpSettingsSection(props: AcpSettingsSectionProps): import("react").JSX.Element;
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** ACP Servers settings section copy. */
        'settings.acp': AcpSettingsLocaleKey;
    }
}
//# sourceMappingURL=AcpSettingsSection.d.ts.map