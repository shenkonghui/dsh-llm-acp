import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** ACP Servers settings section: registry browser and configured-server list. */
import { useEffect, useMemo, useState } from 'react';
import css from './AcpSettingsSection.module.css';
/** Detect the current platform for binary distribution selection. */
function currentPlatform() {
    const platform = typeof navigator !== 'undefined' ? navigator.platform : '';
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const isMac = /mac/i.test(platform);
    const isWin = /win/i.test(platform);
    const isArm = /arm|aarch64/i.test(ua) || /arm|aarch64/i.test(platform);
    if (isMac)
        return isArm ? 'darwin-aarch64' : 'darwin-x86_64';
    if (isWin)
        return isArm ? 'windows-aarch64' : 'windows-x86_64';
    return isArm ? 'linux-aarch64' : 'linux-x86_64';
}
/** Derive command and args from a registry agent's distribution.
 * For binary distributions, the registry's `cmd` is a path relative to the
 * extracted archive directory (e.g. `./bin/devin`). Since the user typically
 * has the agent binary installed in PATH, extract the basename and use it
 * directly. */
function deriveCommand(agent) {
    const dist = agent.distribution;
    if (dist.npx) {
        return { command: 'npx', args: ['-y', dist.npx.package, ...(dist.npx.args ?? [])] };
    }
    if (dist.uvx) {
        return { command: 'uvx', args: [dist.uvx.package, ...(dist.uvx.args ?? [])] };
    }
    if (dist.binary) {
        const plat = currentPlatform();
        const entry = dist.binary[plat] ?? dist.binary[Object.keys(dist.binary)[0] ?? ''];
        if (entry === undefined)
            return undefined;
        // The registry `cmd` is relative to the archive's extraction directory
        // (e.g. `./bin/devin`). Use the basename so the command resolves through
        // PATH, where the user's installed binary lives.
        const cmd = entry.cmd.replace(/^.*\//, '');
        return { command: cmd, args: entry.args ?? [] };
    }
    return undefined;
}
/** Distribution type label for display. */
function distributionType(agent) {
    const dist = agent.distribution;
    if (dist.npx)
        return 'npx';
    if (dist.uvx)
        return 'uvx';
    if (dist.binary)
        return 'binary';
    return 'unknown';
}
/** Render the ACP Servers settings section. */
export function AcpSettingsSection(props) {
    const { t, registry, api, settingsNs } = props;
    const [tab, setTab] = useState('registry');
    const [search, setSearch] = useState('');
    const [servers, setServers] = useState({});
    const [loading, setLoading] = useState(true);
    const [addingId, setAddingId] = useState();
    const [removingId, setRemovingId] = useState();
    const [error, setError] = useState();
    /** Load current servers from settings. */
    const loadServers = async () => {
        try {
            const response = await api.settings.describe({});
            if (response.result.ok) {
                const views = response.result.value.namespaces;
                const ns = views.find(v => v.ns === settingsNs);
                if (ns !== undefined) {
                    const data = ns.value;
                    setServers(data?.servers ?? {});
                }
            }
        }
        catch {
            // Settings section may not exist yet — that's the empty state.
            setServers({});
        }
        setLoading(false);
    };
    useEffect(() => { void loadServers(); }, []);
    /** Add a registry agent as a configured server. */
    const addServer = async (agent) => {
        const cmd = deriveCommand(agent);
        if (cmd === undefined)
            return;
        setAddingId(agent.id);
        setError(undefined);
        try {
            const serverEntry = { command: cmd.command, args: cmd.args, name: agent.name };
            const response = await api.settings.mutate({
                ns: settingsNs,
                ops: [{ op: 'set', path: ['servers', agent.id], value: serverEntry }],
            });
            if (!response.result.ok) {
                setError(response.result.error.message);
            }
            else {
                await loadServers();
            }
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
        setAddingId(undefined);
    };
    /** Remove a configured server. */
    const removeServer = async (id) => {
        setRemovingId(id);
        setError(undefined);
        try {
            const response = await api.settings.mutate({
                ns: settingsNs,
                ops: [{ op: 'unset', path: ['servers', id] }],
            });
            if (!response.result.ok) {
                setError(response.result.error.message);
            }
            else {
                await loadServers();
            }
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
        setRemovingId(undefined);
    };
    const filteredAgents = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (q === '')
            return registry.agents;
        return registry.agents.filter((a) => a.name.toLowerCase().includes(q) ||
            a.id.toLowerCase().includes(q) ||
            a.description.toLowerCase().includes(q));
    }, [registry.agents, search]);
    const serverList = Object.entries(servers).sort(([a], [b]) => a.localeCompare(b));
    return (_jsxs("div", { className: css.section, children: [_jsx("h2", { className: css.heading, children: t('title') }), _jsx("p", { className: css.intro, children: t('intro') }), _jsxs("div", { className: css.tabs, role: "tablist", children: [_jsx("button", { type: "button", role: "tab", className: css.tab, "aria-selected": tab === 'registry', "data-active": tab === 'registry' ? 'true' : undefined, onClick: () => { setTab('registry'); }, children: t('registryTab') }), _jsx("button", { type: "button", role: "tab", className: css.tab, "aria-selected": tab === 'servers', "data-active": tab === 'servers' ? 'true' : undefined, onClick: () => { setTab('servers'); }, children: t('serversTab') })] }), error !== undefined && _jsx("div", { className: css.error, children: error }), tab === 'registry' && (_jsxs("div", { className: css.panel, children: [_jsx("input", { type: "search", className: css.search, placeholder: t('registrySearch'), value: search, onChange: e => { setSearch(e.target.value); } }), filteredAgents.length === 0 ? (_jsx("p", { className: css.empty, children: t('registryEmpty') })) : (_jsx("div", { className: css.list, children: filteredAgents.map((agent) => {
                            const isAdded = servers[agent.id] !== undefined;
                            const distType = distributionType(agent);
                            return (_jsxs("div", { className: css.agentCard, children: [_jsxs("div", { className: css.agentInfo, children: [_jsx("p", { className: css.agentName, children: agent.name }), _jsx("p", { className: css.agentDesc, children: agent.description }), _jsxs("div", { className: css.agentMeta, children: [_jsx("span", { className: css.distBadge, children: distType }), _jsxs("span", { children: [t('version'), ": ", agent.version] }), agent.authors !== undefined && agent.authors.length > 0 && (_jsxs("span", { children: [t('authors'), ": ", agent.authors.join(', ')] }))] })] }), _jsx("button", { type: "button", className: css.addButton, disabled: isAdded || addingId === agent.id, onClick: () => { void addServer(agent); }, children: isAdded ? t('added') : addingId === agent.id ? t('adding') : t('add') })] }, agent.id));
                        }) }))] })), tab === 'servers' && (_jsx("div", { className: css.panel, children: !loading && serverList.length === 0 ? (_jsx("p", { className: css.empty, children: t('noServers') })) : (_jsx("div", { className: css.list, children: serverList.map(([id, server]) => (_jsxs("div", { className: css.serverCard, children: [_jsxs("div", { className: css.agentInfo, children: [_jsx("p", { className: css.agentName, children: server.name }), _jsxs("p", { className: css.serverCommand, children: [t('serverCommand'), ": ", server.command, " ", server.args.join(' ')] }), _jsx("div", { className: css.agentMeta, children: _jsxs("span", { children: ["acp-", id] }) })] }), _jsx("button", { type: "button", className: css.removeButton, disabled: removingId === id, onClick: () => {
                                    if (window.confirm(t('removeConfirm'))) {
                                        void removeServer(id);
                                    }
                                }, children: removingId === id ? '…' : t('remove') })] }, id))) })) }))] }));
}
//# sourceMappingURL=AcpSettingsSection.js.map