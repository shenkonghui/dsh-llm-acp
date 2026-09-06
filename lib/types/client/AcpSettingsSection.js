import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/** ACP Servers settings section: registry browser and configured-server list. */
import { useEffect, useMemo, useRef, useState } from 'react';
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
/** Load the full discovered model catalog for one ACP provider route.
 * Uses model discovery (not the filtered catalog) so the reply is the
 * unfiltered set — `listModels` already applies the server's `enabledModels`
 * selection, which would hide unselected models from the multi-select editor. */
async function loadProviderModels(api, settingsNs, providerRoute) {
    try {
        const response = await api.discoverModels(settingsNs, providerRoute);
        if (!response.ok)
            return [];
        return (response.value ?? []).map(m => ({ id: m.id, name: m.name ?? m.id }));
    }
    catch {
        return [];
    }
}
/** Convert an env record to editable draft rows. */
function envToDrafts(env) {
    if (env === undefined)
        return [];
    return Object.entries(env).map(([key, value]) => ({ key, value }));
}
/** Convert editable draft rows back to an env record, skipping empty keys. */
function draftsToEnv(rows) {
    const env = {};
    for (const row of rows) {
        const key = row.key.trim();
        if (key.length > 0)
            env[key] = row.value;
    }
    return env;
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
    const [expandedId, setExpandedId] = useState();
    const [envDrafts, setEnvDrafts] = useState({});
    const [modelDrafts, setModelDrafts] = useState({});
    const [discoveredModels, setDiscoveredModels] = useState({});
    const [modelsLoading, setModelsLoading] = useState(new Set());
    const [modelSearch, setModelSearch] = useState({});
    const [savingId, setSavingId] = useState();
    /** Revision of the `llm-acp` namespace at the last read; sent back on writes
     * so a stale editor is refused instead of silently overwriting. */
    const revisionRef = useRef(undefined);
    /** Load current servers from settings. */
    const loadServers = async () => {
        try {
            const response = await api.describeSettings();
            if (response.ok) {
                const ns = response.value?.namespaces.find(v => v.ns === settingsNs);
                if (ns !== undefined) {
                    revisionRef.current = ns.revision;
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
            const serverEntry = { command: cmd.command, args: cmd.args, name: agent.name, env: {}, models: [] };
            const response = await api.mutateSettings(settingsNs, [{ op: 'set', path: ['servers', agent.id], value: serverEntry }], revisionRef.current);
            if (!response.ok) {
                setError(response.error?.message ?? 'unknown error');
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
            const response = await api.mutateSettings(settingsNs, [{ op: 'unset', path: ['servers', id] }], revisionRef.current);
            if (!response.ok) {
                setError(response.error?.message ?? 'unknown error');
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
    /** Expand a server card, loading drafts and discovered models. */
    const expandServer = async (id) => {
        if (expandedId === id) {
            setExpandedId(undefined);
            return;
        }
        const server = servers[id];
        setExpandedId(id);
        if (server !== undefined) {
            setEnvDrafts(prev => ({ ...prev, [id]: envToDrafts(server.env) }));
            setModelDrafts(prev => ({ ...prev, [id]: server.models ?? [] }));
        }
        // Fetch discovered models for this provider route.
        setModelsLoading(prev => new Set(prev).add(id));
        const models = await loadProviderModels(api, settingsNs, `acp-${id}`);
        setDiscoveredModels(prev => ({ ...prev, [id]: models }));
        setModelsLoading(prev => {
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
    };
    /** Save the editable drafts for one server to settings. */
    const saveServerConfig = async (id) => {
        setSavingId(id);
        setError(undefined);
        try {
            const env = draftsToEnv(envDrafts[id] ?? []);
            const models = modelDrafts[id] ?? [];
            const response = await api.mutateSettings(settingsNs, [
                { op: 'set', path: ['servers', id, 'env'], value: env },
                { op: 'set', path: ['servers', id, 'models'], value: models },
            ], revisionRef.current);
            if (!response.ok) {
                setError(response.error?.message ?? 'unknown error');
            }
            else {
                await loadServers();
            }
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
        setSavingId(undefined);
    };
    /** Update one env draft row. */
    const updateEnvRow = (serverId, index, patch) => {
        setEnvDrafts(prev => {
            const rows = [...(prev[serverId] ?? [])];
            const row = rows[index];
            if (row === undefined)
                return prev;
            rows[index] = { ...row, ...patch };
            return { ...prev, [serverId]: rows };
        });
    };
    /** Add an empty env draft row. */
    const addEnvRow = (serverId) => {
        setEnvDrafts(prev => ({
            ...prev,
            [serverId]: [...(prev[serverId] ?? []), { key: '', value: '' }],
        }));
    };
    /** Remove one env draft row. */
    const removeEnvRow = (serverId, index) => {
        setEnvDrafts(prev => {
            const rows = [...(prev[serverId] ?? [])];
            rows.splice(index, 1);
            return { ...prev, [serverId]: rows };
        });
    };
    /** Toggle one model in the model draft selection. */
    const toggleModel = (serverId, modelId) => {
        setModelDrafts(prev => {
            const current = new Set(prev[serverId] ?? []);
            if (current.has(modelId)) {
                current.delete(modelId);
            }
            else {
                current.add(modelId);
            }
            return { ...prev, [serverId]: [...current] };
        });
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
                        }) }))] })), tab === 'servers' && (_jsx("div", { className: css.panel, children: !loading && serverList.length === 0 ? (_jsx("p", { className: css.empty, children: t('noServers') })) : (_jsx("div", { className: css.list, children: serverList.map(([id, server]) => {
                        const isExpanded = expandedId === id;
                        const rows = envDrafts[id] ?? [];
                        const selectedModels = modelDrafts[id] ?? [];
                        const models = discoveredModels[id] ?? [];
                        const isLoadingModels = modelsLoading.has(id);
                        return (_jsxs("div", { className: css.serverCardBlock, children: [_jsxs("div", { className: css.serverCard, children: [_jsxs("div", { className: css.agentInfo, children: [_jsx("p", { className: css.agentName, children: server.name }), _jsxs("p", { className: css.serverCommand, children: [t('serverCommand'), ": ", server.command, " ", server.args.join(' ')] }), _jsx("div", { className: css.agentMeta, children: _jsxs("span", { children: ["acp-", id] }) })] }), _jsxs("div", { className: css.cardActions, children: [_jsx("button", { type: "button", className: css.editButton, onClick: () => { void expandServer(id); }, children: isExpanded ? t('collapse') : t('edit') }), _jsx("button", { type: "button", className: css.removeButton, disabled: removingId === id, onClick: () => {
                                                        if (window.confirm(t('removeConfirm'))) {
                                                            void removeServer(id);
                                                        }
                                                    }, children: removingId === id ? '…' : t('remove') })] })] }), isExpanded && (_jsxs("div", { className: css.serverDetail, children: [_jsxs("div", { className: css.detailSection, children: [_jsx("p", { className: css.detailHeading, children: t('envVars') }), _jsx("p", { className: css.detailHint, children: t('envVarsHint') }), rows.length === 0 ? (_jsx("p", { className: css.emptyInline, children: t('noEnvVars') })) : (_jsx("div", { className: css.envList, children: rows.map((row, index) => (_jsxs("div", { className: css.envRow, children: [_jsx("input", { type: "text", className: css.envKey, placeholder: t('envKey'), value: row.key, onChange: e => { updateEnvRow(id, index, { key: e.target.value }); } }), _jsx("input", { type: "text", className: css.envValue, placeholder: t('envValue'), value: row.value, onChange: e => { updateEnvRow(id, index, { value: e.target.value }); } }), _jsx("button", { type: "button", className: css.envRemove, onClick: () => { removeEnvRow(id, index); }, children: "\u00D7" })] }, index))) })), _jsxs("button", { type: "button", className: css.addEnvButton, onClick: () => { addEnvRow(id); }, children: ["+ ", t('addEnvVar')] })] }), _jsxs("div", { className: css.detailSection, children: [_jsx("p", { className: css.detailHeading, children: t('modelSelect') }), _jsx("p", { className: css.detailHint, children: t('modelSelectHint') }), isLoadingModels ? (_jsx("p", { className: css.emptyInline, children: t('modelsLoading') })) : models.length === 0 ? (_jsx("p", { className: css.emptyInline, children: t('noModels') })) : (_jsxs(_Fragment, { children: [_jsx("input", { type: "search", className: css.modelSearch, placeholder: t('modelSearch'), value: modelSearch[id] ?? '', onChange: e => { setModelSearch(prev => ({ ...prev, [id]: e.target.value })); } }), _jsx("div", { className: css.modelList, children: models
                                                                .filter(model => {
                                                                const q = (modelSearch[id] ?? '').trim().toLowerCase();
                                                                if (q === '')
                                                                    return true;
                                                                return model.name.toLowerCase().includes(q) || model.id.toLowerCase().includes(q);
                                                            })
                                                                .sort((a, b) => {
                                                                const aSelected = selectedModels.includes(a.id) ? 0 : 1;
                                                                const bSelected = selectedModels.includes(b.id) ? 0 : 1;
                                                                return aSelected - bSelected;
                                                            })
                                                                .map(model => {
                                                                const checked = selectedModels.includes(model.id);
                                                                return (_jsxs("label", { className: css.modelRow, children: [_jsx("input", { type: "checkbox", checked: checked, onChange: () => { toggleModel(id, model.id); } }), _jsx("span", { className: css.modelName, children: model.name }), _jsx("span", { className: css.modelId, children: model.id })] }, model.id));
                                                            }) })] })), models.length > 0 && (_jsxs("div", { className: css.modelActions, children: [_jsx("button", { type: "button", className: css.linkButton, onClick: () => { setModelDrafts(prev => ({ ...prev, [id]: models.map(m => m.id) })); }, children: t('selectAll') }), _jsx("button", { type: "button", className: css.linkButton, onClick: () => { setModelDrafts(prev => ({ ...prev, [id]: [] })); }, children: t('selectNone') })] }))] }), _jsx("button", { type: "button", className: css.saveButton, disabled: savingId === id, onClick: () => { void saveServerConfig(id); }, children: savingId === id ? t('saving') : t('save') })] }))] }, id));
                    }) })) }))] }));
}
//# sourceMappingURL=AcpSettingsSection.js.map