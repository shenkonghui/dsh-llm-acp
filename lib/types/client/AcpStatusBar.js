import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** Sidebar footer indicator showing ACP server connection status. */
import { useEffect, useState } from 'react';
import css from './AcpStatusBar.module.css';
/** Probe one ACP server by calling discoverModels; resolve to a status row. */
async function probeServer(api, settingsNs, id, server) {
    const row = { id, name: server.name, status: 'checking', modelCount: 0 };
    try {
        const response = await api.discoverModels(settingsNs, `acp-${id}`);
        if (response.ok) {
            const models = response.value ?? [];
            row.status = 'connected';
            row.modelCount = models.length;
        }
        else {
            row.status = 'disconnected';
        }
    }
    catch {
        row.status = 'disconnected';
    }
    return row;
}
/** Fetch configured servers from settings, then probe each in parallel. */
async function loadServerStatuses(api, settingsNs) {
    let servers = {};
    try {
        const response = await api.describeSettings();
        if (response.ok) {
            const ns = response.value?.namespaces.find((v) => v.ns === settingsNs);
            if (ns !== undefined) {
                const data = ns.value;
                servers = data?.servers ?? {};
            }
        }
    }
    catch {
        // Settings read failure — show nothing.
        return [];
    }
    const entries = Object.entries(servers);
    if (entries.length === 0)
        return [];
    return Promise.all(entries.map(([id, server]) => probeServer(api, settingsNs, id, server)));
}
/** Render the ACP connection-status indicator for the sidebar footer. */
export function AcpStatusBar(props) {
    const { t, api, settingsNs } = props;
    const [rows, setRows] = useState([]);
    const [expanded, setExpanded] = useState(false);
    useEffect(() => {
        let cancelled = false;
        const refresh = async () => {
            const next = await loadServerStatuses(api, settingsNs);
            if (!cancelled)
                setRows(next);
        };
        void refresh();
        const timer = setInterval(refresh, 30_000);
        return () => { cancelled = true; clearInterval(timer); };
    }, [api, settingsNs]);
    if (rows.length === 0)
        return null;
    const connected = rows.filter(r => r.status === 'connected').length;
    const total = rows.length;
    const allConnected = connected === total;
    const noneConnected = connected === 0;
    const dotClass = allConnected
        ? css.dotOk
        : noneConnected
            ? css.dotErr
            : css.dotWarn;
    const summary = t('statusSummary')
        .replace('{connected}', String(connected))
        .replace('{total}', String(total));
    return (_jsxs("div", { className: css.wrapper, children: [_jsxs("button", { type: "button", className: css.trigger, onClick: () => { setExpanded(v => !v); }, title: summary, children: [_jsx("span", { className: `${css.dot} ${dotClass}` }), _jsx("span", { className: css.label, children: t('statusLabel') }), _jsxs("span", { className: css.count, children: [connected, "/", total] })] }), expanded && (_jsx("div", { className: css.popover, children: rows.map(row => (_jsxs("div", { className: css.serverRow, children: [_jsx("span", { className: `${css.dot} ${row.status === 'connected'
                                ? css.dotOk
                                : row.status === 'disconnected'
                                    ? css.dotErr
                                    : css.dotPending}` }), _jsx("span", { className: css.serverName, children: row.name }), _jsx("span", { className: css.serverDetail, children: row.status === 'connected'
                                ? t('statusConnected').replace('{n}', String(row.modelCount))
                                : row.status === 'disconnected'
                                    ? t('statusDisconnected')
                                    : t('statusChecking') })] }, row.id))) }))] }));
}
//# sourceMappingURL=AcpStatusBar.js.map