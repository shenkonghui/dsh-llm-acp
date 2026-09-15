import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
/** ACP auth banner: conversation composer-dock entry that surfaces pending
 * interactive-login URLs published by ACP servers. */
import { useCallback, useEffect, useRef, useState } from 'react';
import css from './AcpSettingsSection.module.css';
/** Poll interval for pending auth URLs. */
const POLL_MS = 3_000;
/**
 * Identity of one choice request, used to remember a dismissal. Polling
 * re-reports the same pending choice every few seconds, so the dialog must be
 * keyed on something that only changes when the question itself does —
 * otherwise closing it reopens it on the next poll.
 */
function choiceSignature(state) {
    return `${state.methods.map(m => m.id).join(',')}|${state.selected}`;
}
/** Parse the JSON carrier of the `acp-methods-<id>` route. */
function parseMethodState(entry) {
    if (entry === undefined || entry.id !== 'methods')
        return undefined;
    try {
        const parsed = JSON.parse(entry.name);
        if (!Array.isArray(parsed.methods))
            return undefined;
        return {
            methods: parsed.methods.filter((m) => typeof m?.id === 'string' && typeof m?.name === 'string'),
            selected: typeof parsed.selected === 'string' ? parsed.selected : '',
            needed: parsed.needed === true,
        };
    }
    catch {
        return undefined;
    }
}
/**
 * Poll all configured ACP servers for pending interactive-login URLs and show
 * a banner with a clickable link while any server awaits browser sign-in. The
 * host keeps the failed session call pending for the interactive-auth window,
 * so the prompt retries automatically once the login completes; the banner
 * disappears on the next poll after `pendingAuthUrl` clears.
 */
