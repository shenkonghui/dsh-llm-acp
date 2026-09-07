/** ACP Servers settings section: registry browser and configured-server list. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
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
    env?: Record<string, string>;
    models?: string[];
}
/** Wire view of one registered settings namespace (the fields this section reads). */
interface AcpNamespaceView {
    ns: string;
    value: unknown;
    revision: number;
}
/** One path-addressed settings edit (the wire op this section sends). */
export type AcpSettingsPathOp = {
    op: 'set';
    path: string[];
    value: unknown;
} | {
    op: 'unset';
    path: string[];
};
/** Wire result of one Remote call: the ok branch carries the value, the failure branch the message. */
interface AcpRemoteResult<T> {
    readonly ok: boolean;
    readonly value?: T;
    readonly error?: {
        readonly message: string;
    };
}
/**
 * The narrow Remote face this section calls, adapted from `ctx.remote` by the
 * apply closure so the component stays free of transport types.
 */
export interface AcpSettingsSectionApi {
    describeSettings(): Promise<AcpRemoteResult<{
        namespaces: readonly AcpNamespaceView[];
    }>>;
    mutateSettings(ns: string, ops: readonly AcpSettingsPathOp[], expectedRevision: number | undefined): Promise<AcpRemoteResult<unknown>>;
    discoverModels(settingsNs: string, provider: string): Promise<AcpRemoteResult<readonly DiscoveredModel[]>>;
}
/** Injected dependencies from the apply closure. */
export interface AcpSettingsSectionInjected {
    /** The ACP registry data (bundled at build time). */
    registry: {
        version: string;
        agents: AcpRegistryAgent[];
    };
    /** Wire face for settings reads/writes and model catalog discovery. */
    api: AcpSettingsSectionApi;
    /** Settings namespace for ACP servers. */
    settingsNs: string;
}
/** Props the renderer binds for the section. */
export type AcpSettingsSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'settings.acp'> & InjectFace<AcpSettingsSectionInjected>;
/** One discovered model from the host model catalog. */
interface DiscoveredModel {
    id: string;
    name: string;
    /** Carries the ACP protocol version on the `acp-info-<id>` route. */
    contextWindow?: number;
}
/** Render the ACP Servers settings section. */
export declare function AcpSettingsSection(props: AcpSettingsSectionProps): import("react").JSX.Element;
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** ACP Servers settings section copy. */
        'settings.acp': AcpSettingsLocaleKey;
    }
}
export {};
//# sourceMappingURL=AcpSettingsSection.d.ts.map