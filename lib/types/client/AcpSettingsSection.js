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
/** Derive the bin name an npm package installs (heuristic: last path segment
 * of the package name, without scope or version). `@scope/name@ver` → `name`,
 * `name@ver` → `name`. Used to probe PATH before falling back to `npx -y`. */
function npmBinName(pkg) {
    if (pkg.startsWith('@')) {
        const scoped = pkg.split('@', 2)[1];
        return scoped?.split('/').pop();
    }
    return pkg.split('@')[0];
}
/** Probe the host PATH for `bin` via the `acp-resolve-<bin>` discovery route.
 * Returns the absolute path when found, `undefined` otherwise. */
async function resolveBinInPath(api, settingsNs, bin) {
    try {
        const response = await api.discoverModels(settingsNs, `acp-resolve-${bin}`);
        if (!response.ok)
            return undefined;
        return (response.value ?? [])[0]?.id;
    }
    catch {
        return undefined;
    }
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
/** Load the live server identity (agent name/version, ACP protocol version)
 * via the `acp-info-<id>` discovery route. Returns `undefined` when the
 * server has not yet completed `initialize` or omits `agentInfo`. */
async function loadServerInfo(api, settingsNs, serverId) {
    try {
        const response = await api.discoverModels(settingsNs, `acp-info-${serverId}`);
        if (!response.ok)
            return undefined;
        const entry = (response.value ?? [])[0];
        // The host reports failures as `{ id: 'error', name: <reason> }`; the
        // version label treats those as "no info yet".
        if (entry === undefined || entry.id === 'error')
            return undefined;
        const protocolVersion = entry.contextWindow;
        return {
            agentName: entry.id,
            agentVersion: entry.name ?? '',
            ...(protocolVersion === undefined ? {} : { protocolVersion }),
        };
    }
    catch {
        return undefined;
    }
}
/** Load the pending interactive-auth browser login URL for one server via the
 * `acp-auth-<id>` discovery route. Returns `undefined` when no login is
 * pending or the host runs a stale build without the route. */
async function loadAuthUrl(api, settingsNs, serverId) {
    try {
        const response = await api.discoverModels(settingsNs, `acp-auth-${serverId}`);
        if (!response.ok)
            return undefined;
        const entry = (response.value ?? [])[0];
        return entry !== undefined && entry.id === 'auth' && entry.name.length > 0 ? entry.name : undefined;
    }
    catch {
        return undefined;
    }
}
/** Compact version label for a server card: live agent version first, then
 * the registry version as a fallback when the server has not reported yet. */
function serverVersionLabel(info, registryAgent) {
    if (info !== undefined && info.agentVersion.length > 0)
        return `v${info.agentVersion}`;
    if (registryAgent !== undefined)
        return `v${registryAgent.version}`;
    return undefined;
}
const TEST_STEP_IDS = ['handshake', 'models', 'message'];
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
/** Empty custom-agent draft. */
function emptyCustomDraft() {
    return { id: '', name: '', command: '', args: '', env: [] };
}
/** Parse a space-separated args string into an array, handling simple quoting. */
function parseArgs(args) {
    const trimmed = args.trim();
    if (trimmed.length === 0)
        return [];
    // Simple split on whitespace; does not handle escaped quotes, but covers
    // the common case (e.g. `-y @scope/pkg --flag value`).
    return trimmed.split(/\s+/);
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
    const [customModelDrafts, setCustomModelDrafts] = useState({});
    const [discoveredModels, setDiscoveredModels] = useState({});
    const [modelsLoading, setModelsLoading] = useState(new Set());
    const [modelSearch, setModelSearch] = useState({});
    const [savingId, setSavingId] = useState();
    const [serverInfo, setServerInfo] = useState({});
    const [authUrls, setAuthUrls] = useState({});
    const [testServer, setTestServer] = useState();
    const [testSteps, setTestSteps] = useState({
        handshake: { status: 'running' },
        models: { status: 'running' },
        message: { status: 'running' },
    });
    const [showCustomForm, setShowCustomForm] = useState(false);
    const [customDraft, setCustomDraft] = useState(emptyCustomDraft());
    const [customSaving, setCustomSaving] = useState(false);
    const [customError, setCustomError] = useState();
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
                    const next = data?.servers ?? {};
                    setServers(next);
                    // Best-effort: refresh live server version info. The `acp-info-<id>`
                    // route reads the cached `initialize` identity (no session), so the
                    // parallel fetches are cheap; each resolves independently and may
                    // stay `undefined` until the connection finishes initializing.
                    for (const id of Object.keys(next)) {
                        void loadServerInfo(api, settingsNs, id).then(info => {
                            setServerInfo(prev => (prev[id] === info ? prev : { ...prev, [id]: info }));
                        });
                        void loadAuthUrl(api, settingsNs, id).then(url => {
                            setAuthUrls(prev => (prev[id] === url ? prev : { ...prev, [id]: url }));
                        });
                    }
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
    /** Add a registry agent as a configured server. For `npx -y <pkg>` agents,
     * probe the host PATH first and store the local bin directly when present,
     * so the UI shows and the spawn uses the installed binary without an npm
     * fetch on every start. */
    const addServer = async (agent) => {
        const cmd = deriveCommand(agent);
        if (cmd === undefined)
            return;
        setAddingId(agent.id);
        setError(undefined);
        try {
            let command = cmd.command;
            let args = cmd.args;
            if (command === 'npx' && agent.distribution.npx !== undefined) {
                const bin = npmBinName(agent.distribution.npx.package);
                if (bin !== undefined) {
                    const resolved = await resolveBinInPath(api, settingsNs, bin);
                    if (resolved !== undefined) {
                        command = resolved;
                        args = agent.distribution.npx.args ?? [];
                    }
                }
            }
            const serverEntry = { command, args, name: agent.name, env: {}, models: [] };
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
    /** Add a custom ACP agent from the user-filled form. Validates the ID
     * (required, not already in use) and command (required), then writes the
     * server entry to settings — same shape as a registry agent. */
    const addCustomServer = async () => {
        setCustomError(undefined);
        const id = customDraft.id.trim();
        const command = customDraft.command.trim();
        const name = customDraft.name.trim() || id;
        if (id.length === 0) {
            setCustomError(t('customIdRequired'));
            return;
        }
        if (command.length === 0) {
            setCustomError(t('customCommandRequired'));
            return;
        }
        if (servers[id] !== undefined) {
            setCustomError(t('customIdExists'));
            return;
        }
        setCustomSaving(true);
        try {
            const serverEntry = {
                command,
                args: parseArgs(customDraft.args),
                name,
                env: draftsToEnv(customDraft.env),
                models: [],
            };
            const response = await api.mutateSettings(settingsNs, [{ op: 'set', path: ['servers', id], value: serverEntry }], revisionRef.current);
            if (!response.ok) {
                setCustomError(response.error?.message ?? 'unknown error');
            }
            else {
                setShowCustomForm(false);
                setCustomDraft(emptyCustomDraft());
                await loadServers();
            }
        }
        catch (err) {
            setCustomError(err instanceof Error ? err.message : String(err));
        }
        setCustomSaving(false);
    };
    /** Update one custom-form env draft row. */
    const updateCustomEnvRow = (index, patch) => {
        setCustomDraft(prev => {
            const rows = [...prev.env];
            const row = rows[index];
            if (row === undefined)
                return prev;
            rows[index] = { ...row, ...patch };
            return { ...prev, env: rows };
        });
    };
    /** Add an empty env row to the custom form. */
    const addCustomEnvRow = () => {
        setCustomDraft(prev => ({ ...prev, env: [...prev.env, { key: '', value: '' }] }));
    };
    /** Remove one env row from the custom form. */
    const removeCustomEnvRow = (index) => {
        setCustomDraft(prev => {
            const rows = [...prev.env];
            rows.splice(index, 1);
            return { ...prev, env: rows };
        });
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
            setCustomModelDrafts(prev => ({
                ...prev,
                [id]: (server.customModels ?? []).map(m => ({ id: m.id, name: m.name })),
            }));
        }
        // Fetch discovered models and live server info for this provider route.
        setModelsLoading(prev => new Set(prev).add(id));
        const [models, info, authUrl] = await Promise.all([
            loadProviderModels(api, settingsNs, `acp-${id}`),
            loadServerInfo(api, settingsNs, id),
            loadAuthUrl(api, settingsNs, id),
        ]);
        setDiscoveredModels(prev => ({ ...prev, [id]: models }));
        setServerInfo(prev => (prev[id] === info ? prev : { ...prev, [id]: info }));
        setAuthUrls(prev => (prev[id] === authUrl ? prev : { ...prev, [id]: authUrl }));
        setModelsLoading(prev => {
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
    };
    /** Re-fetch the model catalog and live server info for one server. */
    const refreshModels = async (id) => {
        setModelsLoading(prev => new Set(prev).add(id));
        const [models, info, authUrl] = await Promise.all([
            loadProviderModels(api, settingsNs, `acp-${id}`),
            loadServerInfo(api, settingsNs, id),
            loadAuthUrl(api, settingsNs, id),
        ]);
        setDiscoveredModels(prev => ({ ...prev, [id]: models }));
        setServerInfo(prev => (prev[id] === info ? prev : { ...prev, [id]: info }));
        setAuthUrls(prev => (prev[id] === authUrl ? prev : { ...prev, [id]: authUrl }));
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
            const customModels = (customModelDrafts[id] ?? [])
                .filter(m => m.id.trim().length > 0)
                .map(m => ({ id: m.id.trim(), name: m.name.trim() }));
            const response = await api.mutateSettings(settingsNs, [
                { op: 'set', path: ['servers', id, 'env'], value: env },
                { op: 'set', path: ['servers', id, 'models'], value: models },
                { op: 'set', path: ['servers', id, 'customModels'], value: customModels },
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
    /** Update one test step's state. */
    const setTestStep = (step, state) => {
        setTestSteps(prev => ({ ...prev, [step]: state }));
    };
    /** Run the end-to-end server test: handshake → model catalog → probe prompt.
     * Each step runs only when the previous one passed; failures short-circuit
     * the remaining steps so a dead server doesn't burn three timeouts. Every
     * failure surfaces the underlying error message in its detail line. */
    const runTest = async (id, name) => {
        setTestServer({ id, name });
        setTestSteps({
            handshake: { status: 'running' },
            models: { status: 'running' },
            message: { status: 'running' },
        });
        /** Call one discovery route, converting thrown transport errors into the
         * failure branch so every step can show a concrete reason. */
        const rawDiscover = async (provider) => {
            try {
                return await api.discoverModels(settingsNs, provider);
            }
            catch (err) {
                return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
            }
        };
        // Step 1: handshake — the `acp-info-<id>` route reads the cached
        // `initialize` identity and reports the concrete failure reason.
        const infoRes = await rawDiscover(`acp-info-${id}`);
        const infoEntry = (infoRes.ok ? infoRes.value ?? [] : [])[0];
        if (infoRes.error !== undefined) {
            setTestStep('handshake', { status: 'fail', detail: infoRes.error.message });
            setTestStep('models', { status: 'fail', detail: t('testSkipped') });
            setTestStep('message', { status: 'fail', detail: t('testSkipped') });
            return;
        }
        if (infoEntry === undefined || infoEntry.id === 'error') {
            setTestStep('handshake', {
                status: 'fail',
                detail: infoEntry?.name ?? t('testHandshakeFail'),
            });
            setTestStep('models', { status: 'fail', detail: t('testSkipped') });
            setTestStep('message', { status: 'fail', detail: t('testSkipped') });
            return;
        }
        // `id: 'unknown'` means initialize succeeded but agentInfo was missing
        // (the SDK silently drops invalid agentInfo). The server may still be
        // functional, so the handshake passes with a warning; the detail carries
        // the full diagnostic from the host.
        if (infoEntry.id === 'unknown') {
            setTestStep('handshake', {
                status: 'pass',
                detail: infoEntry.name,
            });
        }
        else {
            setTestStep('handshake', {
                status: 'pass',
                detail: `${infoEntry.id} v${infoEntry.name}`
                    + (infoEntry.contextWindow !== undefined ? ` · ${t('serverProtocol')}: ${infoEntry.contextWindow}` : ''),
            });
        }
        // Step 2: model catalog via the provider route.
        const modelsRes = await rawDiscover(`acp-${id}`);
        const models = (modelsRes.ok ? modelsRes.value ?? [] : []).map(m => ({ id: m.id, name: m.name ?? m.id }));
        if (!modelsRes.ok) {
            setTestStep('models', {
                status: 'fail',
                detail: modelsRes.error?.message ?? t('testNoModels'),
            });
            setTestStep('message', { status: 'fail', detail: t('testSkipped') });
            return;
        }
        if (models.length === 0) {
            setTestStep('models', {
                status: 'fail',
                detail: `${t('testNoModels')} — the server connected but returned an empty model catalog; the agent may not have discovered any models yet, or it may manage models internally`,
            });
            setTestStep('message', { status: 'fail', detail: t('testSkipped') });
            return;
        }
        setTestStep('models', {
            status: 'pass',
            detail: `${models.length} · ${models.slice(0, 5).map(m => m.id).join(', ')}${models.length > 5 ? '…' : ''}`,
        });
        // Step 3: end-to-end prompt via the `acp-test-<id>` route. An empty reply
        // means the host never hit the route — typically a stale host build.
        const msgRes = await rawDiscover(`acp-test-${id}`);
        const entry = (msgRes.ok ? msgRes.value ?? [] : [])[0];
        if (entry?.id === 'ok') {
            setTestStep('message', { status: 'pass', detail: entry.name });
        }
        else if (entry?.id === 'error') {
            setTestStep('message', {
                status: 'fail',
                detail: entry.name,
            });
        }
        else {
            setTestStep('message', {
                status: 'fail',
                detail: msgRes.error?.message ?? t('testNoResponse'),
            });
        }
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
    /** Update one custom model draft row. */
    const updateCustomModelRow = (serverId, index, patch) => {
        setCustomModelDrafts(prev => {
            const rows = [...(prev[serverId] ?? [])];
            const row = rows[index];
            if (row === undefined)
                return prev;
            rows[index] = { ...row, ...patch };
            return { ...prev, [serverId]: rows };
        });
    };
    /** Add an empty custom model draft row. */
    const addCustomModelRow = (serverId) => {
        setCustomModelDrafts(prev => ({
            ...prev,
            [serverId]: [...(prev[serverId] ?? []), { id: '', name: '' }],
        }));
    };
    /** Remove one custom model draft row. */
    const removeCustomModelRow = (serverId, index) => {
        setCustomModelDrafts(prev => {
            const rows = [...(prev[serverId] ?? [])];
            rows.splice(index, 1);
            return { ...prev, [serverId]: rows };
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
    return (_jsxs("div", { className: css.section, children: [_jsx("h2", { className: css.heading, children: t('title') }), _jsx("p", { className: css.intro, children: t('intro') }), _jsxs("div", { className: css.tabs, role: "tablist", children: [_jsx("button", { type: "button", role: "tab", className: css.tab, "aria-selected": tab === 'registry', "data-active": tab === 'registry' ? 'true' : undefined, onClick: () => { setTab('registry'); }, children: t('registryTab') }), _jsx("button", { type: "button", role: "tab", className: css.tab, "aria-selected": tab === 'servers', "data-active": tab === 'servers' ? 'true' : undefined, onClick: () => { setTab('servers'); }, children: t('serversTab') })] }), error !== undefined && _jsx("div", { className: css.error, children: error }), tab === 'registry' && (_jsxs("div", { className: css.panel, children: [_jsxs("div", { className: css.registryToolbar, children: [_jsx("input", { type: "search", className: css.search, placeholder: t('registrySearch'), value: search, onChange: e => { setSearch(e.target.value); } }), _jsxs("button", { type: "button", className: css.customAddButton, onClick: () => { setCustomError(undefined); setShowCustomForm(true); }, children: ["+ ", t('customAdd')] })] }), filteredAgents.length === 0 ? (_jsx("p", { className: css.empty, children: t('registryEmpty') })) : (_jsx("div", { className: css.list, children: filteredAgents.map((agent) => {
                            const isAdded = servers[agent.id] !== undefined;
                            const distType = distributionType(agent);
                            return (_jsxs("div", { className: css.agentCard, children: [_jsxs("div", { className: css.agentInfo, children: [_jsx("p", { className: css.agentName, children: agent.name }), _jsx("p", { className: css.agentDesc, children: agent.description }), _jsxs("div", { className: css.agentMeta, children: [_jsx("span", { className: css.distBadge, children: distType }), _jsxs("span", { children: [t('version'), ": ", agent.version] }), agent.authors !== undefined && agent.authors.length > 0 && (_jsxs("span", { children: [t('authors'), ": ", agent.authors.join(', ')] }))] })] }), _jsx("button", { type: "button", className: css.addButton, disabled: isAdded || addingId === agent.id, onClick: () => { void addServer(agent); }, children: isAdded ? t('added') : addingId === agent.id ? t('adding') : t('add') })] }, agent.id));
                        }) }))] })), tab === 'servers' && (_jsx("div", { className: css.panel, children: !loading && serverList.length === 0 ? (_jsx("p", { className: css.empty, children: t('noServers') })) : (_jsx("div", { className: css.list, children: serverList.map(([id, server]) => {
                        const isExpanded = expandedId === id;
                        const rows = envDrafts[id] ?? [];
                        const selectedModels = modelDrafts[id] ?? [];
                        const models = discoveredModels[id] ?? [];
                        const isLoadingModels = modelsLoading.has(id);
                        const info = serverInfo[id];
                        const registryAgent = registry.agents.find(a => a.id === id);
                        const versionLabel = serverVersionLabel(info, registryAgent);
                        const authUrl = authUrls[id];
                        return (_jsxs("div", { className: css.serverCardBlock, children: [authUrl !== undefined && (_jsxs("div", { className: css.authBanner, children: [_jsx("span", { children: t('authPending') }), _jsx("a", { href: authUrl, target: "_blank", rel: "noreferrer", className: css.authLink, children: t('authOpen') })] })), _jsxs("div", { className: css.serverCard, children: [_jsxs("div", { className: css.agentInfo, children: [_jsx("p", { className: css.agentName, children: server.name }), _jsxs("p", { className: css.serverCommand, children: [t('serverCommand'), ": ", server.command, " ", server.args.join(' ')] }), _jsxs("div", { className: css.agentMeta, children: [_jsxs("span", { children: ["acp-", id] }), versionLabel !== undefined && (_jsxs("span", { children: [t('serverVersion'), ": ", versionLabel] }))] })] }), _jsxs("div", { className: css.cardActions, children: [_jsx("button", { type: "button", className: css.editButton, onClick: () => { void runTest(id, server.name); }, children: t('test') }), _jsx("button", { type: "button", className: css.editButton, onClick: () => { void expandServer(id); }, children: isExpanded ? t('collapse') : t('edit') }), _jsx("button", { type: "button", className: css.removeButton, disabled: removingId === id, onClick: () => {
                                                        if (window.confirm(t('removeConfirm'))) {
                                                            void removeServer(id);
                                                        }
                                                    }, children: removingId === id ? '…' : t('remove') })] })] }), isExpanded && (_jsxs("div", { className: css.serverDetail, children: [_jsxs("div", { className: css.detailSection, children: [_jsx("p", { className: css.detailHeading, children: t('serverVersion') }), info !== undefined ? (_jsxs("div", { className: css.versionInfo, children: [_jsx("span", { className: css.versionName, children: info.agentName }), _jsxs("span", { className: css.versionTag, children: ["v", info.agentVersion] }), info.protocolVersion !== undefined && (_jsxs("span", { className: css.versionTag, children: [t('serverProtocol'), ": ", info.protocolVersion] }))] })) : registryAgent !== undefined ? (_jsxs("div", { className: css.versionInfo, children: [_jsx("span", { className: css.versionName, children: registryAgent.name }), _jsxs("span", { className: css.versionTag, children: ["v", registryAgent.version] })] })) : (_jsx("p", { className: css.emptyInline, children: t('serverVersionUnknown') }))] }), _jsxs("div", { className: css.detailSection, children: [_jsx("p", { className: css.detailHeading, children: t('envVars') }), _jsx("p", { className: css.detailHint, children: t('envVarsHint') }), rows.length === 0 ? (_jsx("p", { className: css.emptyInline, children: t('noEnvVars') })) : (_jsx("div", { className: css.envList, children: rows.map((row, index) => (_jsxs("div", { className: css.envRow, children: [_jsx("input", { type: "text", className: css.envKey, placeholder: t('envKey'), value: row.key, onChange: e => { updateEnvRow(id, index, { key: e.target.value }); } }), _jsx("input", { type: "text", className: css.envValue, placeholder: t('envValue'), value: row.value, onChange: e => { updateEnvRow(id, index, { value: e.target.value }); } }), _jsx("button", { type: "button", className: css.envRemove, onClick: () => { removeEnvRow(id, index); }, children: "\u00D7" })] }, index))) })), _jsxs("button", { type: "button", className: css.addEnvButton, onClick: () => { addEnvRow(id); }, children: ["+ ", t('addEnvVar')] })] }), _jsxs("div", { className: css.detailSection, children: [_jsxs("div", { className: css.modelSelectHeader, children: [_jsx("p", { className: css.detailHeading, children: t('modelSelect') }), _jsx("button", { type: "button", className: css.refreshButton, disabled: isLoadingModels, onClick: () => { void refreshModels(id); }, children: isLoadingModels ? t('refreshingModels') : t('refreshModels') })] }), _jsx("p", { className: css.detailHint, children: t('modelSelectHint') }), isLoadingModels ? (_jsx("p", { className: css.emptyInline, children: t('modelsLoading') })) : models.length === 0 ? (_jsx("p", { className: css.emptyInline, children: info !== undefined ? t('noModelsConnected') : t('noModels') })) : (_jsxs(_Fragment, { children: [_jsx("input", { type: "search", className: css.modelSearch, placeholder: t('modelSearch'), value: modelSearch[id] ?? '', onChange: e => { setModelSearch(prev => ({ ...prev, [id]: e.target.value })); } }), _jsx("div", { className: css.modelList, children: models
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
                                                            }) })] })), models.length > 0 && (_jsxs("div", { className: css.modelActions, children: [_jsx("button", { type: "button", className: css.linkButton, onClick: () => { setModelDrafts(prev => ({ ...prev, [id]: models.map(m => m.id) })); }, children: t('selectAll') }), _jsx("button", { type: "button", className: css.linkButton, onClick: () => { setModelDrafts(prev => ({ ...prev, [id]: [] })); }, children: t('selectNone') })] }))] }), _jsxs("div", { className: css.detailSection, children: [_jsx("p", { className: css.detailHeading, children: t('customModels') }), _jsx("p", { className: css.detailHint, children: t('customModelsHint') }), (customModelDrafts[id] ?? []).length === 0 ? (_jsx("p", { className: css.emptyInline, children: t('noCustomModels') })) : (_jsx("div", { className: css.envList, children: (customModelDrafts[id] ?? []).map((row, index) => (_jsxs("div", { className: css.envRow, children: [_jsx("input", { type: "text", className: css.envKey, placeholder: t('customModelId'), value: row.id, onChange: e => { updateCustomModelRow(id, index, { id: e.target.value }); } }), _jsx("input", { type: "text", className: css.envValue, placeholder: t('customModelName'), value: row.name, onChange: e => { updateCustomModelRow(id, index, { name: e.target.value }); } }), _jsx("button", { type: "button", className: css.envRemove, onClick: () => { removeCustomModelRow(id, index); }, children: "\u00D7" })] }, index))) })), _jsxs("button", { type: "button", className: css.addEnvButton, onClick: () => { addCustomModelRow(id); }, children: ["+ ", t('addCustomModel')] })] }), _jsx("button", { type: "button", className: css.saveButton, disabled: savingId === id, onClick: () => { void saveServerConfig(id); }, children: savingId === id ? t('saving') : t('save') })] }))] }, id));
                    }) })) })), testServer !== undefined && (_jsx("div", { className: css.modalOverlay, onClick: () => { setTestServer(undefined); }, children: _jsxs("div", { className: css.modal, onClick: e => { e.stopPropagation(); }, children: [_jsxs("div", { className: css.modalHeader, children: [_jsxs("p", { className: css.modalTitle, children: [t('testTitle'), " \u2014 ", testServer.name] }), _jsx("button", { type: "button", className: css.modalClose, onClick: () => { setTestServer(undefined); }, children: "\u00D7" })] }), _jsx("div", { className: css.testSteps, children: TEST_STEP_IDS.map(stepId => {
                                const step = testSteps[stepId];
                                return (_jsxs("div", { className: css.testStep, children: [_jsx("span", { className: `${css.testStepStatus} ${css[`test_${step.status}`]}`, children: step.status === 'pass' ? '✓' : step.status === 'fail' ? '✗' : '…' }), _jsxs("div", { className: css.testStepBody, children: [_jsx("p", { className: css.testStepLabel, children: t(`testStep_${stepId}`) }), step.detail !== undefined && _jsx("p", { className: css.testStepDetail, children: step.detail })] })] }, stepId));
                            }) })] }) })), showCustomForm && (_jsx("div", { className: css.modalOverlay, onClick: () => { setShowCustomForm(false); }, children: _jsxs("div", { className: css.modal, onClick: e => { e.stopPropagation(); }, children: [_jsxs("div", { className: css.modalHeader, children: [_jsx("p", { className: css.modalTitle, children: t('customTitle') }), _jsx("button", { type: "button", className: css.modalClose, onClick: () => { setShowCustomForm(false); }, children: "\u00D7" })] }), _jsxs("div", { className: css.customForm, children: [customError !== undefined && _jsx("div", { className: css.error, children: customError }), _jsxs("div", { className: css.detailSection, children: [_jsx("p", { className: css.detailHeading, children: t('customId') }), _jsx("p", { className: css.detailHint, children: t('customIdHint') }), _jsx("input", { type: "text", className: css.customInput, placeholder: "my-agent", value: customDraft.id, onChange: e => { setCustomDraft(prev => ({ ...prev, id: e.target.value })); } })] }), _jsxs("div", { className: css.detailSection, children: [_jsx("p", { className: css.detailHeading, children: t('customName') }), _jsx("input", { type: "text", className: css.customInput, placeholder: t('customName'), value: customDraft.name, onChange: e => { setCustomDraft(prev => ({ ...prev, name: e.target.value })); } })] }), _jsxs("div", { className: css.detailSection, children: [_jsx("p", { className: css.detailHeading, children: t('customCommand') }), _jsx("p", { className: css.detailHint, children: t('customCommandHint') }), _jsx("input", { type: "text", className: css.customInput, placeholder: "npx", value: customDraft.command, onChange: e => { setCustomDraft(prev => ({ ...prev, command: e.target.value })); } })] }), _jsxs("div", { className: css.detailSection, children: [_jsx("p", { className: css.detailHeading, children: t('customArgs') }), _jsx("p", { className: css.detailHint, children: t('customArgsHint') }), _jsx("input", { type: "text", className: css.customInput, placeholder: "-y @my-org/my-acp-agent", value: customDraft.args, onChange: e => { setCustomDraft(prev => ({ ...prev, args: e.target.value })); } })] }), _jsxs("div", { className: css.detailSection, children: [_jsx("p", { className: css.detailHeading, children: t('customEnv') }), _jsx("p", { className: css.detailHint, children: t('customEnvHint') }), customDraft.env.length === 0 ? (_jsx("p", { className: css.emptyInline, children: t('noEnvVars') })) : (_jsx("div", { className: css.envList, children: customDraft.env.map((row, index) => (_jsxs("div", { className: css.envRow, children: [_jsx("input", { type: "text", className: css.envKey, placeholder: t('envKey'), value: row.key, onChange: e => { updateCustomEnvRow(index, { key: e.target.value }); } }), _jsx("input", { type: "text", className: css.envValue, placeholder: t('envValue'), value: row.value, onChange: e => { updateCustomEnvRow(index, { value: e.target.value }); } }), _jsx("button", { type: "button", className: css.envRemove, onClick: () => { removeCustomEnvRow(index); }, children: "\u00D7" })] }, index))) })), _jsxs("button", { type: "button", className: css.addEnvButton, onClick: () => { addCustomEnvRow(); }, children: ["+ ", t('addEnvVar')] })] }), _jsx("button", { type: "button", className: css.saveButton, disabled: customSaving, onClick: () => { void addCustomServer(); }, children: customSaving ? t('customSaving') : t('customSave') })] })] }) }))] }));
}
//# sourceMappingURL=AcpSettingsSection.js.map