export function AcpAuthBanner({ api, settingsNs, t, }) {
    const [pending, setPending] = useState([]);
    /** Server id → auth-method catalog, for the picker. */
    const [methods, setMethods] = useState({});
    /** Server id → the choice signature the user closed; suppresses re-opening. */
    const [dismissed, setDismissed] = useState({});
    /** Server id → display name, for the dialog's per-server heading. */
    const [names, setNames] = useState({});
    const [savingId, setSavingId] = useState(undefined);
    const [error, setError] = useState(undefined);
    const mountedRef = useRef(true);
    /** Revision of the `llm-acp` namespace at the last read, to write against. */
    const revisionRef = useRef(undefined);
    const refresh = useCallback(async () => {
        try {
            const desc = await api.describeSettings();
            if (!desc.ok || desc.value === undefined) {
                if (mountedRef.current) {
                    setPending([]);
                    setMethods({});
                }
                return;
            }
            const ns = desc.value.namespaces.find(v => v.ns === settingsNs);
            revisionRef.current = ns?.revision;
            const servers = ns?.value?.servers ?? {};
            const found = [];
            const catalogs = {};
            const display = {};
            await Promise.all(Object.entries(servers).map(async ([id, server]) => {
                display[id] = server.name.length > 0 ? server.name : id;
                const [authRes, methodRes] = await Promise.all([
                    api.discoverModels(settingsNs, `acp-auth-${id}`),
                    api.discoverModels(settingsNs, `acp-methods-${id}`),
                ]);
                const state = parseMethodState(methodRes.value?.[0]);
                if (state !== undefined)
                    catalogs[id] = state;
                const res = authRes;
                if (!res.ok || res.value === undefined)
                    return;
                const entry = res.value[0];
                if (entry === undefined)
                    return;
                const serverName = display[id];
                if (entry.id === 'auth' && entry.name.length > 0) {
                    found.push({ serverName, methodId: '', url: entry.name });
                }
                else if (entry.id === 'pending') {
                    found.push({ serverName, methodId: entry.name });
                }
            }));
            if (!mountedRef.current)
                return;
            // Value-compare before publishing: a fresh object every 3s would re-render
            // (and disturb) the open dialog for no reason.
            setPending(prev => JSON.stringify(prev) === JSON.stringify(found) ? prev : found);
            setMethods(prev => JSON.stringify(prev) === JSON.stringify(catalogs) ? prev : catalogs);
            setNames(prev => JSON.stringify(prev) === JSON.stringify(display) ? prev : display);
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
    /**
     * Persist the picked method. A concurrent write (the settings page's Save)
     * can invalidate our revision, so retry once against a fresh one.
     */
    const choose = useCallback(async (id, methodId) => {
        setSavingId(id);
        setError(undefined);
        try {
            for (let attempt = 0; attempt < 2; attempt++) {
                const response = await api.mutateSettings(settingsNs, [{ op: 'set', path: ['servers', id, 'authMethod'], value: methodId }], revisionRef.current);
                if (response.ok) {
                    // Mark this question answered before the poll catches up, so the
                    // dialog does not flash back open.
                    setDismissed(prev => ({
                        ...prev,
                        [id]: choiceSignature({
                            methods: methods[id]?.methods ?? [],
                            selected: methodId,
                            needed: false,
                        }),
                    }));
                    await refresh();
                    return;
                }
                if (attempt === 0) {
                    // Re-read the revision and try once more before surfacing a failure.
                    await refresh();
                    continue;
                }
                setError(response.error?.message ?? 'unknown error');
            }
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
        finally {
            if (mountedRef.current)
                setSavingId(undefined);
        }
    }, [api, methods, refresh, settingsNs]);
    // One dialog for every server waiting on a choice. A single overlay avoids
    // stacking several fixed-position modals on the same z-index.
    const awaiting = Object.entries(methods).filter(([id, state]) => state.needed && state.methods.length > 0 && dismissed[id] !== choiceSignature(state));
    const showDialog = awaiting.length > 0;
    /** Remember every currently-asked question as answered-by-dismissal. */
    const dismiss = useCallback(() => {
        setDismissed(prev => ({
            ...prev,
            ...Object.fromEntries(awaiting.map(([id, state]) => [id, choiceSignature(state)])),
        }));
    }, [awaiting]);
    if (pending.length === 0 && !showDialog)
        return null;
    return (_jsxs(_Fragment, { children: [pending.map(p => (_jsxs("div", { className: css.authBanner, children: [_jsxs("span", { children: [p.serverName, ": ", p.url !== undefined
                                ? t('authPending')
                                : `${t('authWaiting')}${p.methodId.length > 0 ? ` (${p.methodId})` : ''}`] }), p.url !== undefined && (_jsx("a", { href: p.url, target: "_blank", rel: "noreferrer", className: css.authLink, children: t('authOpen') }))] }, p.serverName))), showDialog && (_jsx("div", { className: css.modalOverlay, onClick: dismiss, children: _jsxs("div", { className: css.modal, onClick: e => { e.stopPropagation(); }, children: [_jsxs("div", { className: css.modalHeader, children: [_jsx("p", { className: css.modalTitle, children: t('chooseMethodTitle') }), _jsx("button", { type: "button", className: css.modalClose, onClick: dismiss, children: "\u00D7" })] }), _jsx("p", { className: css.detailHint, children: t('chooseMethodIntro') }), error !== undefined && _jsx("div", { className: css.error, children: `${t('chooseMethodFailed')} ${error}` }), _jsx("div", { className: css.methodList, children: awaiting.map(([id, state]) => (_jsxs("div", { className: css.detailSection, children: [_jsx("p", { className: css.detailHeading, children: names[id] ?? id }), state.methods.map(method => (_jsxs("button", { type: "button", className: css.methodButton, disabled: savingId !== undefined, onClick: () => { void choose(id, method.id); }, children: [_jsx("span", { className: css.methodName, children: method.name.length > 0 ? method.name : method.id }), _jsx("span", { className: css.methodId, children: method.id })] }, method.id)))] }, id))) })] }) }))] }));
}
//# sourceMappingURL=AcpAuthBanner.js.map