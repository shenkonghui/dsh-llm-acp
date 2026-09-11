import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** ACP Protocol inspector: conversation view showing recent JSON-RPC interactions. */
import { useCallback, useEffect, useRef, useState } from 'react';
import css from './AcpProtocolView.module.css';
/** Poll interval for trace data. */
const POLL_MS = 3_000;
/** Format a timestamp as HH:MM:SS.mmm. */
function formatTime(ms) {
    const d = new Date(ms);
    const pad = (n, l = 2) => n.toString().padStart(l, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
/**
 * Poll all configured ACP servers for their recent protocol trace entries and
 * render them in a scrollable list. The view refreshes every 3 seconds while
 * visible.
 */
export function AcpProtocolView({ api, settingsNs, t, }) {
    const [traces, setTraces] = useState([]);
    const [loading, setLoading] = useState(false);
    const [serverIds, setServerIds] = useState([]);
    const mountedRef = useRef(true);
    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const desc = await api.describeSettings();
            if (!desc.ok || desc.value === undefined) {
                setServerIds([]);
                setTraces([]);
                return;
            }
            const ns = desc.value.namespaces.find(v => v.ns === settingsNs);
            const data = ns?.value;
            const ids = Object.keys(data?.servers ?? {});
            setServerIds(ids);
            const all = [];
            await Promise.all(ids.map(async (id) => {
                const res = await api.discoverModels(settingsNs, `acp-trace-${id}`);
                if (!res.ok || res.value === undefined)
                    return;
                const entry = res.value[0];
                if (entry === undefined || entry.id !== 'trace')
                    return;
                try {
                    const parsed = JSON.parse(entry.name);
                    for (const e of parsed)
                        all.push({ server: id, entry: e });
                }
                catch { /* malformed trace payload */ }
            }));
            all.sort((a, b) => b.entry.time - a.entry.time);
            if (mountedRef.current)
                setTraces(all.slice(0, 10));
        }
        catch { /* network or settings error */ }
        finally {
            if (mountedRef.current)
                setLoading(false);
        }
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
    return (_jsxs("div", { className: css.container, children: [_jsxs("div", { className: css.header, children: [_jsx("span", { className: css.title, children: t('protocolTitle') }), _jsx("button", { type: "button", className: css.refreshBtn, onClick: () => { void refresh(); }, disabled: loading, children: loading ? t('protocolRefreshing') : t('protocolRefresh') })] }), serverIds.length === 0
                ? _jsx("div", { className: css.empty, children: t('protocolNoServers') })
                : traces.length === 0
                    ? _jsx("div", { className: css.empty, children: t('protocolEmpty') })
                    : (_jsx("ul", { className: css.list, children: traces.map(({ server, entry }, i) => (_jsxs("li", { className: css.item, children: [_jsx("span", { className: css.time, children: formatTime(entry.time) }), _jsx("span", { className: `${css.dir} ${css[entry.dir]}`, children: entry.dir === 'send' ? t('protocolSend') : t('protocolRecv') }), _jsx("span", { className: css.method, children: entry.method }), _jsx("span", { className: css.server, children: server }), _jsx("span", { className: css.summary, children: entry.summary })] }, i))) }))] }));
}
//# sourceMappingURL=AcpProtocolView.js.map