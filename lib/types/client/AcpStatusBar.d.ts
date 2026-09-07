/** Sidebar footer indicator showing ACP server connection status. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { AcpSettingsSectionApi } from './AcpSettingsSection.tsx';
/** Props the renderer binds for the footer action. */
export type AcpStatusBarProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'settings.acp'> & {
    api: AcpSettingsSectionApi;
    settingsNs: string;
};
/** Render the ACP connection-status indicator for the sidebar footer. */
export declare function AcpStatusBar(props: AcpStatusBarProps): import("react").JSX.Element | null;
//# sourceMappingURL=AcpStatusBar.d.ts.map