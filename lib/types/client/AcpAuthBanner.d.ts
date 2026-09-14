/** ACP auth banner: conversation composer-dock entry that surfaces pending
 * interactive-login URLs published by ACP servers. */
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { AcpSettingsSectionApi } from './AcpSettingsSection.tsx';
/** Injected dependencies from the apply closure. */
export interface AcpAuthBannerInjected {
    /** Wire face for settings reads and model catalog discovery. */
    api: AcpSettingsSectionApi;
    /** Settings namespace for ACP servers. */
    settingsNs: string;
}
/** Props the renderer binds for the auth banner. */
export type AcpAuthBannerProps = PropsLocale<'settings.acp'> & InjectFace<AcpAuthBannerInjected>;
/**
 * Poll all configured ACP servers for pending interactive-login URLs and show
 * a banner with a clickable link while any server awaits browser sign-in. The
 * host keeps the failed session call pending for the interactive-auth window,
 * so the prompt retries automatically once the login completes; the banner
 * disappears on the next poll after `pendingAuthUrl` clears.
 */
export declare function AcpAuthBanner({ api, settingsNs, t, }: AcpAuthBannerProps): JSX.Element | null;
//# sourceMappingURL=AcpAuthBanner.d.ts.map