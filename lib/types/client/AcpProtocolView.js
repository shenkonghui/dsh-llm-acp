import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/** ACP Protocol inspector: conversation view showing recent JSON-RPC interactions. */
import { useCallback, useEffect, useRef, useState } from 'react';
import css from './AcpProtocolView.module.css';
/** Poll interval for trace data. */
const POLL_MS = 3_000;
/** Maximum entries shown in the list (matches the host ring buffer). */
const MAX_LIST = 100;
/** Format a timestamp as HH:MM:SS.mmm. */
function formatTime(ms) {
    const d = new Date(ms);
    const pad = (n, l = 2) => n.toString().padStart(l, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
/** Stable identity for one row across refreshes. */
function rowKey(row) {
    return `${row.server}:${row.entry.time}:${row.entry.method}`;
}
/**
 * Poll all configured ACP servers for their recent protocol trace entries and
 * render them in a scrollable list. The view refreshes every 3 seconds while
 * visible. Clicking an entry opens a detail pane with the full payload.
 */
export function AcpProtocolView({ api, settingsNs, t, }) {
    const [traces, setTraces] = useState([]);
    const [loading, setLoading] = useState(false);
    const [serverIds, setServerIds] = useState([]);
    const [selected, setSelected] = useState(null);
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
                setTraces(all.slice(0, MAX_LIST));
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
    return (_jsxs("div", { className: css.container, children: [_jsxs("div", { className: css.header, children: [_jsx("span", { className: css.title, children: t('protocolTitle') }), _jsx("button", { type: "button", className: css.refreshBtn, onClick: () => { void refresh(); }, disabled: loading, children: loading ? t('protocolRefreshing') : t('protocolRefresh') })] }), _jsxs("div", { className: css.main, children: [serverIds.length === 0
                        ? _jsx("div", { className: css.empty, children: t('protocolNoServers') })
                        : traces.length === 0
                            ? _jsx("div", { className: css.empty, children: t('protocolEmpty') })
                            : (_jsx("ul", { className: css.list, children: traces.map((row, i) => (_jsxs("li", { className: `${css.item} ${selected !== null && rowKey(selected) === rowKey(row) ? css.selected : ''}`, onClick: () => {
                                        setSelected(selected !== null && rowKey(selected) === rowKey(row) ? null : row);
                                    }, children: [_jsx("span", { className: css.time, children: formatTime(row.entry.time) }), _jsx("span", { className: `${css.dir} ${css[row.entry.dir]}`, children: row.entry.dir === 'send' ? t('protocolSend') : t('protocolRecv') }), _jsx("span", { className: css.method, children: row.entry.method }), _jsx("span", { className: css.server, children: row.server }), _jsxs("span", { className: css.summary, children: [row.entry.summary, row.entry.count !== undefined && row.entry.count > 1 && (_jsxs("span", { className: css.count, children: ["\u00D7", row.entry.count] }))] })] }, i))) })), selected !== null && (_jsxs("div", { className: css.detail, children: [_jsxs("div", { className: css.detailHeader, children: [_jsx("span", { className: css.detailTitle, children: selected.entry.method }), _jsx("button", { type: "button", className: css.detailClose, onClick: () => { setSelected(null); }, children: "\u00D7" })] }), _jsxs("div", { className: css.detailBody, children: [_jsxs("dl", { className: css.kv, children: [_jsx("dt", { children: t('protocolFieldTime') }), _jsx("dd", { children: formatTime(selected.entry.time) }), _jsx("dt", { children: t('protocolFieldDir') }), _jsx("dd", { children: selected.entry.dir === 'send' ? t('protocolSend') : t('protocolRecv') }), _jsx("dt", { children: t('protocolFieldMethod') }), _jsx("dd", { children: selected.entry.method }), _jsx("dt", { children: t('protocolFieldServer') }), _jsx("dd", { children: selected.server }), selected.entry.count !== undefined && selected.entry.count > 1 && (_jsxs(_Fragment, { children: [_jsx("dt", { children: t('protocolFieldCount') }), _jsxs("dd", { children: ["\u00D7", selected.entry.count] })] })), _jsx("dt", { children: t('protocolFieldSummary') }), _jsx("dd", { children: selected.entry.summary })] }), _jsx("div", { className: css.rawTitle, children: t('protocolRaw') }), _jsx("pre", { className: css.raw, children: selected.entry.detail ?? selected.entry.summary })] })] }))] })] }));
}
//# sourceMappingURL=AcpProtocolView.js.map