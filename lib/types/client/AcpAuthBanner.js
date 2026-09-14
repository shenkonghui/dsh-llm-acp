import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
/** ACP auth banner: conversation composer-dock entry that surfaces pending
 * interactive-login URLs published by ACP servers. */
import { useCallback, useEffect, useRef, useState } from 'react';
import css from './AcpSettingsSection.module.css';
/** Poll interval for pending auth URLs. */
const POLL_MS = 3_000;
/**
 * Poll all configured ACP servers for pending interactive-login URLs and show
 * a banner with a clickable link while any server awaits browser sign-in. The
 * host keeps the failed session call pending for the interactive-auth window,
 * so the prompt retries automatically once the login completes; the banner
 * disappears on the next poll after `pendingAuthUrl` clears.
 */
export function AcpAuthBanner({ api, settingsNs, t, }) {
    const [pending, setPending] = useState([]);
    const mountedRef = useRef(true);
    const refresh = useCallback(async () => {
        try {
            const desc = await api.describeSettings();
            if (!desc.ok || desc.value === undefined) {
                if (mountedRef.current)
                    setPending([]);
                return;
            }
            const ns = desc.value.namespaces.find(v => v.ns === settingsNs);
            const servers = ns?.value?.servers ?? {};
            const found = [];
            await Promise.all(Object.entries(servers).map(async ([id, server]) => {
                const res = await api.discoverModels(settingsNs, `acp-auth-${id}`);
                if (!res.ok || res.value === undefined)
                    return;
                const entry = res.value[0];
                if (entry === undefined)
                    return;
                const serverName = server.name.length > 0 ? server.name : id;
                if (entry.id === 'auth' && entry.name.length > 0) {
                    found.push({ serverName, methodId: '', url: entry.name });
                }
                else if (entry.id === 'pending') {
                    found.push({ serverName, methodId: entry.name });
                }
            }));
            if (mountedRef.current)
                setPending(found);
        }
        catch { /* network or settings error */ }
    }, [api, settingsNs]);
    useEffect(() => {
        mountedRef.current = true;
        void refresh();
        const timer = setInterval(() => { void refresh(); }, POLL_MS);
        return () => {
            mountedRef.current = false;
            clearInterval(timer);
        };
    }, [refresh]);
    if (pending.length === 0)
        return null;
    return (_jsx(_Fragment, { children: pending.map(p => (_jsxs("div", { className: css.authBanner, children: [_jsxs("span", { children: [p.serverName, ": ", p.url !== undefined
                            ? t('authPending')
                            : `${t('authWaiting')}${p.methodId.length > 0 ? ` (${p.methodId})` : ''}`] }), p.url !== undefined && (_jsx("a", { href: p.url, target: "_blank", rel: "noreferrer", className: css.authLink, children: t('authOpen') }))] }, p.serverName))) }));
}
//# sourceMappingURL=AcpAuthBanner.js.map