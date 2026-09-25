/**
 * ACP Servers settings surface, browser half. Registers one settings section
 * that lets the user browse the ACP registry and add/remove ACP agent servers,
 * plus a conversation view tab that inspects recent ACP protocol interactions.
 * Servers are stored in the `llm-acp` settings namespace (the host plugin's
 * volatile config fields) of the host-side `@deepseek-ai/dsh-llm-acp` plugin.
 */
import { AcpSettingsSection } from "./AcpSettingsSection.js";
import { AcpProtocolView } from "./AcpProtocolView.js";
import { AcpAuthBanner } from "./AcpAuthBanner.js";
import { AcpStatusBar } from "./AcpStatusBar.js";
import { en, zh } from "./locales.js";
// Registry data is bundled at build time from the ACP registry repository.
import registryData from '../registry.json' with { type: 'json' };
/** Dictionary namespace owned by this plugin. */
const NS = 'settings.acp';
/** Settings namespace owned by the host-side llm-acp plugin. */
const LLM_ACP_NS = 'llm-acp';
/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.settings', 'remote.llm'];
/**
 * Register the ACP Servers section once the `settings.section` declaration is
 * on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-acp: copy dictionaries');
    const t = ctx.locale.bind(NS);
    const remote = ctx.remote;
    // The llm discovery wire type makes `name` optional; the section's face
    // requires it, so the id stands in at the seam.
    const discoverModels = async (settingsNs, provider) => {
        const result = await remote.llm.discoverModels(settingsNs, { provider });
        if (!result.ok)
            return result;
        return { ok: true, value: result.value.map(m => ({ id: m.id, name: m.name ?? m.id, contextWindow: m.contextWindow })) };
    };
    const injected = () => ({
        registry: registryData,
        api: {
            describeSettings: () => remote.settings.describe(),
            mutateSettings: (ns, ops, expectedRevision) => remote.settings.mutate(ns, ops, expectedRevision),
            discoverModels,
        },
        settingsNs: LLM_ACP_NS,
    });
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'acp-servers',
        order: 15,
        label: () => t('nav'),
        locale: NS,
        inject: injected,
    }, AcpSettingsSection));
    // Sidebar footer indicator: ACP server connection status.
    const footerApi = {
        describeSettings: () => remote.settings.describe(),
        mutateSettings: (ns, ops, expectedRevision) => remote.settings.mutate(ns, ops, expectedRevision),
        discoverModels,
    };
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'acp-status',
        order: 50,
        locale: NS,
        inject: () => ({ api: footerApi, settingsNs: LLM_ACP_NS }),
    }, AcpStatusBar));
    // Conversation view tab: ACP protocol inspector. Shows the most recent 10
    // JSON-RPC interactions (initialize, authenticate, session/new, prompt,
    // notifications) from all configured ACP servers, polled every 3 seconds.
    ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'acp-protocol',
        order: 20,
        locale: NS,
        label: () => t('viewProtocol'),
        inject: () => ({ api: footerApi, settingsNs: LLM_ACP_NS }),
    }, AcpProtocolView));
    // Composer-dock banner: pending interactive-login URLs. While a server waits
    // on browser sign-in, the failed session call stays pending on the host and
    // retries automatically once the login completes.
    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'acp-auth',
        order: 10,
        locale: NS,
        inject: () => ({ api: footerApi, settingsNs: LLM_ACP_NS }),
    }, AcpAuthBanner));
}
//# sourceMappingURL=index.js.map