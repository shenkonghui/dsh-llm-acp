/** ACP Protocol inspector: conversation view showing recent JSON-RPC interactions. */
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { AcpSettingsSectionApi } from './AcpSettingsSection.tsx';
/** Injected dependencies from the apply closure. */
export interface AcpProtocolViewInjected {
    /** Wire face for settings reads and model catalog discovery. */
    api: AcpSettingsSectionApi;
    /** Settings namespace for ACP servers. */
    settingsNs: string;
}
/** Props the renderer binds for the protocol view. */
export type AcpProtocolViewProps = ConvViewProps & PropsLocale<'settings.acp'> & InjectFace<AcpProtocolViewInjected>;
/**
 * Poll all configured ACP servers for their recent protocol trace entries and
 * render them in a scrollable list. The view refreshes every 3 seconds while
 * visible. Clicking an entry opens a detail pane with the full payload.
 */
export declare function AcpProtocolView({ api, settingsNs, t, }: AcpProtocolViewProps): JSX.Element;
//# sourceMappingURL=AcpProtocolView.d.ts.map