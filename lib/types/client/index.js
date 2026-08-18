/**
 * ACP Servers settings surface, browser half. Registers one settings section
 * that lets the user browse the ACP registry and add/remove ACP agent servers.
 * Servers are stored in the `llm-acp` settings namespace and picked up by the
 * host-side `@deepseek-ai/dsh-llm-acp` plugin.
 */
import { AcpSettingsSection } from "./AcpSettingsSection.js";
import { en, zh } from "./locales.js";
// Registry data is bundled at build time from the ACP registry repository.
import registryData from '../registry.json' with { type: 'json' };
/** Dictionary namespace owned by this plugin. */
const NS = 'settings.acp';
/** Settings namespace owned by the host-side llm-acp plugin. */
const LLM_ACP_NS = 'llm-acp';
/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote'];
/**
 * Register the ACP Servers section once the `settings.section` declaration is
 * on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-acp: copy dictionaries');
    const connection = ctx.get('connection');
    const t = ctx.locale.bind(NS);
    const injected = () => ({
        registry: registryData,
        api: connection.api,
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
}
//# sourceMappingURL=index.js.map