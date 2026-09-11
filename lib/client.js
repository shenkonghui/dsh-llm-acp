window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-llm-acp",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region \0dsh-css:/Users/shenkonghui/src/github/dsh-plugin/dsh-llm-acp/src/client/AcpSettingsSection.module.css.mjs
		const css$1 = ".qrxkkG_section{flex-direction:column;gap:16px;display:flex}.qrxkkG_heading{margin:0;font-size:18px;font-weight:600}.qrxkkG_intro{color:var(--dsw-text-secondary,#666);margin:0;font-size:14px;line-height:1.5}.qrxkkG_tabs{border-bottom:1px solid var(--dsw-border,#e0e0e0);gap:4px;display:flex}.qrxkkG_tab{cursor:pointer;color:var(--dsw-text-secondary,#666);background:0 0;border:none;border-bottom:2px solid #0000;margin-bottom:-1px;padding:8px 16px;font-size:14px}.qrxkkG_tab[data-active=true]{color:var(--dsw-text-primary,#333);border-bottom-color:var(--dsw-accent,#1677ff);font-weight:500}.qrxkkG_panel{padding-top:16px}.qrxkkG_search{border:1px solid var(--dsw-border,#e0e0e0);box-sizing:border-box;border-radius:6px;width:100%;padding:8px 12px;font-size:14px}.qrxkkG_list{flex-direction:column;gap:8px;display:flex}.qrxkkG_agentCard{border:1px solid var(--dsw-border,#e0e0e0);border-radius:8px;justify-content:space-between;align-items:flex-start;gap:12px;padding:12px 16px;display:flex}.qrxkkG_agentInfo{flex:1;min-width:0}.qrxkkG_agentName{margin:0 0 4px;font-size:14px;font-weight:600}.qrxkkG_agentDesc{color:var(--dsw-text-secondary,#666);margin:0 0 6px;font-size:13px;line-height:1.4}.qrxkkG_agentMeta{color:var(--dsw-text-tertiary,#999);flex-wrap:wrap;gap:12px;font-size:12px;display:flex}.qrxkkG_agentMeta span{align-items:center;gap:4px;display:inline-flex}.qrxkkG_distBadge{background:var(--dsw-bg-secondary,#f0f0f0);color:var(--dsw-text-secondary,#666);border-radius:4px;padding:1px 6px;font-size:11px;font-weight:500;display:inline-block}.qrxkkG_addButton{border:1px solid var(--dsw-accent,#1677ff);background:var(--dsw-accent,#1677ff);color:#fff;cursor:pointer;white-space:nowrap;border-radius:6px;flex-shrink:0;padding:6px 16px;font-size:13px;font-weight:500}.qrxkkG_addButton:disabled{opacity:.6;cursor:not-allowed}.qrxkkG_serverCard{border:1px solid var(--dsw-border,#e0e0e0);border-radius:8px;justify-content:space-between;align-items:flex-start;gap:12px;padding:12px 16px;display:flex}.qrxkkG_removeButton{border:1px solid var(--dsw-danger,#ff4d4f);color:var(--dsw-danger,#ff4d4f);cursor:pointer;background:0 0;border-radius:6px;flex-shrink:0;padding:6px 12px;font-size:13px}.qrxkkG_removeButton:disabled{opacity:.6;cursor:not-allowed}.qrxkkG_empty{text-align:center;color:var(--dsw-text-secondary,#666);padding:24px;font-size:14px}.qrxkkG_error{background:var(--dsw-danger-bg,#fff2f0);color:var(--dsw-danger,#ff4d4f);border-radius:6px;padding:8px 12px;font-size:13px}.qrxkkG_authBanner{background:var(--dsw-warning-bg,#fffbe6);color:var(--dsh-warning,#d48806);border-radius:6px;align-items:center;gap:10px;padding:8px 12px;font-size:13px;display:flex}.qrxkkG_authLink{color:var(--dsw-accent,#1677ff);text-decoration:none}.qrxkkG_authLink:hover{text-decoration:underline}.qrxkkG_serverCommand{font-family:var(--dsw-font-mono,monospace);color:var(--dsw-text-secondary,#666);font-size:12px}.qrxkkG_serverCardBlock{border:1px solid var(--dsw-border,#e0e0e0);border-radius:8px;overflow:hidden}.qrxkkG_cardActions{flex-shrink:0;gap:8px;display:flex}.qrxkkG_editButton{border:1px solid var(--dsw-border,#e0e0e0);color:var(--dsw-text-primary,#333);cursor:pointer;background:0 0;border-radius:6px;padding:6px 12px;font-size:13px}.qrxkkG_editButton:hover{border-color:var(--dsw-accent,#1677ff);color:var(--dsw-accent,#1677ff)}.qrxkkG_serverDetail{border-top:1px solid var(--dsw-border,#e0e0e0);background:var(--dsw-bg-secondary,#fafafa);flex-direction:column;gap:16px;padding:12px 16px;display:flex}.qrxkkG_detailSection{flex-direction:column;gap:4px;display:flex}.qrxkkG_detailHeading{margin:0;font-size:14px;font-weight:600}.qrxkkG_detailHint{color:var(--dsw-text-tertiary,#999);margin:0 0 4px;font-size:12px;line-height:1.4}.qrxkkG_emptyInline{color:var(--dsw-text-tertiary,#999);margin:0;padding:4px 0;font-size:13px}.qrxkkG_envList{flex-direction:column;gap:6px;display:flex}.qrxkkG_envRow{align-items:center;gap:6px;display:flex}.qrxkkG_envKey{border:1px solid var(--dsw-border,#e0e0e0);font-size:13px;font-family:var(--dsw-font-mono,monospace);box-sizing:border-box;border-radius:4px;flex:2;padding:6px 8px}.qrxkkG_envValue{border:1px solid var(--dsw-border,#e0e0e0);font-size:13px;font-family:var(--dsw-font-mono,monospace);box-sizing:border-box;border-radius:4px;flex:3;padding:6px 8px}.qrxkkG_envRemove{border:1px solid var(--dsw-border,#e0e0e0);width:28px;height:28px;color:var(--dsw-danger,#ff4d4f);cursor:pointer;background:0 0;border-radius:4px;flex-shrink:0;padding:0;font-size:16px;line-height:1}.qrxkkG_envRemove:hover{border-color:var(--dsw-danger,#ff4d4f)}.qrxkkG_addEnvButton{border:1px dashed var(--dsw-border,#e0e0e0);color:var(--dsw-text-secondary,#666);cursor:pointer;background:0 0;border-radius:4px;align-self:flex-start;margin-top:4px;padding:4px 12px;font-size:13px}.qrxkkG_addEnvButton:hover{border-color:var(--dsw-accent,#1677ff);color:var(--dsw-accent,#1677ff)}.qrxkkG_modelList{border:1px solid var(--dsw-border,#e0e0e0);border-radius:4px;flex-direction:column;gap:4px;max-height:240px;padding:4px;display:flex;overflow-y:auto}.qrxkkG_modelSearch{border:1px solid var(--dsw-border,#e0e0e0);box-sizing:border-box;border-radius:4px;width:100%;margin-bottom:4px;padding:6px 10px;font-size:13px}.qrxkkG_modelRow{cursor:pointer;border-radius:4px;align-items:center;gap:8px;padding:6px 8px;font-size:13px;display:flex}.qrxkkG_modelRow:hover{background:var(--dsw-bg-secondary,#f0f0f0)}.qrxkkG_modelRow input[type=checkbox]{flex-shrink:0;margin:0}.qrxkkG_modelName{font-weight:500}.qrxkkG_modelId{font-family:var(--dsw-font-mono,monospace);color:var(--dsw-text-tertiary,#999);font-size:11px}.qrxkkG_modelActions{gap:12px;margin-top:4px;display:flex}.qrxkkG_linkButton{color:var(--dsw-accent,#1677ff);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px}.qrxkkG_linkButton:hover{text-decoration:underline}.qrxkkG_saveButton{border:1px solid var(--dsw-accent,#1677ff);background:var(--dsw-accent,#1677ff);color:#fff;cursor:pointer;border-radius:6px;align-self:flex-start;padding:6px 20px;font-size:13px;font-weight:500}.qrxkkG_saveButton:disabled{opacity:.6;cursor:not-allowed}.qrxkkG_modelSelectHeader{justify-content:space-between;align-items:center;gap:8px;display:flex}.qrxkkG_modelSelectHeader .qrxkkG_detailHeading{margin:0}.qrxkkG_refreshButton{border:1px solid var(--dsw-border,#e0e0e0);color:var(--dsw-text-secondary,#666);cursor:pointer;background:0 0;border-radius:4px;flex-shrink:0;padding:4px 10px;font-size:12px}.qrxkkG_refreshButton:hover:not(:disabled){border-color:var(--dsw-accent,#1677ff);color:var(--dsw-accent,#1677ff)}.qrxkkG_refreshButton:disabled{opacity:.6;cursor:not-allowed}.qrxkkG_versionInfo{flex-wrap:wrap;align-items:center;gap:8px;font-size:13px;display:flex}.qrxkkG_versionName{font-weight:500}.qrxkkG_versionTag{font-family:var(--dsw-font-mono,monospace);color:var(--dsw-text-secondary,#666);background:var(--dsw-bg-secondary,#f0f0f0);border-radius:4px;padding:1px 6px;font-size:12px}.qrxkkG_modalOverlay{z-index:1000;background:#00000073;justify-content:center;align-items:center;display:flex;position:fixed;inset:0}.qrxkkG_modal{background:var(--dsw-bg-primary,#fff);border-radius:10px;width:90%;max-width:480px;max-height:80vh;padding:16px 20px;overflow-y:auto;box-shadow:0 8px 32px #0003}.qrxkkG_modalHeader{justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px;display:flex}.qrxkkG_modalTitle{margin:0;font-size:15px;font-weight:600}.qrxkkG_modalClose{width:28px;height:28px;color:var(--dsw-text-secondary,#666);cursor:pointer;background:0 0;border:none;border-radius:4px;flex-shrink:0;padding:0;font-size:20px;line-height:1}.qrxkkG_modalClose:hover{background:var(--dsw-bg-secondary,#f0f0f0)}.qrxkkG_testSteps{flex-direction:column;gap:8px;display:flex}.qrxkkG_testStep{border:1px solid var(--dsw-border,#e0e0e0);border-radius:8px;align-items:flex-start;gap:10px;padding:10px 12px;display:flex}.qrxkkG_testStepStatus{border-radius:50%;flex-shrink:0;justify-content:center;align-items:center;width:22px;height:22px;margin-top:1px;font-size:13px;font-weight:600;display:inline-flex}.qrxkkG_test_pass{background:var(--dsw-success-bg,#f6ffed);color:var(--dsw-success,#52c41a)}.qrxkkG_test_fail{background:var(--dsw-danger-bg,#fff2f0);color:var(--dsw-danger,#ff4d4f)}.qrxkkG_test_running{background:var(--dsw-bg-secondary,#f0f0f0);color:var(--dsw-text-secondary,#666)}.qrxkkG_testStepBody{flex:1;min-width:0}.qrxkkG_testStepLabel{margin:0;font-size:13px;font-weight:500}.qrxkkG_testStepDetail{color:var(--dsw-text-secondary,#666);font-size:12px;font-family:var(--dsw-font-mono,monospace);word-break:break-word;white-space:pre-wrap;margin:2px 0 0}.qrxkkG_registryToolbar{align-items:center;gap:8px;margin-bottom:12px;display:flex}.qrxkkG_registryToolbar .qrxkkG_search{flex:1}.qrxkkG_customAddButton{border:1px dashed var(--dsw-accent,#1677ff);color:var(--dsw-accent,#1677ff);cursor:pointer;white-space:nowrap;background:0 0;border-radius:6px;flex-shrink:0;padding:8px 14px;font-size:13px;font-weight:500}.qrxkkG_customAddButton:hover{background:var(--dsw-accent,#1677ff);color:#fff}.qrxkkG_customForm{flex-direction:column;gap:16px;display:flex}.qrxkkG_customInput{border:1px solid var(--dsw-border,#e0e0e0);width:100%;font-size:13px;font-family:var(--dsw-font-mono,monospace);box-sizing:border-box;border-radius:4px;padding:8px 10px}.qrxkkG_customInput:focus{border-color:var(--dsw-accent,#1677ff);outline:none}";
		const tagId$1 = "@deepseek-ai/dsh-llm-acp/AcpSettingsSection.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-llm-acp";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var AcpSettingsSection_module_css_default = {
			"customAddButton": "qrxkkG_customAddButton",
			"distBadge": "qrxkkG_distBadge",
			"saveButton": "qrxkkG_saveButton",
			"versionInfo": "qrxkkG_versionInfo",
			"test_running": "qrxkkG_test_running",
			"section": "qrxkkG_section",
			"cardActions": "qrxkkG_cardActions",
			"envRow": "qrxkkG_envRow",
			"serverCommand": "qrxkkG_serverCommand",
			"emptyInline": "qrxkkG_emptyInline",
			"modelName": "qrxkkG_modelName",
			"modalOverlay": "qrxkkG_modalOverlay",
			"modalClose": "qrxkkG_modalClose",
			"testStepBody": "qrxkkG_testStepBody",
			"detailHint": "qrxkkG_detailHint",
			"envList": "qrxkkG_envList",
			"testStepLabel": "qrxkkG_testStepLabel",
			"testStep": "qrxkkG_testStep",
			"detailHeading": "qrxkkG_detailHeading",
			"customInput": "qrxkkG_customInput",
			"modelList": "qrxkkG_modelList",
			"refreshButton": "qrxkkG_refreshButton",
			"modal": "qrxkkG_modal",
			"editButton": "qrxkkG_editButton",
			"addEnvButton": "qrxkkG_addEnvButton",
			"authBanner": "qrxkkG_authBanner",
			"testStepStatus": "qrxkkG_testStepStatus",
			"modelRow": "qrxkkG_modelRow",
			"test_pass": "qrxkkG_test_pass",
			"modelSearch": "qrxkkG_modelSearch",
			"versionTag": "qrxkkG_versionTag",
			"modelId": "qrxkkG_modelId",
			"authLink": "qrxkkG_authLink",
			"agentCard": "qrxkkG_agentCard",
			"detailSection": "qrxkkG_detailSection",
			"serverDetail": "qrxkkG_serverDetail",
			"tab": "qrxkkG_tab",
			"agentName": "qrxkkG_agentName",
			"empty": "qrxkkG_empty",
			"testSteps": "qrxkkG_testSteps",
			"testStepDetail": "qrxkkG_testStepDetail",
			"heading": "qrxkkG_heading",
			"agentMeta": "qrxkkG_agentMeta",
			"agentInfo": "qrxkkG_agentInfo",
			"agentDesc": "qrxkkG_agentDesc",
			"addButton": "qrxkkG_addButton",
			"serverCardBlock": "qrxkkG_serverCardBlock",
			"envValue": "qrxkkG_envValue",
			"linkButton": "qrxkkG_linkButton",
			"modelSelectHeader": "qrxkkG_modelSelectHeader",
			"test_fail": "qrxkkG_test_fail",
			"registryToolbar": "qrxkkG_registryToolbar",
			"list": "qrxkkG_list",
			"serverCard": "qrxkkG_serverCard",
			"error": "qrxkkG_error",
			"envKey": "qrxkkG_envKey",
			"customForm": "qrxkkG_customForm",
			"modelActions": "qrxkkG_modelActions",
			"removeButton": "qrxkkG_removeButton",
			"search": "qrxkkG_search",
			"panel": "qrxkkG_panel",
			"tabs": "qrxkkG_tabs",
			"versionName": "qrxkkG_versionName",
			"intro": "qrxkkG_intro",
			"modalTitle": "qrxkkG_modalTitle",
			"modalHeader": "qrxkkG_modalHeader",
			"envRemove": "qrxkkG_envRemove"
		};
		//#endregion
		//#region src/client/AcpSettingsSection.tsx
		/** ACP Servers settings section: registry browser and configured-server list. */
		/** Detect the current platform for binary distribution selection. */
		function currentPlatform() {
			const platform = typeof navigator !== "undefined" ? navigator.platform : "";
			const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
			const isMac = /mac/i.test(platform);
			const isWin = /win/i.test(platform);
			const isArm = /arm|aarch64/i.test(ua) || /arm|aarch64/i.test(platform);
			if (isMac) return isArm ? "darwin-aarch64" : "darwin-x86_64";
			if (isWin) return isArm ? "windows-aarch64" : "windows-x86_64";
			return isArm ? "linux-aarch64" : "linux-x86_64";
		}
		/** Derive command and args from a registry agent's distribution.
		* For binary distributions, the registry's `cmd` is a path relative to the
		* extracted archive directory (e.g. `./bin/devin`). Since the user typically
		* has the agent binary installed in PATH, extract the basename and use it
		* directly. */
		function deriveCommand(agent) {
			const dist = agent.distribution;
			if (dist.npx) return {
				command: "npx",
				args: [
					"-y",
					dist.npx.package,
					...dist.npx.args ?? []
				]
			};
			if (dist.uvx) return {
				command: "uvx",
				args: [dist.uvx.package, ...dist.uvx.args ?? []]
			};
			if (dist.binary) {
				const plat = currentPlatform();
				const entry = dist.binary[plat] ?? dist.binary[Object.keys(dist.binary)[0] ?? ""];
				if (entry === void 0) return void 0;
				return {
					command: entry.cmd.replace(/^.*\//, ""),
					args: entry.args ?? []
				};
			}
		}
		/** Derive the bin name an npm package installs (heuristic: last path segment
		* of the package name, without scope or version). `@scope/name@ver` → `name`,
		* `name@ver` → `name`. Used to probe PATH before falling back to `npx -y`. */
		function npmBinName(pkg) {
			if (pkg.startsWith("@")) return pkg.split("@", 2)[1]?.split("/").pop();
			return pkg.split("@")[0];
		}
		/** Probe the host PATH for `bin` via the `acp-resolve-<bin>` discovery route.
		* Returns the absolute path when found, `undefined` otherwise. */
		async function resolveBinInPath(api, settingsNs, bin) {
			try {
				const response = await api.discoverModels(settingsNs, `acp-resolve-${bin}`);
				if (!response.ok) return void 0;
				return (response.value ?? [])[0]?.id;
			} catch {
				return;
			}
		}
		/** Distribution type label for display. */
		function distributionType(agent) {
			const dist = agent.distribution;
			if (dist.npx) return "npx";
			if (dist.uvx) return "uvx";
			if (dist.binary) return "binary";
			return "unknown";
		}
		/** Load the full discovered model catalog for one ACP provider route.
		* Uses model discovery (not the filtered catalog) so the reply is the
		* unfiltered set — `listModels` already applies the server's `enabledModels`
		* selection, which would hide unselected models from the multi-select editor. */
		async function loadProviderModels(api, settingsNs, providerRoute) {
			try {
				const response = await api.discoverModels(settingsNs, providerRoute);
				if (!response.ok) return [];
				return (response.value ?? []).map((m) => ({
					id: m.id,
					name: m.name ?? m.id
				}));
			} catch {
				return [];
			}
		}
		/** Load the live server identity (agent name/version, ACP protocol version)
		* via the `acp-info-<id>` discovery route. Returns `undefined` when the
		* server has not yet completed `initialize` or omits `agentInfo`. */
		async function loadServerInfo(api, settingsNs, serverId) {
			try {
				const response = await api.discoverModels(settingsNs, `acp-info-${serverId}`);
				if (!response.ok) return void 0;
				const entry = (response.value ?? [])[0];
				if (entry === void 0 || entry.id === "error") return void 0;
				const protocolVersion = entry.contextWindow;
				return {
					agentName: entry.id,
					agentVersion: entry.name ?? "",
					...protocolVersion === void 0 ? {} : { protocolVersion }
				};
			} catch {
				return;
			}
		}
		/** Load the pending interactive-auth browser login URL for one server via the
		* `acp-auth-<id>` discovery route. Returns `undefined` when no login is
		* pending or the host runs a stale build without the route. */
		async function loadAuthUrl(api, settingsNs, serverId) {
			try {
				const response = await api.discoverModels(settingsNs, `acp-auth-${serverId}`);
				if (!response.ok) return void 0;
				const entry = (response.value ?? [])[0];
				return entry !== void 0 && entry.id === "auth" && entry.name.length > 0 ? entry.name : void 0;
			} catch {
				return;
			}
		}
		/** Compact version label for a server card: live agent version first, then
		* the registry version as a fallback when the server has not reported yet. */
		function serverVersionLabel(info, registryAgent) {
			if (info !== void 0 && info.agentVersion.length > 0) return `v${info.agentVersion}`;
			if (registryAgent !== void 0) return `v${registryAgent.version}`;
		}
		const TEST_STEP_IDS = [
			"handshake",
			"models",
			"message"
		];
		/** Convert an env record to editable draft rows. */
		function envToDrafts(env) {
			if (env === void 0) return [];
			return Object.entries(env).map(([key, value]) => ({
				key,
				value
			}));
		}
		/** Convert editable draft rows back to an env record, skipping empty keys. */
		function draftsToEnv(rows) {
			const env = {};
			for (const row of rows) {
				const key = row.key.trim();
				if (key.length > 0) env[key] = row.value;
			}
			return env;
		}
		/** Empty custom-agent draft. */
		function emptyCustomDraft() {
			return {
				id: "",
				name: "",
				command: "",
				args: "",
				env: []
			};
		}
		/** Parse a space-separated args string into an array, handling simple quoting. */
		function parseArgs(args) {
			const trimmed = args.trim();
			if (trimmed.length === 0) return [];
			return trimmed.split(/\s+/);
		}
		/** Render the ACP Servers settings section. */
		function AcpSettingsSection(props) {
			const { t, registry, api, settingsNs } = props;
			const [tab, setTab] = (0, react.useState)("registry");
			const [search, setSearch] = (0, react.useState)("");
			const [servers, setServers] = (0, react.useState)({});
			const [loading, setLoading] = (0, react.useState)(true);
			const [addingId, setAddingId] = (0, react.useState)();
			const [removingId, setRemovingId] = (0, react.useState)();
			const [error, setError] = (0, react.useState)();
			const [expandedId, setExpandedId] = (0, react.useState)();
			const [envDrafts, setEnvDrafts] = (0, react.useState)({});
			const [modelDrafts, setModelDrafts] = (0, react.useState)({});
			const [customModelDrafts, setCustomModelDrafts] = (0, react.useState)({});
			const [discoveredModels, setDiscoveredModels] = (0, react.useState)({});
			const [modelsLoading, setModelsLoading] = (0, react.useState)(/* @__PURE__ */ new Set());
			const [modelSearch, setModelSearch] = (0, react.useState)({});
			const [savingId, setSavingId] = (0, react.useState)();
			const [serverInfo, setServerInfo] = (0, react.useState)({});
			const [authUrls, setAuthUrls] = (0, react.useState)({});
			const [testServer, setTestServer] = (0, react.useState)();
			const [testSteps, setTestSteps] = (0, react.useState)({
				handshake: { status: "running" },
				models: { status: "running" },
				message: { status: "running" }
			});
			const [showCustomForm, setShowCustomForm] = (0, react.useState)(false);
			const [customDraft, setCustomDraft] = (0, react.useState)(emptyCustomDraft());
			const [customSaving, setCustomSaving] = (0, react.useState)(false);
			const [customError, setCustomError] = (0, react.useState)();
			/** Revision of the `llm-acp` namespace at the last read; sent back on writes
			* so a stale editor is refused instead of silently overwriting. */
			const revisionRef = (0, react.useRef)(void 0);
			/** Load current servers from settings. */
			const loadServers = async () => {
				try {
					const response = await api.describeSettings();
					if (response.ok) {
						const ns = response.value?.namespaces.find((v) => v.ns === settingsNs);
						if (ns !== void 0) {
							revisionRef.current = ns.revision;
							const next = ns.value?.servers ?? {};
							setServers(next);
							for (const id of Object.keys(next)) {
								loadServerInfo(api, settingsNs, id).then((info) => {
									setServerInfo((prev) => prev[id] === info ? prev : {
										...prev,
										[id]: info
									});
								});
								loadAuthUrl(api, settingsNs, id).then((url) => {
									setAuthUrls((prev) => prev[id] === url ? prev : {
										...prev,
										[id]: url
									});
								});
							}
						}
					}
				} catch {
					setServers({});
				}
				setLoading(false);
			};
			(0, react.useEffect)(() => {
				loadServers();
			}, []);
			/** Add a registry agent as a configured server. For `npx -y <pkg>` agents,
			* probe the host PATH first and store the local bin directly when present,
			* so the UI shows and the spawn uses the installed binary without an npm
			* fetch on every start. */
			const addServer = async (agent) => {
				const cmd = deriveCommand(agent);
				if (cmd === void 0) return;
				setAddingId(agent.id);
				setError(void 0);
				try {
					let command = cmd.command;
					let args = cmd.args;
					if (command === "npx" && agent.distribution.npx !== void 0) {
						const bin = npmBinName(agent.distribution.npx.package);
						if (bin !== void 0) {
							const resolved = await resolveBinInPath(api, settingsNs, bin);
							if (resolved !== void 0) {
								command = resolved;
								args = agent.distribution.npx.args ?? [];
							}
						}
					}
					const serverEntry = {
						command,
						args,
						name: agent.name,
						env: {},
						models: []
					};
					const response = await api.mutateSettings(settingsNs, [{
						op: "set",
						path: ["servers", agent.id],
						value: serverEntry
					}], revisionRef.current);
					if (!response.ok) setError(response.error?.message ?? "unknown error");
					else await loadServers();
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
				setAddingId(void 0);
			};
			/** Add a custom ACP agent from the user-filled form. Validates the ID
			* (required, not already in use) and command (required), then writes the
			* server entry to settings — same shape as a registry agent. */
			const addCustomServer = async () => {
				setCustomError(void 0);
				const id = customDraft.id.trim();
				const command = customDraft.command.trim();
				const name = customDraft.name.trim() || id;
				if (id.length === 0) {
					setCustomError(t("customIdRequired"));
					return;
				}
				if (command.length === 0) {
					setCustomError(t("customCommandRequired"));
					return;
				}
				if (servers[id] !== void 0) {
					setCustomError(t("customIdExists"));
					return;
				}
				setCustomSaving(true);
				try {
					const serverEntry = {
						command,
						args: parseArgs(customDraft.args),
						name,
						env: draftsToEnv(customDraft.env),
						models: []
					};
					const response = await api.mutateSettings(settingsNs, [{
						op: "set",
						path: ["servers", id],
						value: serverEntry
					}], revisionRef.current);
					if (!response.ok) setCustomError(response.error?.message ?? "unknown error");
					else {
						setShowCustomForm(false);
						setCustomDraft(emptyCustomDraft());
						await loadServers();
					}
				} catch (err) {
					setCustomError(err instanceof Error ? err.message : String(err));
				}
				setCustomSaving(false);
			};
			/** Update one custom-form env draft row. */
			const updateCustomEnvRow = (index, patch) => {
				setCustomDraft((prev) => {
					const rows = [...prev.env];
					const row = rows[index];
					if (row === void 0) return prev;
					rows[index] = {
						...row,
						...patch
					};
					return {
						...prev,
						env: rows
					};
				});
			};
			/** Add an empty env row to the custom form. */
			const addCustomEnvRow = () => {
				setCustomDraft((prev) => ({
					...prev,
					env: [...prev.env, {
						key: "",
						value: ""
					}]
				}));
			};
			/** Remove one env row from the custom form. */
			const removeCustomEnvRow = (index) => {
				setCustomDraft((prev) => {
					const rows = [...prev.env];
					rows.splice(index, 1);
					return {
						...prev,
						env: rows
					};
				});
			};
			/** Remove a configured server. */
			const removeServer = async (id) => {
				setRemovingId(id);
				setError(void 0);
				try {
					const response = await api.mutateSettings(settingsNs, [{
						op: "unset",
						path: ["servers", id]
					}], revisionRef.current);
					if (!response.ok) setError(response.error?.message ?? "unknown error");
					else await loadServers();
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
				setRemovingId(void 0);
			};
			/** Expand a server card, loading drafts and discovered models. */
			const expandServer = async (id) => {
				if (expandedId === id) {
					setExpandedId(void 0);
					return;
				}
				const server = servers[id];
				setExpandedId(id);
				if (server !== void 0) {
					setEnvDrafts((prev) => ({
						...prev,
						[id]: envToDrafts(server.env)
					}));
					setModelDrafts((prev) => ({
						...prev,
						[id]: server.models ?? []
					}));
					setCustomModelDrafts((prev) => ({
						...prev,
						[id]: (server.customModels ?? []).map((m) => ({
							id: m.id,
							name: m.name
						}))
					}));
				}
				setModelsLoading((prev) => new Set(prev).add(id));
				const [models, info, authUrl] = await Promise.all([
					loadProviderModels(api, settingsNs, `acp-${id}`),
					loadServerInfo(api, settingsNs, id),
					loadAuthUrl(api, settingsNs, id)
				]);
				setDiscoveredModels((prev) => ({
					...prev,
					[id]: models
				}));
				setServerInfo((prev) => prev[id] === info ? prev : {
					...prev,
					[id]: info
				});
				setAuthUrls((prev) => prev[id] === authUrl ? prev : {
					...prev,
					[id]: authUrl
				});
				setModelsLoading((prev) => {
					const next = new Set(prev);
					next.delete(id);
					return next;
				});
			};
			/** Re-fetch the model catalog and live server info for one server. */
			const refreshModels = async (id) => {
				setModelsLoading((prev) => new Set(prev).add(id));
				const [models, info, authUrl] = await Promise.all([
					loadProviderModels(api, settingsNs, `acp-${id}`),
					loadServerInfo(api, settingsNs, id),
					loadAuthUrl(api, settingsNs, id)
				]);
				setDiscoveredModels((prev) => ({
					...prev,
					[id]: models
				}));
				setServerInfo((prev) => prev[id] === info ? prev : {
					...prev,
					[id]: info
				});
				setAuthUrls((prev) => prev[id] === authUrl ? prev : {
					...prev,
					[id]: authUrl
				});
				setModelsLoading((prev) => {
					const next = new Set(prev);
					next.delete(id);
					return next;
				});
			};
			/** Save the editable drafts for one server to settings. */
			const saveServerConfig = async (id) => {
				setSavingId(id);
				setError(void 0);
				try {
					const env = draftsToEnv(envDrafts[id] ?? []);
					const models = modelDrafts[id] ?? [];
					const customModels = (customModelDrafts[id] ?? []).filter((m) => m.id.trim().length > 0).map((m) => ({
						id: m.id.trim(),
						name: m.name.trim()
					}));
					const response = await api.mutateSettings(settingsNs, [
						{
							op: "set",
							path: [
								"servers",
								id,
								"env"
							],
							value: env
						},
						{
							op: "set",
							path: [
								"servers",
								id,
								"models"
							],
							value: models
						},
						{
							op: "set",
							path: [
								"servers",
								id,
								"customModels"
							],
							value: customModels
						}
					], revisionRef.current);
					if (!response.ok) setError(response.error?.message ?? "unknown error");
					else await loadServers();
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
				setSavingId(void 0);
			};
			/** Update one test step's state. */
			const setTestStep = (step, state) => {
				setTestSteps((prev) => ({
					...prev,
					[step]: state
				}));
			};
			/** Run the end-to-end server test: handshake → model catalog → probe prompt.
			* Each step runs only when the previous one passed; failures short-circuit
			* the remaining steps so a dead server doesn't burn three timeouts. Every
			* failure surfaces the underlying error message in its detail line. */
			const runTest = async (id, name) => {
				setTestServer({
					id,
					name
				});
				setTestSteps({
					handshake: { status: "running" },
					models: { status: "running" },
					message: { status: "running" }
				});
				/** Call one discovery route, converting thrown transport errors into the
				* failure branch so every step can show a concrete reason. */
				const rawDiscover = async (provider) => {
					try {
						return await api.discoverModels(settingsNs, provider);
					} catch (err) {
						return {
							ok: false,
							error: { message: err instanceof Error ? err.message : String(err) }
						};
					}
				};
				const infoRes = await rawDiscover(`acp-info-${id}`);
				const infoEntry = (infoRes.ok ? infoRes.value ?? [] : [])[0];
				if (infoRes.error !== void 0) {
					setTestStep("handshake", {
						status: "fail",
						detail: infoRes.error.message
					});
					setTestStep("models", {
						status: "fail",
						detail: t("testSkipped")
					});
					setTestStep("message", {
						status: "fail",
						detail: t("testSkipped")
					});
					return;
				}
				if (infoEntry === void 0 || infoEntry.id === "error") {
					setTestStep("handshake", {
						status: "fail",
						detail: infoEntry?.name ?? t("testHandshakeFail")
					});
					setTestStep("models", {
						status: "fail",
						detail: t("testSkipped")
					});
					setTestStep("message", {
						status: "fail",
						detail: t("testSkipped")
					});
					return;
				}
				if (infoEntry.id === "unknown") setTestStep("handshake", {
					status: "pass",
					detail: infoEntry.name
				});
				else setTestStep("handshake", {
					status: "pass",
					detail: `${infoEntry.id} v${infoEntry.name}` + (infoEntry.contextWindow !== void 0 ? ` · ${t("serverProtocol")}: ${infoEntry.contextWindow}` : "")
				});
				const modelsRes = await rawDiscover(`acp-${id}`);
				const models = (modelsRes.ok ? modelsRes.value ?? [] : []).map((m) => ({
					id: m.id,
					name: m.name ?? m.id
				}));
				if (!modelsRes.ok) {
					setTestStep("models", {
						status: "fail",
						detail: modelsRes.error?.message ?? t("testNoModels")
					});
					setTestStep("message", {
						status: "fail",
						detail: t("testSkipped")
					});
					return;
				}
				if (models.length === 0) {
					setTestStep("models", {
						status: "fail",
						detail: `${t("testNoModels")} — the server connected but returned an empty model catalog; the agent may not have discovered any models yet, or it may manage models internally`
					});
					setTestStep("message", {
						status: "fail",
						detail: t("testSkipped")
					});
					return;
				}
				setTestStep("models", {
					status: "pass",
					detail: `${models.length} · ${models.slice(0, 5).map((m) => m.id).join(", ")}${models.length > 5 ? "…" : ""}`
				});
				const msgRes = await rawDiscover(`acp-test-${id}`);
				const entry = (msgRes.ok ? msgRes.value ?? [] : [])[0];
				if (entry?.id === "ok") setTestStep("message", {
					status: "pass",
					detail: entry.name
				});
				else if (entry?.id === "error") setTestStep("message", {
					status: "fail",
					detail: entry.name
				});
				else setTestStep("message", {
					status: "fail",
					detail: msgRes.error?.message ?? t("testNoResponse")
				});
			};
			/** Update one env draft row. */
			const updateEnvRow = (serverId, index, patch) => {
				setEnvDrafts((prev) => {
					const rows = [...prev[serverId] ?? []];
					const row = rows[index];
					if (row === void 0) return prev;
					rows[index] = {
						...row,
						...patch
					};
					return {
						...prev,
						[serverId]: rows
					};
				});
			};
			/** Add an empty env draft row. */
			const addEnvRow = (serverId) => {
				setEnvDrafts((prev) => ({
					...prev,
					[serverId]: [...prev[serverId] ?? [], {
						key: "",
						value: ""
					}]
				}));
			};
			/** Remove one env draft row. */
			const removeEnvRow = (serverId, index) => {
				setEnvDrafts((prev) => {
					const rows = [...prev[serverId] ?? []];
					rows.splice(index, 1);
					return {
						...prev,
						[serverId]: rows
					};
				});
			};
			/** Toggle one model in the model draft selection. */
			const toggleModel = (serverId, modelId) => {
				setModelDrafts((prev) => {
					const current = new Set(prev[serverId] ?? []);
					if (current.has(modelId)) current.delete(modelId);
					else current.add(modelId);
					return {
						...prev,
						[serverId]: [...current]
					};
				});
			};
			/** Update one custom model draft row. */
			const updateCustomModelRow = (serverId, index, patch) => {
				setCustomModelDrafts((prev) => {
					const rows = [...prev[serverId] ?? []];
					const row = rows[index];
					if (row === void 0) return prev;
					rows[index] = {
						...row,
						...patch
					};
					return {
						...prev,
						[serverId]: rows
					};
				});
			};
			/** Add an empty custom model draft row. */
			const addCustomModelRow = (serverId) => {
				setCustomModelDrafts((prev) => ({
					...prev,
					[serverId]: [...prev[serverId] ?? [], {
						id: "",
						name: ""
					}]
				}));
			};
			/** Remove one custom model draft row. */
			const removeCustomModelRow = (serverId, index) => {
				setCustomModelDrafts((prev) => {
					const rows = [...prev[serverId] ?? []];
					rows.splice(index, 1);
					return {
						...prev,
						[serverId]: rows
					};
				});
			};
			const filteredAgents = (0, react.useMemo)(() => {
				const q = search.trim().toLowerCase();
				if (q === "") return registry.agents;
				return registry.agents.filter((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q) || a.description.toLowerCase().includes(q));
			}, [registry.agents, search]);
			const serverList = Object.entries(servers).sort(([a], [b]) => a.localeCompare(b));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: AcpSettingsSection_module_css_default.section,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: AcpSettingsSection_module_css_default.heading,
						children: t("title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: AcpSettingsSection_module_css_default.intro,
						children: t("intro")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: AcpSettingsSection_module_css_default.tabs,
						role: "tablist",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							role: "tab",
							className: AcpSettingsSection_module_css_default.tab,
							"aria-selected": tab === "registry",
							"data-active": tab === "registry" ? "true" : void 0,
							onClick: () => {
								setTab("registry");
							},
							children: t("registryTab")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							role: "tab",
							className: AcpSettingsSection_module_css_default.tab,
							"aria-selected": tab === "servers",
							"data-active": tab === "servers" ? "true" : void 0,
							onClick: () => {
								setTab("servers");
							},
							children: t("serversTab")
						})]
					}),
					error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: AcpSettingsSection_module_css_default.error,
						children: error
					}),
					tab === "registry" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: AcpSettingsSection_module_css_default.panel,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: AcpSettingsSection_module_css_default.registryToolbar,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "search",
								className: AcpSettingsSection_module_css_default.search,
								placeholder: t("registrySearch"),
								value: search,
								onChange: (e) => {
									setSearch(e.target.value);
								}
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: AcpSettingsSection_module_css_default.customAddButton,
								onClick: () => {
									setCustomError(void 0);
									setShowCustomForm(true);
								},
								children: ["+ ", t("customAdd")]
							})]
						}), filteredAgents.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: AcpSettingsSection_module_css_default.empty,
							children: t("registryEmpty")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: AcpSettingsSection_module_css_default.list,
							children: filteredAgents.map((agent) => {
								const isAdded = servers[agent.id] !== void 0;
								const distType = distributionType(agent);
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: AcpSettingsSection_module_css_default.agentCard,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: AcpSettingsSection_module_css_default.agentInfo,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: AcpSettingsSection_module_css_default.agentName,
												children: agent.name
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: AcpSettingsSection_module_css_default.agentDesc,
												children: agent.description
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: AcpSettingsSection_module_css_default.agentMeta,
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: AcpSettingsSection_module_css_default.distBadge,
														children: distType
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
														t("version"),
														": ",
														agent.version
													] }),
													agent.authors !== void 0 && agent.authors.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
														t("authors"),
														": ",
														agent.authors.join(", ")
													] })
												]
											})
										]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: AcpSettingsSection_module_css_default.addButton,
										disabled: isAdded || addingId === agent.id,
										onClick: () => {
											addServer(agent);
										},
										children: isAdded ? t("added") : addingId === agent.id ? t("adding") : t("add")
									})]
								}, agent.id);
							})
						})]
					}),
					tab === "servers" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: AcpSettingsSection_module_css_default.panel,
						children: !loading && serverList.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: AcpSettingsSection_module_css_default.empty,
							children: t("noServers")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: AcpSettingsSection_module_css_default.list,
							children: serverList.map(([id, server]) => {
								const isExpanded = expandedId === id;
								const rows = envDrafts[id] ?? [];
								const selectedModels = modelDrafts[id] ?? [];
								const models = discoveredModels[id] ?? [];
								const isLoadingModels = modelsLoading.has(id);
								const info = serverInfo[id];
								const registryAgent = registry.agents.find((a) => a.id === id);
								const versionLabel = serverVersionLabel(info, registryAgent);
								const authUrl = authUrls[id];
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: AcpSettingsSection_module_css_default.serverCardBlock,
									children: [
										authUrl !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: AcpSettingsSection_module_css_default.authBanner,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("authPending") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
												href: authUrl,
												target: "_blank",
												rel: "noreferrer",
												className: AcpSettingsSection_module_css_default.authLink,
												children: t("authOpen")
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: AcpSettingsSection_module_css_default.serverCard,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: AcpSettingsSection_module_css_default.agentInfo,
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
														className: AcpSettingsSection_module_css_default.agentName,
														children: server.name
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
														className: AcpSettingsSection_module_css_default.serverCommand,
														children: [
															t("serverCommand"),
															": ",
															server.command,
															" ",
															server.args.join(" ")
														]
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														className: AcpSettingsSection_module_css_default.agentMeta,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["acp-", id] }), versionLabel !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
															t("serverVersion"),
															": ",
															versionLabel
														] })]
													})
												]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: AcpSettingsSection_module_css_default.cardActions,
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: AcpSettingsSection_module_css_default.editButton,
														onClick: () => {
															runTest(id, server.name);
														},
														children: t("test")
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: AcpSettingsSection_module_css_default.editButton,
														onClick: () => {
															expandServer(id);
														},
														children: isExpanded ? t("collapse") : t("edit")
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: AcpSettingsSection_module_css_default.removeButton,
														disabled: removingId === id,
														onClick: () => {
															if (window.confirm(t("removeConfirm"))) removeServer(id);
														},
														children: removingId === id ? "…" : t("remove")
													})
												]
											})]
										}),
										isExpanded && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: AcpSettingsSection_module_css_default.serverDetail,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: AcpSettingsSection_module_css_default.detailSection,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
														className: AcpSettingsSection_module_css_default.detailHeading,
														children: t("serverVersion")
													}), info !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														className: AcpSettingsSection_module_css_default.versionInfo,
														children: [
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																className: AcpSettingsSection_module_css_default.versionName,
																children: info.agentName
															}),
															/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																className: AcpSettingsSection_module_css_default.versionTag,
																children: ["v", info.agentVersion]
															}),
															info.protocolVersion !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																className: AcpSettingsSection_module_css_default.versionTag,
																children: [
																	t("serverProtocol"),
																	": ",
																	info.protocolVersion
																]
															})
														]
													}) : registryAgent !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														className: AcpSettingsSection_module_css_default.versionInfo,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: AcpSettingsSection_module_css_default.versionName,
															children: registryAgent.name
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
															className: AcpSettingsSection_module_css_default.versionTag,
															children: ["v", registryAgent.version]
														})]
													}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
														className: AcpSettingsSection_module_css_default.emptyInline,
														children: t("serverVersionUnknown")
													})]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: AcpSettingsSection_module_css_default.detailSection,
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
															className: AcpSettingsSection_module_css_default.detailHeading,
															children: t("envVars")
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
															className: AcpSettingsSection_module_css_default.detailHint,
															children: t("envVarsHint")
														}),
														rows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
															className: AcpSettingsSection_module_css_default.emptyInline,
															children: t("noEnvVars")
														}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
															className: AcpSettingsSection_module_css_default.envList,
															children: rows.map((row, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
																className: AcpSettingsSection_module_css_default.envRow,
																children: [
																	/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
																		type: "text",
																		className: AcpSettingsSection_module_css_default.envKey,
																		placeholder: t("envKey"),
																		value: row.key,
																		onChange: (e) => {
																			updateEnvRow(id, index, { key: e.target.value });
																		}
																	}),
																	/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
																		type: "text",
																		className: AcpSettingsSection_module_css_default.envValue,
																		placeholder: t("envValue"),
																		value: row.value,
																		onChange: (e) => {
																			updateEnvRow(id, index, { value: e.target.value });
																		}
																	}),
																	/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																		type: "button",
																		className: AcpSettingsSection_module_css_default.envRemove,
																		onClick: () => {
																			removeEnvRow(id, index);
																		},
																		children: "×"
																	})
																]
															}, index))
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
															type: "button",
															className: AcpSettingsSection_module_css_default.addEnvButton,
															onClick: () => {
																addEnvRow(id);
															},
															children: ["+ ", t("addEnvVar")]
														})
													]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: AcpSettingsSection_module_css_default.detailSection,
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															className: AcpSettingsSection_module_css_default.modelSelectHeader,
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
																className: AcpSettingsSection_module_css_default.detailHeading,
																children: t("modelSelect")
															}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																type: "button",
																className: AcpSettingsSection_module_css_default.refreshButton,
																disabled: isLoadingModels,
																onClick: () => {
																	refreshModels(id);
																},
																children: isLoadingModels ? t("refreshingModels") : t("refreshModels")
															})]
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
															className: AcpSettingsSection_module_css_default.detailHint,
															children: t("modelSelectHint")
														}),
														isLoadingModels ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
															className: AcpSettingsSection_module_css_default.emptyInline,
															children: t("modelsLoading")
														}) : models.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
															className: AcpSettingsSection_module_css_default.emptyInline,
															children: info !== void 0 ? t("noModelsConnected") : t("noModels")
														}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
															type: "search",
															className: AcpSettingsSection_module_css_default.modelSearch,
															placeholder: t("modelSearch"),
															value: modelSearch[id] ?? "",
															onChange: (e) => {
																setModelSearch((prev) => ({
																	...prev,
																	[id]: e.target.value
																}));
															}
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
															className: AcpSettingsSection_module_css_default.modelList,
															children: models.filter((model) => {
																const q = (modelSearch[id] ?? "").trim().toLowerCase();
																if (q === "") return true;
																return model.name.toLowerCase().includes(q) || model.id.toLowerCase().includes(q);
															}).sort((a, b) => {
																return (selectedModels.includes(a.id) ? 0 : 1) - (selectedModels.includes(b.id) ? 0 : 1);
															}).map((model) => {
																const checked = selectedModels.includes(model.id);
																return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
																	className: AcpSettingsSection_module_css_default.modelRow,
																	children: [
																		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
																			type: "checkbox",
																			checked,
																			onChange: () => {
																				toggleModel(id, model.id);
																			}
																		}),
																		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																			className: AcpSettingsSection_module_css_default.modelName,
																			children: model.name
																		}),
																		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																			className: AcpSettingsSection_module_css_default.modelId,
																			children: model.id
																		})
																	]
																}, model.id);
															})
														})] }),
														models.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															className: AcpSettingsSection_module_css_default.modelActions,
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																type: "button",
																className: AcpSettingsSection_module_css_default.linkButton,
																onClick: () => {
																	setModelDrafts((prev) => ({
																		...prev,
																		[id]: models.map((m) => m.id)
																	}));
																},
																children: t("selectAll")
															}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																type: "button",
																className: AcpSettingsSection_module_css_default.linkButton,
																onClick: () => {
																	setModelDrafts((prev) => ({
																		...prev,
																		[id]: []
																	}));
																},
																children: t("selectNone")
															})]
														})
													]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: AcpSettingsSection_module_css_default.detailSection,
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
															className: AcpSettingsSection_module_css_default.detailHeading,
															children: t("customModels")
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
															className: AcpSettingsSection_module_css_default.detailHint,
															children: t("customModelsHint")
														}),
														(customModelDrafts[id] ?? []).length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
															className: AcpSettingsSection_module_css_default.emptyInline,
															children: t("noCustomModels")
														}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
															className: AcpSettingsSection_module_css_default.envList,
															children: (customModelDrafts[id] ?? []).map((row, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
																className: AcpSettingsSection_module_css_default.envRow,
																children: [
																	/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
																		type: "text",
																		className: AcpSettingsSection_module_css_default.envKey,
																		placeholder: t("customModelId"),
																		value: row.id,
																		onChange: (e) => {
																			updateCustomModelRow(id, index, { id: e.target.value });
																		}
																	}),
																	/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
																		type: "text",
																		className: AcpSettingsSection_module_css_default.envValue,
																		placeholder: t("customModelName"),
																		value: row.name,
																		onChange: (e) => {
																			updateCustomModelRow(id, index, { name: e.target.value });
																		}
																	}),
																	/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																		type: "button",
																		className: AcpSettingsSection_module_css_default.envRemove,
																		onClick: () => {
																			removeCustomModelRow(id, index);
																		},
																		children: "×"
																	})
																]
															}, index))
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
															type: "button",
															className: AcpSettingsSection_module_css_default.addEnvButton,
															onClick: () => {
																addCustomModelRow(id);
															},
															children: ["+ ", t("addCustomModel")]
														})
													]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: AcpSettingsSection_module_css_default.saveButton,
													disabled: savingId === id,
													onClick: () => {
														saveServerConfig(id);
													},
													children: savingId === id ? t("saving") : t("save")
												})
											]
										})
									]
								}, id);
							})
						})
					}),
					testServer !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: AcpSettingsSection_module_css_default.modalOverlay,
						onClick: () => {
							setTestServer(void 0);
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: AcpSettingsSection_module_css_default.modal,
							onClick: (e) => {
								e.stopPropagation();
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: AcpSettingsSection_module_css_default.modalHeader,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: AcpSettingsSection_module_css_default.modalTitle,
									children: [
										t("testTitle"),
										" — ",
										testServer.name
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: AcpSettingsSection_module_css_default.modalClose,
									onClick: () => {
										setTestServer(void 0);
									},
									children: "×"
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: AcpSettingsSection_module_css_default.testSteps,
								children: TEST_STEP_IDS.map((stepId) => {
									const step = testSteps[stepId];
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: AcpSettingsSection_module_css_default.testStep,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: `${AcpSettingsSection_module_css_default.testStepStatus} ${AcpSettingsSection_module_css_default[`test_${step.status}`]}`,
											children: step.status === "pass" ? "✓" : step.status === "fail" ? "✗" : "…"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: AcpSettingsSection_module_css_default.testStepBody,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: AcpSettingsSection_module_css_default.testStepLabel,
												children: t(`testStep_${stepId}`)
											}), step.detail !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: AcpSettingsSection_module_css_default.testStepDetail,
												children: step.detail
											})]
										})]
									}, stepId);
								})
							})]
						})
					}),
					showCustomForm && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: AcpSettingsSection_module_css_default.modalOverlay,
						onClick: () => {
							setShowCustomForm(false);
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: AcpSettingsSection_module_css_default.modal,
							onClick: (e) => {
								e.stopPropagation();
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: AcpSettingsSection_module_css_default.modalHeader,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: AcpSettingsSection_module_css_default.modalTitle,
									children: t("customTitle")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: AcpSettingsSection_module_css_default.modalClose,
									onClick: () => {
										setShowCustomForm(false);
									},
									children: "×"
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: AcpSettingsSection_module_css_default.customForm,
								children: [
									customError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: AcpSettingsSection_module_css_default.error,
										children: customError
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: AcpSettingsSection_module_css_default.detailSection,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: AcpSettingsSection_module_css_default.detailHeading,
												children: t("customId")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: AcpSettingsSection_module_css_default.detailHint,
												children: t("customIdHint")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "text",
												className: AcpSettingsSection_module_css_default.customInput,
												placeholder: "my-agent",
												value: customDraft.id,
												onChange: (e) => {
													setCustomDraft((prev) => ({
														...prev,
														id: e.target.value
													}));
												}
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: AcpSettingsSection_module_css_default.detailSection,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: AcpSettingsSection_module_css_default.detailHeading,
											children: t("customName")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "text",
											className: AcpSettingsSection_module_css_default.customInput,
											placeholder: t("customName"),
											value: customDraft.name,
											onChange: (e) => {
												setCustomDraft((prev) => ({
													...prev,
													name: e.target.value
												}));
											}
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: AcpSettingsSection_module_css_default.detailSection,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: AcpSettingsSection_module_css_default.detailHeading,
												children: t("customCommand")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: AcpSettingsSection_module_css_default.detailHint,
												children: t("customCommandHint")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "text",
												className: AcpSettingsSection_module_css_default.customInput,
												placeholder: "npx",
												value: customDraft.command,
												onChange: (e) => {
													setCustomDraft((prev) => ({
														...prev,
														command: e.target.value
													}));
												}
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: AcpSettingsSection_module_css_default.detailSection,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: AcpSettingsSection_module_css_default.detailHeading,
												children: t("customArgs")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: AcpSettingsSection_module_css_default.detailHint,
												children: t("customArgsHint")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "text",
												className: AcpSettingsSection_module_css_default.customInput,
												placeholder: "-y @my-org/my-acp-agent",
												value: customDraft.args,
												onChange: (e) => {
													setCustomDraft((prev) => ({
														...prev,
														args: e.target.value
													}));
												}
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: AcpSettingsSection_module_css_default.detailSection,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: AcpSettingsSection_module_css_default.detailHeading,
												children: t("customEnv")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: AcpSettingsSection_module_css_default.detailHint,
												children: t("customEnvHint")
											}),
											customDraft.env.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: AcpSettingsSection_module_css_default.emptyInline,
												children: t("noEnvVars")
											}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: AcpSettingsSection_module_css_default.envList,
												children: customDraft.env.map((row, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: AcpSettingsSection_module_css_default.envRow,
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
															type: "text",
															className: AcpSettingsSection_module_css_default.envKey,
															placeholder: t("envKey"),
															value: row.key,
															onChange: (e) => {
																updateCustomEnvRow(index, { key: e.target.value });
															}
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
															type: "text",
															className: AcpSettingsSection_module_css_default.envValue,
															placeholder: t("envValue"),
															value: row.value,
															onChange: (e) => {
																updateCustomEnvRow(index, { value: e.target.value });
															}
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															type: "button",
															className: AcpSettingsSection_module_css_default.envRemove,
															onClick: () => {
																removeCustomEnvRow(index);
															},
															children: "×"
														})
													]
												}, index))
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												className: AcpSettingsSection_module_css_default.addEnvButton,
												onClick: () => {
													addCustomEnvRow();
												},
												children: ["+ ", t("addEnvVar")]
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: AcpSettingsSection_module_css_default.saveButton,
										disabled: customSaving,
										onClick: () => {
											addCustomServer();
										},
										children: customSaving ? t("customSaving") : t("customSave")
									})
								]
							})]
						})
					})
				]
			});
		}
		//#endregion
		//#region \0dsh-css:/Users/shenkonghui/src/github/dsh-plugin/dsh-llm-acp/src/client/AcpStatusBar.module.css.mjs
		const css = ".Lw037q_wrapper{align-items:center;display:inline-flex;position:relative}.Lw037q_trigger{cursor:pointer;color:var(--dsw-alias-label-secondary,#888);background:0 0;border:none;border-radius:4px;align-items:center;gap:6px;padding:2px 4px;font-size:12px;display:inline-flex}.Lw037q_trigger:hover{background:var(--dsw-alias-fill-hover,#0000000f)}.Lw037q_dot{border-radius:50%;flex-shrink:0;width:8px;height:8px;display:inline-block}.Lw037q_dotOk{background:#22c55e}.Lw037q_dotWarn{background:#f59e0b}.Lw037q_dotErr{background:#ef4444}.Lw037q_dotPending{background:var(--dsw-alias-label-tertiary,#bbb)}.Lw037q_label{letter-spacing:.02em;font-weight:600}.Lw037q_count{font-variant-numeric:tabular-nums;opacity:.8}.Lw037q_popover{background:var(--dsw-alias-elevated-fill,#fff);border:1px solid var(--dsw-alias-border,#e0e0e0);z-index:100;border-radius:8px;flex-direction:column;gap:2px;min-width:200px;max-width:280px;padding:6px;display:flex;position:absolute;bottom:calc(100% + 4px);left:0;box-shadow:0 4px 16px #0000001f}.Lw037q_serverRow{border-radius:4px;align-items:center;gap:8px;padding:4px 6px;font-size:12px;display:flex}.Lw037q_serverRow:hover{background:var(--dsw-alias-fill-hover,#0000000a)}.Lw037q_serverName{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;font-weight:500;overflow:hidden}.Lw037q_serverDetail{color:var(--dsw-alias-label-tertiary,#999);flex-shrink:0;font-size:11px}";
		const tagId = "@deepseek-ai/dsh-llm-acp/AcpStatusBar.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-llm-acp";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var AcpStatusBar_module_css_default = {
			"trigger": "Lw037q_trigger",
			"dotWarn": "Lw037q_dotWarn",
			"dotErr": "Lw037q_dotErr",
			"count": "Lw037q_count",
			"dotPending": "Lw037q_dotPending",
			"label": "Lw037q_label",
			"popover": "Lw037q_popover",
			"serverDetail": "Lw037q_serverDetail",
			"wrapper": "Lw037q_wrapper",
			"dotOk": "Lw037q_dotOk",
			"dot": "Lw037q_dot",
			"serverRow": "Lw037q_serverRow",
			"serverName": "Lw037q_serverName"
		};
		//#endregion
		//#region src/client/AcpStatusBar.tsx
		/** Sidebar footer indicator showing ACP server connection status. */
		/** Probe one ACP server by calling discoverModels; resolve to a status row. */
		async function probeServer(api, settingsNs, id, server) {
			const row = {
				id,
				name: server.name,
				status: "checking",
				modelCount: 0
			};
			try {
				const response = await api.discoverModels(settingsNs, `acp-${id}`);
				if (response.ok) {
					const models = response.value ?? [];
					row.status = "connected";
					row.modelCount = models.length;
				} else row.status = "disconnected";
			} catch {
				row.status = "disconnected";
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
					if (ns !== void 0) servers = ns.value?.servers ?? {};
				}
			} catch {
				return [];
			}
			const entries = Object.entries(servers);
			if (entries.length === 0) return [];
			return Promise.all(entries.map(([id, server]) => probeServer(api, settingsNs, id, server)));
		}
		/** Render the ACP connection-status indicator for the sidebar footer. */
		function AcpStatusBar(props) {
			const { t, api, settingsNs } = props;
			const [rows, setRows] = (0, react.useState)([]);
			const [expanded, setExpanded] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				let cancelled = false;
				const refresh = async () => {
					const next = await loadServerStatuses(api, settingsNs);
					if (!cancelled) setRows(next);
				};
				refresh();
				const timer = setInterval(refresh, 3e4);
				return () => {
					cancelled = true;
					clearInterval(timer);
				};
			}, [api, settingsNs]);
			if (rows.length === 0) return null;
			const connected = rows.filter((r) => r.status === "connected").length;
			const total = rows.length;
			const dotClass = connected === total ? AcpStatusBar_module_css_default.dotOk : connected === 0 ? AcpStatusBar_module_css_default.dotErr : AcpStatusBar_module_css_default.dotWarn;
			const summary = t("statusSummary").replace("{connected}", String(connected)).replace("{total}", String(total));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: AcpStatusBar_module_css_default.wrapper,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: AcpStatusBar_module_css_default.trigger,
					onClick: () => {
						setExpanded((v) => !v);
					},
					title: summary,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: `${AcpStatusBar_module_css_default.dot} ${dotClass}` }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: AcpStatusBar_module_css_default.label,
							children: t("statusLabel")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: AcpStatusBar_module_css_default.count,
							children: [
								connected,
								"/",
								total
							]
						})
					]
				}), expanded && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: AcpStatusBar_module_css_default.popover,
					children: rows.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: AcpStatusBar_module_css_default.serverRow,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: `${AcpStatusBar_module_css_default.dot} ${row.status === "connected" ? AcpStatusBar_module_css_default.dotOk : row.status === "disconnected" ? AcpStatusBar_module_css_default.dotErr : AcpStatusBar_module_css_default.dotPending}` }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: AcpStatusBar_module_css_default.serverName,
								children: row.name
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: AcpStatusBar_module_css_default.serverDetail,
								children: row.status === "connected" ? t("statusConnected").replace("{n}", String(row.modelCount)) : row.status === "disconnected" ? t("statusDisconnected") : t("statusChecking")
							})
						]
					}, row.id))
				})]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** English copy. */
		const en = {
			nav: "ACP Servers",
			title: "ACP Servers",
			intro: "Add external ACP agent servers from the registry and manage configured servers.",
			registryTab: "Registry",
			serversTab: "My Servers",
			registrySearch: "Search agents…",
			registryEmpty: "No agents found.",
			add: "Add",
			adding: "Adding…",
			added: "Added",
			remove: "Remove",
			removeConfirm: "Remove this ACP server?",
			addFailed: "Failed to add the server.",
			removeFailed: "Failed to remove the server.",
			noServers: "No ACP servers configured. Browse the registry to add one.",
			serverCommand: "Command",
			serverArgs: "Arguments",
			serverName: "Name",
			distributionNpx: "npx",
			distributionBinary: "binary",
			distributionUvx: "uvx",
			version: "Version",
			authors: "Authors",
			repository: "Repository",
			website: "Website",
			edit: "Edit",
			collapse: "Collapse",
			save: "Save",
			saving: "Saving…",
			envVars: "Environment Variables",
			envVarsHint: "Set environment variables for authentication (e.g. API keys). These are merged on top of the plugin-level env.",
			envKey: "Key",
			envValue: "Value",
			addEnvVar: "Add variable",
			noEnvVars: "No environment variables set.",
			modelSelect: "Enabled Models",
			modelSelectHint: "Select which models to expose from this server. Leave empty to expose all discovered models.",
			noModels: "No models discovered yet. The server may still be starting.",
			modelsLoading: "Loading models…",
			modelSearch: "Filter models…",
			selectAll: "Select all",
			selectNone: "Select none",
			refreshModels: "Refresh models",
			refreshingModels: "Refreshing…",
			serverVersion: "Version",
			serverProtocol: "ACP protocol",
			serverVersionUnknown: "Version unavailable until the server connects.",
			noModelsConnected: "This server manages its own models. No selection is needed.",
			statusLabel: "ACP",
			statusSummary: "{connected}/{total} ACP servers connected",
			statusConnected: "{n} models",
			statusDisconnected: "offline",
			statusChecking: "checking…",
			test: "Test",
			testTitle: "Test ACP Server",
			testSkipped: "Skipped (previous step failed)",
			testStep_handshake: "Auth handshake",
			testStep_models: "Fetch models",
			testStep_message: "Send message",
			testHandshakeFail: "Handshake failed or the server has not initialized.",
			testNoModels: "No models discovered.",
			testNoResponse: "No result returned — the host plugin may be running a stale build; restart the harness and retry.",
			authPending: "This server is waiting for an interactive login.",
			authOpen: "Open login page",
			customAdd: "Add custom agent",
			customTitle: "Add Custom ACP Agent",
			customId: "Server ID",
			customIdHint: "Unique identifier for this server (lowercase letters, digits, hyphens).",
			customName: "Display name",
			customCommand: "Launch command",
			customCommandHint: "Executable path or command name (e.g. npx, node, /usr/local/bin/my-agent).",
			customArgs: "Arguments",
			customArgsHint: "Space-separated command arguments.",
			customEnv: "Environment variables",
			customEnvHint: "Environment variables passed to the agent process (e.g. API keys).",
			customSave: "Add",
			customSaving: "Adding…",
			customIdRequired: "Server ID is required.",
			customIdExists: "A server with this ID already exists.",
			customCommandRequired: "Launch command is required.",
			customModels: "Custom models",
			customModelsHint: "User-defined models to expose in addition to (or instead of) the discovered catalog. Custom models with the same id as a discovered model override its display name.",
			noCustomModels: "No custom models defined.",
			addCustomModel: "Add custom model",
			customModelId: "Model id",
			customModelName: "Display name"
		};
		/** Chinese copy. */
		const zh = {
			nav: "ACP 服务",
			title: "ACP 服务",
			intro: "从注册表添加外部 ACP 代理服务器，管理已配置的服务器。",
			registryTab: "注册表",
			serversTab: "我的服务",
			registrySearch: "搜索代理…",
			registryEmpty: "未找到代理。",
			add: "添加",
			adding: "添加中…",
			added: "已添加",
			remove: "移除",
			removeConfirm: "确定移除此 ACP 服务器？",
			addFailed: "添加服务器失败。",
			removeFailed: "移除服务器失败。",
			noServers: "尚未配置 ACP 服务器。浏览注册表来添加。",
			serverCommand: "命令",
			serverArgs: "参数",
			serverName: "名称",
			distributionNpx: "npx",
			distributionBinary: "二进制",
			distributionUvx: "uvx",
			version: "版本",
			authors: "作者",
			repository: "仓库",
			website: "网站",
			edit: "编辑",
			collapse: "收起",
			save: "保存",
			saving: "保存中…",
			envVars: "环境变量",
			envVarsHint: "为 ACP 服务设置环境变量用于认证（如 API Key），会与插件级环境变量合并。",
			envKey: "键名",
			envValue: "键值",
			addEnvVar: "添加变量",
			noEnvVars: "尚未设置环境变量。",
			modelSelect: "启用模型",
			modelSelectHint: "选择要启用的模型，不选则启用全部已发现的模型。",
			noModels: "尚未发现模型，服务可能仍在启动中。",
			modelsLoading: "模型加载中…",
			modelSearch: "筛选模型…",
			selectAll: "全选",
			selectNone: "全不选",
			refreshModels: "刷新模型",
			refreshingModels: "刷新中…",
			serverVersion: "版本",
			serverProtocol: "ACP 协议",
			serverVersionUnknown: "服务连接后才能获取版本信息。",
			noModelsConnected: "此服务自行管理模型，无需手动选择。",
			statusLabel: "ACP",
			statusSummary: "{connected}/{total} 个 ACP 服务已连接",
			statusConnected: "{n} 个模型",
			statusDisconnected: "离线",
			statusChecking: "检测中…",
			test: "测试",
			testTitle: "测试 ACP 服务",
			testSkipped: "已跳过（前序步骤失败）",
			testStep_handshake: "认证握手",
			testStep_models: "获取模型",
			testStep_message: "发送消息",
			testHandshakeFail: "握手失败或服务尚未完成初始化。",
			testNoModels: "未发现任何模型。",
			testNoResponse: "服务未返回结果——宿主端插件可能在运行旧版本，请重启 harness 后重试。",
			authPending: "此服务正在等待交互式登录。",
			authOpen: "打开登录页面",
			customAdd: "添加自定义 Agent",
			customTitle: "添加自定义 ACP Agent",
			customId: "服务 ID",
			customIdHint: "此服务的唯一标识符（小写字母、数字、连字符）。",
			customName: "显示名称",
			customCommand: "启动命令",
			customCommandHint: "可执行文件路径或命令名（如 npx、node、/usr/local/bin/my-agent）。",
			customArgs: "参数",
			customArgsHint: "以空格分隔的命令参数。",
			customEnv: "环境变量",
			customEnvHint: "传递给 agent 进程的环境变量（如 API Key）。",
			customSave: "添加",
			customSaving: "添加中…",
			customIdRequired: "服务 ID 不能为空。",
			customIdExists: "此 ID 已存在。",
			customCommandRequired: "启动命令不能为空。",
			customModels: "自定义模型",
			customModelsHint: "在已发现的模型目录之外额外暴露的用户自定义模型。与已发现模型同 id 的自定义模型会覆盖其显示名称。",
			noCustomModels: "未定义自定义模型。",
			addCustomModel: "添加自定义模型",
			customModelId: "模型 ID",
			customModelName: "显示名称"
		};
		//#endregion
		//#region src/registry.json
		var registry_default = {
			version: "1.0.0",
			agents: [
				{
					"id": "agoragentic-acp",
					"name": "Agoragentic",
					"version": "1.3.0",
					"description": "Agent marketplace with 174+ AI capabilities. Browse, invoke, and pay for agent services settled in USDC on Base L2.",
					"repository": "https://github.com/rhein1/agoragentic-integrations",
					"website": "https://agoragentic.com",
					"authors": ["ACRE / Agoragentic"],
					"license": "MIT",
					"distribution": { "npx": {
						"package": "agoragentic-mcp@1.3.0",
						"args": ["--acp"]
					} }
				},
				{
					"id": "amp-acp",
					"name": "Amp",
					"version": "0.9.0",
					"description": "ACP wrapper for Amp - the frontier coding agent",
					"repository": "https://github.com/tao12345666333/amp-acp",
					"authors": ["tao12345666333"],
					"license": "Apache-2.0",
					"icon": "./icon.svg",
					"distribution": { "binary": {
						"darwin-aarch64": {
							"archive": "https://github.com/tao12345666333/amp-acp/releases/download/v0.9.0/amp-acp-darwin-aarch64.tar.gz",
							"cmd": "./amp-acp",
							"sha256": "240a1a464f2a400ae51e9613b7f52b2abb6e7a29759001e9185291325671ccf1"
						},
						"darwin-x86_64": {
							"archive": "https://github.com/tao12345666333/amp-acp/releases/download/v0.9.0/amp-acp-darwin-x86_64.tar.gz",
							"cmd": "./amp-acp",
							"sha256": "0dc6d1ab8054e09b10ef49eea3e61afe363473d785bc9682ecb997480ec2f61f"
						},
						"linux-aarch64": {
							"archive": "https://github.com/tao12345666333/amp-acp/releases/download/v0.9.0/amp-acp-linux-aarch64.tar.gz",
							"cmd": "./amp-acp",
							"sha256": "b9e365221838b1a6e177c2fcd8f25a30086c3630e0330f1f6f74b25d2d4126c2"
						},
						"linux-x86_64": {
							"archive": "https://github.com/tao12345666333/amp-acp/releases/download/v0.9.0/amp-acp-linux-x86_64.tar.gz",
							"cmd": "./amp-acp",
							"sha256": "afaa50a152eb86a8ff21e354ded63fe2d21b730859692e3a60b2c4c9ef23df31"
						},
						"windows-x86_64": {
							"archive": "https://github.com/tao12345666333/amp-acp/releases/download/v0.9.0/amp-acp-windows-x86_64.zip",
							"cmd": "amp-acp.exe",
							"sha256": "3b2c3d14d703fcf9572da9733e4941703a7744bd37ec4aaa75421d6002c0157b"
						}
					} }
				},
				{
					"id": "auggie",
					"name": "Auggie CLI",
					"version": "0.35.0",
					"description": "Augment Code's powerful software agent, backed by industry-leading context engine",
					"repository": "https://github.com/augmentcode/auggie",
					"website": "https://www.augmentcode.com/",
					"authors": ["Augment Code <support@augmentcode.com>"],
					"license": "proprietary",
					"icon": "./icon.svg",
					"distribution": { "npx": {
						"package": "@augmentcode/auggie@0.35.0",
						"args": ["--acp"],
						"env": { "AUGMENT_DISABLE_AUTO_UPDATE": "1" }
					} }
				},
				{
					"id": "autohand",
					"name": "Autohand Code",
					"version": "0.2.1",
					"description": "Autohand Code - AI coding agent powered by Autohand AI",
					"repository": "https://github.com/autohandai/autohand-acp",
					"website": "https://www.autohand.ai/cli/",
					"authors": ["Autohand AI"],
					"license": "Apache-2.0",
					"distribution": { "npx": { "package": "@autohandai/autohand-acp@0.2.1" } }
				},
				{
					"id": "claude-acp",
					"name": "Claude Agent",
					"version": "0.69.0",
					"description": "ACP wrapper for Anthropic's Claude",
					"repository": "https://github.com/agentclientprotocol/claude-agent-acp",
					"authors": [
						"Anthropic",
						"Zed Industries",
						"JetBrains"
					],
					"license": "proprietary",
					"distribution": { "npx": { "package": "@agentclientprotocol/claude-agent-acp@0.69.0" } }
				},
				{
					"id": "cline",
					"name": "Cline",
					"version": "3.0.55",
					"description": "Autonomous coding agent CLI - capable of creating/editing files, running commands, using the browser, and more",
					"repository": "https://github.com/cline/cline",
					"website": "https://cline.bot/cli",
					"authors": ["Cline Bot Inc."],
					"license": "Apache-2.0",
					"icon": "./icon.svg",
					"distribution": { "npx": {
						"package": "cline@3.0.55",
						"args": ["--acp"]
					} }
				},
				{
					"id": "codebuddy-code",
					"name": "Codebuddy Code",
					"version": "2.106.7",
					"description": "Tencent Cloud's official intelligent coding tool",
					"website": "https://www.codebuddy.cn/cli/",
					"authors": ["Tencent Cloud"],
					"license": "Proprietary",
					"distribution": { "npx": {
						"package": "@tencent-ai/codebuddy-code@2.106.7",
						"args": ["--acp"]
					} }
				},
				{
					"id": "codex-acp",
					"name": "Codex",
					"version": "1.4.0",
					"description": "ACP adapter for OpenAI's coding assistant",
					"repository": "https://github.com/agentclientprotocol/codex-acp",
					"authors": [
						"OpenAI",
						"JetBrains s.r.o",
						"Zed Industries"
					],
					"license": "Apache-2.0",
					"distribution": { "npx": { "package": "@agentclientprotocol/codex-acp@1.4.0" } }
				},
				{
					"id": "cortex-code",
					"name": "Cortex Code",
					"version": "1.0.73",
					"description": "Snowflake's Cortex Code coding agent",
					"repository": "https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code",
					"authors": ["Snowflake"],
					"license": "proprietary",
					"distribution": { "binary": {
						"darwin-aarch64": {
							"archive": "https://sfc-repo.snowflakecomputing.com/cortex-code-cli/a4643c4278/1.0.73%2B180523.e6179a031de9/coco-1.0.73%2B180523.e6179a031de9-darwin-arm64.tar.gz",
							"cmd": "./coco-1.0.73+180523.e6179a031de9-darwin-arm64/cortex",
							"args": ["acp", "serve"]
						},
						"darwin-x86_64": {
							"archive": "https://sfc-repo.snowflakecomputing.com/cortex-code-cli/a4643c4278/1.0.73%2B180523.e6179a031de9/coco-1.0.73%2B180523.e6179a031de9-darwin-amd64.tar.gz",
							"cmd": "./coco-1.0.73+180523.e6179a031de9-darwin-amd64/cortex",
							"args": ["acp", "serve"]
						},
						"linux-x86_64": {
							"archive": "https://sfc-repo.snowflakecomputing.com/cortex-code-cli/a4643c4278/1.0.73%2B180523.e6179a031de9/coco-1.0.73%2B180523.e6179a031de9-linux-amd64.tar.gz",
							"cmd": "./coco-1.0.73+180523.e6179a031de9-linux-amd64/cortex",
							"args": ["acp", "serve"]
						},
						"linux-aarch64": {
							"archive": "https://sfc-repo.snowflakecomputing.com/cortex-code-cli/a4643c4278/1.0.73%2B180523.e6179a031de9/coco-1.0.73%2B180523.e6179a031de9-linux-arm64.tar.gz",
							"cmd": "./coco-1.0.73+180523.e6179a031de9-linux-arm64/cortex",
							"args": ["acp", "serve"]
						},
						"windows-x86_64": {
							"archive": "https://sfc-repo.snowflakecomputing.com/cortex-code-cli/a4643c4278/1.0.73%2B180523.e6179a031de9/coco-1.0.73%2B180523.e6179a031de9-windows-amd64.tar.gz",
							"cmd": "./coco-1.0.73+180523.e6179a031de9-windows-amd64/cortex.exe",
							"args": ["acp", "serve"]
						},
						"windows-aarch64": {
							"archive": "https://sfc-repo.snowflakecomputing.com/cortex-code-cli/a4643c4278/1.0.73%2B180523.e6179a031de9/coco-1.0.73%2B180523.e6179a031de9-windows-arm64.tar.gz",
							"cmd": "./coco-1.0.73+180523.e6179a031de9-windows-arm64/cortex.exe",
							"args": ["acp", "serve"]
						}
					} }
				},
				{
					"id": "corust-agent",
					"name": "Corust Agent",
					"version": "0.6.0",
					"description": "Co-building with a seasoned Rust partner.",
					"repository": "https://github.com/Corust-ai/corust-agent-release",
					"website": "https://corust.ai/",
					"authors": ["Corust AI <support@corust.ai>"],
					"license": "GPL-3.0-or-later",
					"distribution": { "binary": {
						"darwin-aarch64": {
							"archive": "https://github.com/Corust-ai/corust-agent-release/releases/download/v0.6.0/agent-darwin-arm64.tar.gz",
							"cmd": "./corust-agent-acp"
						},
						"darwin-x86_64": {
							"archive": "https://github.com/Corust-ai/corust-agent-release/releases/download/v0.6.0/agent-darwin-x64.tar.gz",
							"cmd": "./corust-agent-acp"
						},
						"linux-x86_64": {
							"archive": "https://github.com/Corust-ai/corust-agent-release/releases/download/v0.6.0/agent-linux-x64.tar.gz",
							"cmd": "./corust-agent-acp"
						},
						"windows-x86_64": {
							"archive": "https://github.com/Corust-ai/corust-agent-release/releases/download/v0.6.0/agent-windows-x64.zip",
							"cmd": "./corust-agent-acp.exe"
						}
					} }
				},
				{
					"id": "crow-cli",
					"name": "crow-cli",
					"version": "0.1.24",
					"description": "Minimal ACP Native Coding Agent",
					"repository": "https://github.com/crow-cli/crow-cli",
					"website": "https://crow-ai.dev",
					"authors": ["Thomas Wood"],
					"license": "Apache-2.0",
					"distribution": { "binary": {
						"darwin-aarch64": {
							"archive": "https://github.com/crow-cli/crow-cli/releases/download/v0.1.24/crow-cli-darwin-aarch64.tar.gz",
							"cmd": "./crow-cli",
							"args": ["acp"]
						},
						"darwin-x86_64": {
							"archive": "https://github.com/crow-cli/crow-cli/releases/download/v0.1.24/crow-cli-darwin-x86_64.tar.gz",
							"cmd": "./crow-cli",
							"args": ["acp"]
						},
						"linux-aarch64": {
							"archive": "https://github.com/crow-cli/crow-cli/releases/download/v0.1.24/crow-cli-linux-aarch64.tar.gz",
							"cmd": "./crow-cli",
							"args": ["acp"]
						},
						"linux-x86_64": {
							"archive": "https://github.com/crow-cli/crow-cli/releases/download/v0.1.24/crow-cli-linux-x86_64.tar.gz",
							"cmd": "./crow-cli",
							"args": ["acp"]
						},
						"windows-x86_64": {
							"archive": "https://github.com/crow-cli/crow-cli/releases/download/v0.1.24/crow-cli-windows-x86_64.zip",
							"cmd": "./crow-cli.exe",
							"args": ["acp"]
						}
					} }
				},
				{
					"id": "cursor",
					"name": "Cursor",
					"version": "2026.08.11",
					"description": "Cursor's coding agent",
					"website": "https://cursor.com/docs/cli/acp",
					"authors": ["Cursor"],
					"license": "proprietary",
					"distribution": { "binary": {
						"darwin-aarch64": {
							"archive": "https://downloads.cursor.com/lab/2026.08.11-e8db854/darwin/arm64/agent-cli-package.tar.gz",
							"cmd": "./dist-package/cursor-agent",
							"args": ["acp"]
						},
						"darwin-x86_64": {
							"archive": "https://downloads.cursor.com/lab/2026.08.11-e8db854/darwin/x64/agent-cli-package.tar.gz",
							"cmd": "./dist-package/cursor-agent",
							"args": ["acp"]
						},
						"linux-aarch64": {
							"archive": "https://downloads.cursor.com/lab/2026.08.11-e8db854/linux/arm64/agent-cli-package.tar.gz",
							"cmd": "./dist-package/cursor-agent",
							"args": ["acp"]
						},
						"linux-x86_64": {
							"archive": "https://downloads.cursor.com/lab/2026.08.11-e8db854/linux/x64/agent-cli-package.tar.gz",
							"cmd": "./dist-package/cursor-agent",
							"args": ["acp"]
						},
						"windows-aarch64": {
							"archive": "https://downloads.cursor.com/lab/2026.08.11-e8db854/windows/arm64/agent-cli-package.zip",
							"cmd": "./dist-package\\cursor-agent.cmd",
							"args": ["acp"]
						},
						"windows-x86_64": {
							"archive": "https://downloads.cursor.com/lab/2026.08.11-e8db854/windows/x64/agent-cli-package.zip",
							"cmd": "./dist-package\\cursor-agent.cmd",
							"args": ["acp"]
						}
					} }
				},
				{
					"id": "deepagents",
					"name": "DeepAgents",
					"version": "0.1.7",
					"description": "Batteries-included AI coding and general purpose agent powered by LangChain.",
					"repository": "https://github.com/langchain-ai/deepagentsjs",
					"website": "https://docs.langchain.com/oss/javascript/deepagents/overview",
					"authors": ["LangChain"],
					"license": "MIT",
					"distribution": { "npx": {
						"package": "deepagents-acp@0.1.7",
						"args": []
					} }
				},
				{
					"id": "devin",
					"name": "Devin",
					"version": "3000.4.25",
					"description": "Devin CLI coding agent by Cognition",
					"website": "https://docs.devin.ai/cli",
					"authors": ["Cognition"],
					"license": "proprietary",
					"repository": "https://github.com/CognitionAI/devin-cli",
					"distribution": { "binary": {
						"darwin-aarch64": {
							"archive": "https://static.devin.ai/cli/3000.4.25/devin-3000.4.25-aarch64-apple-darwin.tar.gz",
							"cmd": "./bin/devin",
							"args": ["acp"]
						},
						"darwin-x86_64": {
							"archive": "https://static.devin.ai/cli/3000.4.25/devin-3000.4.25-x86_64-apple-darwin.tar.gz",
							"cmd": "./bin/devin",
							"args": ["acp"]
						},
						"linux-aarch64": {
							"archive": "https://static.devin.ai/cli/3000.4.25/devin-3000.4.25-aarch64-unknown-linux.tar.gz",
							"cmd": "./bin/devin",
							"args": ["acp"]
						},
						"linux-x86_64": {
							"archive": "https://static.devin.ai/cli/3000.4.25/devin-3000.4.25-x86_64-unknown-linux.tar.gz",
							"cmd": "./bin/devin",
							"args": ["acp"]
						},
						"windows-aarch64": {
							"archive": "https://static.devin.ai/cli/3000.4.25/devin-3000.4.25-aarch64-pc-windows.zip",
							"cmd": "./bin\\devin.exe",
							"args": ["acp"]
						},
						"windows-x86_64": {
							"archive": "https://static.devin.ai/cli/3000.4.25/devin-3000.4.25-x86_64-pc-windows.zip",
							"cmd": "./bin\\devin.exe",
							"args": ["acp"]
						}
					} }
				},
				{
					"id": "dimcode",
					"name": "DimCode",
					"version": "0.3.16",
					"description": "A coding agent that puts leading models at your command.",
					"website": "https://dimcode.dev/docs/acp.html",
					"authors": ["ArcShips"],
					"license": "proprietary",
					"distribution": { "npx": {
						"package": "dimcode@0.3.16",
						"args": ["acp"]
					} }
				},
				{
					"id": "dirac",
					"name": "Dirac",
					"version": "0.4.37",
					"description": "Reduces API costs by more than 50%, produces better and faster work. Uses Hash anchored parallel edits, AST manipulation and a whole lot of neat optimizations. Fully Open Source.",
					"repository": "https://github.com/dirac-run/dirac",
					"website": "https://dirac.run",
					"authors": ["Dirac Delta Labs"],
					"license": "Apache-2.0",
					"icon": "./icon.svg",
					"distribution": { "npx": {
						"package": "dirac-cli@0.4.37",
						"args": ["--acp"]
					} }
				},
				{
					"id": "factory-droid",
					"name": "Factory Droid",
					"version": "0.198.0",
					"description": "Factory Droid - AI coding agent powered by Factory AI",
					"website": "https://factory.ai/product/cli",
					"authors": ["Factory AI"],
					"license": "proprietary",
					"distribution": { "npx": {
						"package": "droid@0.198.0",
						"args": [
							"exec",
							"--output-format",
							"acp-daemon"
						],
						"env": {
							"DROID_DISABLE_AUTO_UPDATE": "true",
							"FACTORY_DROID_AUTO_UPDATE_ENABLED": "false"
						}
					} }
				},
				{
					"id": "fast-agent",
					"name": "fast-agent",
					"version": "0.10.1",
					"description": "Code and build agents with comprehensive multi-provider support",
					"repository": "https://github.com/evalstate/fast-agent",
					"website": "https://fast-agent.ai",
					"authors": ["enquiries@fast-agent.ai"],
					"license": "Apache 2.0",
					"distribution": { "uvx": {
						"package": "fast-agent-acp==0.10.1",
						"args": ["-x"],
						"env": { "FAST_AGENT_MODEL": "codexplan" }
					} }
				},
				{
					"id": "gemini",
					"name": "Gemini CLI",
					"version": "0.55.1",
					"description": "Google's official CLI for Gemini",
					"repository": "https://github.com/google-gemini/gemini-cli",
					"website": "https://geminicli.com",
					"authors": ["Google"],
					"license": "Apache-2.0",
					"distribution": { "npx": {
						"package": "@google/gemini-cli@0.55.1",
						"args": ["--acp"]
					} }
				},
				{
					"id": "github-copilot",
					"name": "GitHub Copilot",
					"version": "1.532.2",
					"description": "GitHub's AI pair programmer",
					"repository": "https://github.com/github/copilot-language-server-release",
					"website": "https://github.com/features/copilot/cli/",
					"authors": ["GitHub"],
					"license": "proprietary",
					"distribution": { "npx": {
						"package": "@github/copilot-language-server@1.532.2",
						"args": ["--acp"]
					} }
				},
				{
					"id": "github-copilot-cli",
					"name": "GitHub Copilot",
					"version": "1.0.80",
					"description": "GitHub's AI pair programmer",
					"repository": "https://github.com/github/copilot-cli",
					"website": "https://github.com/features/copilot/cli/",
					"authors": ["GitHub"],
					"license": "proprietary",
					"distribution": { "npx": {
						"package": "@github/copilot@1.0.80",
						"args": ["--acp"]
					} }
				},
				{
					"id": "glm-acp-agent",
					"name": "GLM Agent",
					"version": "1.6.0",
					"description": "ACP agent powered by Zhipu AI's GLM Coding Plan models (glm-5.1, glm-5-turbo, glm-4.7, glm-4.5-air). Supports streaming, tool calls, mid-session model switching, image input via Z.AI Coding Plan Vision MCP, and session load/fork/resume with on-disk persistence.",
					"repository": "https://github.com/stefandevo/glm-acp-agent",
					"authors": ["Stefan de Vogelaere"],
					"license": "Apache-2.0",
					"icon": "icon.svg",
					"distribution": { "npx": { "package": "glm-acp-agent@1.6.0" } }
				},
				{
					"id": "goose",
					"name": "goose",
					"version": "1.46.0",
					"description": "A local, extensible, open source AI agent that automates engineering tasks",
					"repository": "https://github.com/block/goose",
					"website": "https://block.github.io/goose/",
					"authors": ["Block"],
					"license": "Apache-2.0",
					"distribution": { "binary": {
						"darwin-aarch64": {
							"archive": "https://github.com/block/goose/releases/download/v1.46.0/goose-aarch64-apple-darwin.tar.bz2",
							"cmd": "./goose",
							"args": ["acp"],
							"sha256": "de263fb06839de31345dff08aeba999ba165b023cd3cec7ec3bef20f6f4f7e73"
						},
						"darwin-x86_64": {
							"archive": "https://github.com/block/goose/releases/download/v1.46.0/goose-x86_64-apple-darwin.tar.bz2",
							"cmd": "./goose",
							"args": ["acp"],
							"sha256": "b5b66f5d4966aac74998c63420c98b3e289ae498f0c120463ac0b8dbc2a40083"
						},
						"linux-aarch64": {
							"archive": "https://github.com/block/goose/releases/download/v1.46.0/goose-aarch64-unknown-linux-gnu.tar.bz2",
							"cmd": "./goose",
							"args": ["acp"],
							"sha256": "b56da65ab1004832ce5524ed40ec6fbe38ba84dae654d0a8eb86be9d90086cf6"
						},
						"linux-x86_64": {
							"archive": "https://github.com/block/goose/releases/download/v1.46.0/goose-x86_64-unknown-linux-gnu.tar.bz2",
							"cmd": "./goose",
							"args": ["acp"],
							"sha256": "a1cf4856a765d07d6b95689a53c7bca21fcc6e6d65c0dfd064fc704052b85a7b"
						},
						"windows-x86_64": {
							"archive": "https://github.com/block/goose/releases/download/v1.46.0/goose-x86_64-pc-windows-msvc.zip",
							"cmd": "./goose-package\\goose.exe",
							"args": ["acp"],
							"sha256": "a903273d165c4b2ac3d30aa861f2e00753b07a5d24d24e37b65e36c86f937a76"
						}
					} }
				},
				{
					"id": "grok-build",
					"name": "Grok Build",
					"version": "1.0.5",
					"description": "xAI's coding agent and CLI",
					"website": "https://x.ai/cli",
					"authors": ["xAI"],
					"license": "proprietary",
					"distribution": { "npx": {
						"package": "@xai-official/grok@1.0.5",
						"args": ["agent", "stdio"]
					} }
				},
				{
					"id": "harn",
					"name": "Harn",
					"version": "0.10.103",
					"description": "Harn runs .harn agent pipelines as a native ACP coding agent over stdio.",
					"repository": "https://github.com/burin-labs/harn",
					"website": "https://harnlang.com",
					"authors": ["Burin Labs"],
					"license": "Apache-2.0",
					"distribution": { "binary": {
						"darwin-aarch64": {
							"archive": "https://github.com/burin-labs/harn/releases/download/v0.10.103/harn-aarch64-apple-darwin.tar.gz",
							"cmd": "./harn",
							"args": ["serve", "acp"],
							"sha256": "366150192837328364be7299f0765ac8938923115277a68b34dcc7e906a6f228"
						},
						"darwin-x86_64": {
							"archive": "https://github.com/burin-labs/harn/releases/download/v0.10.103/harn-x86_64-apple-darwin.tar.gz",
							"cmd": "./harn",
							"args": ["serve", "acp"],
							"sha256": "d64b9248ea1b80fc184c9a41ac2e2ecac341aa11299c6e634957e7fa0546f425"
						},
						"linux-aarch64": {
							"archive": "https://github.com/burin-labs/harn/releases/download/v0.10.103/harn-aarch64-unknown-linux-gnu.tar.gz",
							"cmd": "./harn",
							"args": ["serve", "acp"],
							"sha256": "64ff3424142e24df7838f23bab8ccaacabf547685ad1edefae5ed56668b76577"
						},
						"linux-x86_64": {
							"archive": "https://github.com/burin-labs/harn/releases/download/v0.10.103/harn-x86_64-unknown-linux-gnu.tar.gz",
							"cmd": "./harn",
							"args": ["serve", "acp"],
							"sha256": "9c1a4c74c47c9146b5ac6360fb2554fdcfa717d1c0be450dc42f26144b61bbdd"
						},
						"windows-x86_64": {
							"archive": "https://github.com/burin-labs/harn/releases/download/v0.10.103/harn-x86_64-pc-windows-msvc.zip",
							"cmd": "harn.exe",
							"args": ["serve", "acp"],
							"sha256": "06122e148c8155b35c33d5839049337bfe556cb7731b21a6b2dfb76fc20592df"
						}
					} }
				},
				{
					"id": "junie",
					"name": "Junie",
					"version": "2783.5.0",
					"description": "AI Coding Agent by JetBrains",
					"repository": "https://github.com/JetBrains/junie-acp-release",
					"website": "https://junie.jetbrains.com",
					"authors": ["JetBrains"],
					"license": "proprietary",
					"distribution": { "binary": {
						"darwin-aarch64": {
							"archive": "https://github.com/JetBrains/junie-acp-release/releases/download/2783.5/junie-release-2783.5-macos-aarch64.zip",
							"cmd": "./Applications/junie.app/Contents/MacOS/junie",
							"args": ["--acp=true"]
						},
						"darwin-x86_64": {
							"archive": "https://github.com/JetBrains/junie-acp-release/releases/download/2783.5/junie-release-2783.5-macos-amd64.zip",
							"cmd": "./Applications/junie.app/Contents/MacOS/junie",
							"args": ["--acp=true"]
						},
						"linux-aarch64": {
							"archive": "https://github.com/JetBrains/junie-acp-release/releases/download/2783.5/junie-release-2783.5-linux-aarch64.zip",
							"cmd": "./junie-app/bin/junie",
							"args": ["--acp=true"]
						},
						"linux-x86_64": {
							"archive": "https://github.com/JetBrains/junie-acp-release/releases/download/2783.5/junie-release-2783.5-linux-amd64.zip",
							"cmd": "./junie-app/bin/junie",
							"args": ["--acp=true"]
						},
						"windows-x86_64": {
							"archive": "https://github.com/JetBrains/junie-acp-release/releases/download/2783.5/junie-release-2783.5-windows-amd64.zip",
							"cmd": "./junie/junie.exe",
							"args": ["--acp=true"]
						},
						"windows-aarch64": {
							"archive": "https://github.com/JetBrains/junie-acp-release/releases/download/2783.5/junie-release-2783.5-windows-aarch64.zip",
							"cmd": "./junie/junie.exe",
							"args": ["--acp=true"]
						}
					} }
				},
				{
					"id": "kilo",
					"name": "Kilo",
					"version": "7.4.22",
					"description": "The open source coding agent",
					"repository": "https://github.com/Kilo-Org/kilocode",
					"website": "https://kilo.ai/",
					"authors": ["Kilo Code"],
					"license": "MIT",
					"icon": "./icon.svg",
					"distribution": {
						"binary": {
							"darwin-aarch64": {
								"archive": "https://github.com/Kilo-Org/kilocode/releases/download/v7.4.22/kilo-darwin-arm64.zip",
								"cmd": "./kilo",
								"args": ["acp"],
								"sha256": "32c79158e731d8662597ff38b91dd217c9bfefff55df472b7be584987822572c"
							},
							"darwin-x86_64": {
								"archive": "https://github.com/Kilo-Org/kilocode/releases/download/v7.4.22/kilo-darwin-x64.zip",
								"cmd": "./kilo",
								"args": ["acp"],
								"sha256": "06e9c266c45d00d23939ad3544971848f2133ea4c81fbe9ddbfa0560ca84e1af"
							},
							"linux-aarch64": {
								"archive": "https://github.com/Kilo-Org/kilocode/releases/download/v7.4.22/kilo-linux-arm64.tar.gz",
								"cmd": "./kilo",
								"args": ["acp"],
								"sha256": "ddac95f45c77b259c429ed81dfc2a453df88dde7e2d1a524419b53cdb150cf90"
							},
							"linux-x86_64": {
								"archive": "https://github.com/Kilo-Org/kilocode/releases/download/v7.4.22/kilo-linux-x64.tar.gz",
								"cmd": "./kilo",
								"args": ["acp"],
								"sha256": "60b775a71e60e21d10b55a6cacd79711b0fdfe8e8545decec9fcaadf8b1ebdb3"
							},
							"windows-x86_64": {
								"archive": "https://github.com/Kilo-Org/kilocode/releases/download/v7.4.22/kilo-windows-x64.zip",
								"cmd": "./kilo.exe",
								"args": ["acp"],
								"sha256": "d2b06537e2610294f207ccc0dd8413d275f0d3248be00be7d9a4f716b4dcff0a"
							}
						},
						"npx": {
							"package": "@kilocode/cli@7.4.22",
							"args": ["acp"]
						}
					}
				},
				{
					"id": "kimi",
					"name": "Kimi CLI",
					"version": "1.49.0",
					"description": "Moonshot AI's coding assistant",
					"repository": "https://github.com/MoonshotAI/kimi-cli",
					"website": "https://moonshotai.github.io/kimi-cli/",
					"authors": ["Moonshot AI"],
					"license": "MIT",
					"distribution": { "binary": {
						"darwin-aarch64": {
							"archive": "https://github.com/MoonshotAI/kimi-cli/releases/download/1.49.0/kimi-1.49.0-aarch64-apple-darwin.tar.gz",
							"cmd": "./kimi",
							"args": ["acp"],
							"sha256": "15018b20b203aee09658fdc64840c4846fc17c108d8dba1a19a95581d3ce2921"
						},
						"linux-aarch64": {
							"archive": "https://github.com/MoonshotAI/kimi-cli/releases/download/1.49.0/kimi-1.49.0-aarch64-unknown-linux-gnu.tar.gz",
							"cmd": "./kimi",
							"args": ["acp"],
							"sha256": "5ac54cabce16ede27b9d2069b9b88edee25528646e7bb5befa9980a1ca71febb"
						},
						"linux-x86_64": {
							"archive": "https://github.com/MoonshotAI/kimi-cli/releases/download/1.49.0/kimi-1.49.0-x86_64-unknown-linux-gnu.tar.gz",
							"cmd": "./kimi",
							"args": ["acp"],
							"sha256": "6ce0b83f583c45a64cc9f51ffe7e1a8e03ee79acda69945fcf8c23341b9d892f"
						},
						"windows-aarch64": {
							"archive": "https://github.com/MoonshotAI/kimi-cli/releases/download/1.49.0/kimi-1.49.0-aarch64-pc-windows-msvc.zip",
							"cmd": "./kimi.exe",
							"args": ["acp"],
							"sha256": "3ac8f05c7bd18d902a324c6c03a71084cfbe785b9669bbd556c071ee1d8f2f26"
						},
						"windows-x86_64": {
							"archive": "https://github.com/MoonshotAI/kimi-cli/releases/download/1.49.0/kimi-1.49.0-x86_64-pc-windows-msvc.zip",
							"cmd": "./kimi.exe",
							"args": ["acp"],
							"sha256": "2acbbc7ca8c8ac4b03dab1d970f53a292bd226168151b423499feab9fc203ddd"
						}
					} }
				},
				{
					"id": "minion-code",
					"name": "Minion Code",
					"version": "0.1.44",
					"description": "An enhanced AI code assistant built on the Minion framework with rich development tools",
					"repository": "https://github.com/femto/minion-code",
					"authors": ["femto"],
					"license": "AGPL-3.0",
					"distribution": { "uvx": {
						"package": "minion-code@0.1.44",
						"args": ["acp"]
					} }
				},
				{
					"id": "mistral-vibe",
					"name": "Mistral Vibe",
					"version": "2.24.1",
					"description": "Mistral's open-source coding assistant",
					"repository": "https://github.com/mistralai/mistral-vibe",
					"website": "https://mistral.ai/products/vibe",
					"authors": ["Mistral AI"],
					"license": "Apache-2.0",
					"icon": "./icon.svg",
					"distribution": { "binary": {
						"darwin-aarch64": {
							"archive": "https://github.com/mistralai/mistral-vibe/releases/download/v2.24.1/vibe-acp-darwin-aarch64-2.24.1.tar.gz",
							"cmd": "./vibe-acp",
							"sha256": "4faa3ed31454ee739fac2d5ff052c56056b175611a7b7ace0a4191f2bf83ba93"
						},
						"darwin-x86_64": {
							"archive": "https://github.com/mistralai/mistral-vibe/releases/download/v2.24.1/vibe-acp-darwin-x86_64-2.24.1.tar.gz",
							"cmd": "./vibe-acp",
							"sha256": "97d512a02e97fb828824cfb7b72734574f086d0442851c5fdfb432d7dabfa88a"
						},
						"linux-aarch64": {
							"archive": "https://github.com/mistralai/mistral-vibe/releases/download/v2.24.1/vibe-acp-linux-aarch64-2.24.1.tar.gz",
							"cmd": "./vibe-acp",
							"sha256": "e43913b43f0666df2a42060cd3bd410805b0ca1218843b0c242edf874a78c31a"
						},
						"linux-x86_64": {
							"archive": "https://github.com/mistralai/mistral-vibe/releases/download/v2.24.1/vibe-acp-linux-x86_64-2.24.1.tar.gz",
							"cmd": "./vibe-acp",
							"sha256": "8e87f581e7c292fbeab7377178e947ddc4e83753c409f1db0760631f11d7083c"
						},
						"windows-x86_64": {
							"archive": "https://github.com/mistralai/mistral-vibe/releases/download/v2.24.1/vibe-acp-windows-x86_64-2.24.1.zip",
							"cmd": "./vibe-acp.exe",
							"sha256": "a66329ff18845f8e810359910e8da15bb2071648159c13a10838e5ae7a7d9b81"
						}
					} }
				},
				{
					"id": "nova",
					"name": "Nova",
					"version": "1.1.35",
					"description": "Nova by Compass AI - a fully-fledged software engineer at your command",
					"repository": "https://github.com/Compass-Agentic-Platform/nova",
					"website": "https://www.compassap.ai/portfolio/nova.html",
					"authors": ["Compass AI"],
					"license": "proprietary",
					"icon": "./icon.svg",
					"distribution": { "npx": {
						"package": "@compass-ai/nova@1.1.35",
						"args": ["acp"]
					} }
				},
				{
					"id": "opencode",
					"name": "OpenCode",
					"version": "1.18.18",
					"description": "The open source coding agent",
					"repository": "https://github.com/anomalyco/opencode",
					"website": "https://opencode.ai",
					"authors": ["Anomaly"],
					"license": "MIT",
					"icon": "./icon.svg",
					"distribution": { "binary": {
						"darwin-aarch64": {
							"archive": "https://github.com/anomalyco/opencode/releases/download/v1.18.18/opencode-darwin-arm64.zip",
							"cmd": "./opencode",
							"args": ["acp"],
							"sha256": "7d668bf26496fec8686d4e51ebb1ac2bd2e393f0c1620aa696c4c242a9e5806a"
						},
						"darwin-x86_64": {
							"archive": "https://github.com/anomalyco/opencode/releases/download/v1.18.18/opencode-darwin-x64.zip",
							"cmd": "./opencode",
							"args": ["acp"],
							"sha256": "9581bd7683a7528456179fb11e3377d9ef568e10a935611a2c6722e349454d83"
						},
						"linux-aarch64": {
							"archive": "https://github.com/anomalyco/opencode/releases/download/v1.18.18/opencode-linux-arm64.tar.gz",
							"cmd": "./opencode",
							"args": ["acp"],
							"sha256": "dcb1b5ec5687b43f87749560021f9203f3809e0ce5ae44ff9be8ae17083fe4ba"
						},
						"linux-x86_64": {
							"archive": "https://github.com/anomalyco/opencode/releases/download/v1.18.18/opencode-linux-x64.tar.gz",
							"cmd": "./opencode",
							"args": ["acp"],
							"sha256": "0cddc222418b8553669905a8980c0cda7088f00da24d83d6ac76b01c9fdb2aaf"
						},
						"windows-aarch64": {
							"archive": "https://github.com/anomalyco/opencode/releases/download/v1.18.18/opencode-windows-arm64.zip",
							"cmd": "./opencode",
							"args": ["acp"],
							"sha256": "0d34d837ea3b5e10349d8550318083040a8b4c061d3faaa4eabd339984aa49b0"
						},
						"windows-x86_64": {
							"archive": "https://github.com/anomalyco/opencode/releases/download/v1.18.18/opencode-windows-x64.zip",
							"cmd": "./opencode.exe",
							"args": ["acp"],
							"sha256": "c6d265376fdb93164013671b0cf402410184f73c34fc15d82d40a16a745b15f4"
						}
					} }
				},
				{
					"id": "pi-acp",
					"name": "pi ACP",
					"version": "0.0.33",
					"description": "ACP adapter for pi coding agent",
					"repository": "https://github.com/svkozak/pi-acp",
					"authors": ["Sergii Kozak <svkozak@gmail.com>"],
					"license": "MIT",
					"distribution": { "npx": { "package": "pi-acp@0.0.33" } }
				},
				{
					"id": "poolside",
					"name": "Poolside",
					"version": "1.0.16",
					"description": "Poolside's coding agent",
					"repository": "https://github.com/poolsideai/pool",
					"website": "https://poolside.ai",
					"authors": ["Poolside <feedback@poolside.ai>"],
					"license": "proprietary",
					"distribution": { "binary": {
						"darwin-aarch64": {
							"archive": "https://downloads.poolside.ai/pool/v1.0.16/pool-darwin-arm64.tar.gz",
							"cmd": "./pool-darwin-arm64",
							"args": ["acp"],
							"sha256": "0932af3eb2b57a863acacb664ec8b2b1d3a76c2570a788b086001608cc585f74"
						},
						"darwin-x86_64": {
							"archive": "https://downloads.poolside.ai/pool/v1.0.16/pool-darwin-amd64.tar.gz",
							"cmd": "./pool-darwin-amd64",
							"args": ["acp"],
							"sha256": "6d75fae2d7de6c35b6b467b5f682935e3ecde8ff611cb620c56b7bd607e0afde"
						},
						"linux-aarch64": {
							"archive": "https://downloads.poolside.ai/pool/v1.0.16/pool-linux-arm64.tar.gz",
							"cmd": "./pool-linux-arm64",
							"args": ["acp"],
							"sha256": "466343b66b03ee4e66476fcc69be1eb5bf8e9155a4ab73e0e72a232d1f8d2a12"
						},
						"linux-x86_64": {
							"archive": "https://downloads.poolside.ai/pool/v1.0.16/pool-linux-amd64.tar.gz",
							"cmd": "./pool-linux-amd64",
							"args": ["acp"],
							"sha256": "e86aa8c9feef003540673ab494e91bfadc273218d531c43d662cafb69e464146"
						},
						"windows-aarch64": {
							"archive": "https://downloads.poolside.ai/pool/v1.0.16/pool-windows-arm64.tar.gz",
							"cmd": "./pool-windows-arm64.exe",
							"args": ["acp"],
							"sha256": "8dc7d014ced3e9d3ced240bbc7dabaf696bf59f118bd271d9f4e8561e415d75b"
						},
						"windows-x86_64": {
							"archive": "https://downloads.poolside.ai/pool/v1.0.16/pool-windows-amd64.tar.gz",
							"cmd": "./pool-windows-amd64.exe",
							"args": ["acp"],
							"sha256": "3e324f1a4b5855ba5363232c06461ec9d6d2ae1a341c827221e79779f8f2bc6f"
						}
					} }
				},
				{
					"id": "qoder",
					"name": "Qoder CLI",
					"version": "0.2.14",
					"description": "AI coding assistant with agentic capabilities",
					"website": "https://qoder.com",
					"authors": ["Qoder AI"],
					"license": "proprietary",
					"icon": "./icon.svg",
					"distribution": { "npx": {
						"package": "@qoder-ai/qodercli@0.2.14",
						"args": ["--acp"]
					} }
				},
				{
					"id": "qwen-code",
					"name": "Qwen Code",
					"version": "0.21.13",
					"description": "Alibaba's Qwen coding assistant",
					"repository": "https://github.com/QwenLM/qwen-code",
					"website": "https://qwenlm.github.io/qwen-code-docs/en/users/overview",
					"authors": ["Alibaba Qwen Team"],
					"license": "Apache-2.0",
					"distribution": { "npx": {
						"package": "@qwen-code/qwen-code@0.21.13",
						"args": ["--acp", "--experimental-skills"]
					} }
				},
				{
					"id": "sigit",
					"name": "siGit Code",
					"version": "1.5.2",
					"description": "Local-first coding agent. Runs entirely on your machine with optional on-device LLM inference via Onde.",
					"repository": "https://github.com/getsigit/sigit",
					"website": "https://github.com/getsigit/sigit",
					"authors": ["smbCloud"],
					"license": "Apache-2.0",
					"distribution": {
						"binary": {
							"darwin-aarch64": {
								"archive": "https://github.com/getsigit/sigit/releases/download/v1.5.2/sigit-macos-arm64.tar.gz",
								"cmd": "./sigit",
								"sha256": "be17cca0bb7341ac43d0ec3769a75aa5ca4a91c6e3c24512a524f3318eccad08"
							},
							"darwin-x86_64": {
								"archive": "https://github.com/getsigit/sigit/releases/download/v1.5.2/sigit-macos-amd64.tar.gz",
								"cmd": "./sigit",
								"sha256": "dc24791071831e1b6c5b84b09868bb3af62baae71db565d31176becab82744bc"
							},
							"linux-aarch64": {
								"archive": "https://github.com/getsigit/sigit/releases/download/v1.5.2/sigit-linux-arm64",
								"cmd": "./sigit-linux-arm64",
								"sha256": "374bf986b88b4736f4b1f7b16948f157002f7737a29a70140ee7036cd4735206"
							},
							"linux-x86_64": {
								"archive": "https://github.com/getsigit/sigit/releases/download/v1.5.2/sigit-linux-amd64",
								"cmd": "./sigit-linux-amd64",
								"sha256": "70bedf5d9459a86c9beea393a81a7a981c0fa07474b5ad0876ee62f6369d0d15"
							},
							"windows-aarch64": {
								"archive": "https://github.com/getsigit/sigit/releases/download/v1.5.2/sigit-win-arm64.exe",
								"cmd": "./sigit-win-arm64.exe",
								"sha256": "8982d36e86976eacec564989f13844ac0005263f3a5651ea7394a2c013d4b610"
							},
							"windows-x86_64": {
								"archive": "https://github.com/getsigit/sigit/releases/download/v1.5.2/sigit-win-amd64.exe",
								"cmd": "./sigit-win-amd64.exe",
								"sha256": "6d1a1f11f7d1e32a5995f9ea413e626f2e47dcc56fb000e30bf60cebb68e4f24"
							}
						},
						"npx": { "package": "@smbcloud/sigit@1.5.2" }
					}
				},
				{
					"id": "stakpak",
					"name": "Stakpak",
					"version": "0.3.88",
					"description": "Open-source DevOps agent in Rust with enterprise-grade security",
					"repository": "https://github.com/stakpak/agent",
					"website": "https://stakpak.dev",
					"authors": ["Stakpak Team <contact@stakpak.dev>"],
					"license": "Apache-2.0",
					"icon": "./icon.svg",
					"distribution": { "binary": {
						"darwin-aarch64": {
							"archive": "https://github.com/stakpak/agent/releases/download/v0.3.88/stakpak-darwin-aarch64.tar.gz",
							"cmd": "./stakpak",
							"args": ["acp"]
						},
						"darwin-x86_64": {
							"archive": "https://github.com/stakpak/agent/releases/download/v0.3.88/stakpak-darwin-x86_64.tar.gz",
							"cmd": "./stakpak",
							"args": ["acp"]
						},
						"linux-aarch64": {
							"archive": "https://github.com/stakpak/agent/releases/download/v0.3.88/stakpak-linux-aarch64.tar.gz",
							"cmd": "./stakpak",
							"args": ["acp"]
						},
						"linux-x86_64": {
							"archive": "https://github.com/stakpak/agent/releases/download/v0.3.88/stakpak-linux-x86_64.tar.gz",
							"cmd": "./stakpak",
							"args": ["acp"]
						},
						"windows-x86_64": {
							"archive": "https://github.com/stakpak/agent/releases/download/v0.3.88/stakpak-windows-x86_64.zip",
							"cmd": "./stakpak.exe",
							"args": ["acp"]
						}
					} }
				},
				{
					"id": "vtcode",
					"name": "VT Code",
					"version": "0.96.14",
					"description": "An open-source coding agent with LLM-native code understanding and robust shell safety. Supports multiple LLM providers with automatic failover and efficient context management.",
					"repository": "https://github.com/vinhnx/VTCode",
					"website": "https://github.com/vinhnx/VTCode/blob/main/docs/guides/zed-acp.md",
					"authors": ["vinhnx"],
					"license": "MIT",
					"distribution": { "binary": {
						"darwin-aarch64": {
							"archive": "https://github.com/vinhnx/VTCode/releases/download/0.96.14/vtcode-0.96.14-aarch64-apple-darwin.tar.gz",
							"cmd": "./vtcode",
							"args": ["acp"],
							"env": {
								"VT_ACP_ENABLED": "1",
								"VT_ACP_ZED_ENABLED": "1"
							}
						},
						"darwin-x86_64": {
							"archive": "https://github.com/vinhnx/VTCode/releases/download/0.96.14/vtcode-0.96.14-x86_64-apple-darwin.tar.gz",
							"cmd": "./vtcode",
							"args": ["acp"],
							"env": {
								"VT_ACP_ENABLED": "1",
								"VT_ACP_ZED_ENABLED": "1"
							}
						},
						"linux-x86_64": {
							"archive": "https://github.com/vinhnx/VTCode/releases/download/0.96.14/vtcode-0.96.14-x86_64-unknown-linux-gnu.tar.gz",
							"cmd": "./vtcode",
							"args": ["acp"],
							"env": {
								"VT_ACP_ENABLED": "1",
								"VT_ACP_ZED_ENABLED": "1"
							}
						},
						"windows-x86_64": {
							"archive": "https://github.com/vinhnx/VTCode/releases/download/0.96.14/vtcode-0.96.14-x86_64-pc-windows-msvc.zip",
							"cmd": "vtcode.exe",
							"args": ["acp"],
							"env": {
								"VT_ACP_ENABLED": "1",
								"VT_ACP_ZED_ENABLED": "1"
							}
						}
					} }
				}
			]
		};
		//#endregion
		//#region src/client/index.ts
		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.acp";
		/** Settings namespace owned by the host-side llm-acp plugin. */
		const LLM_ACP_NS = "llm-acp";
		/** Required services (cordis fiber inject). */
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.settings",
			"remote.llm"
		];
		/**
		* Register the ACP Servers section once the `settings.section` declaration is
		* on the ledger.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-settings-acp: copy dictionaries");
			const t = ctx.locale.bind(NS);
			const remote = ctx.remote;
			const injected = () => ({
				registry: registry_default,
				api: {
					describeSettings: () => remote.settings.describe(),
					mutateSettings: (ns, ops, expectedRevision) => remote.settings.mutate(ns, ops, expectedRevision),
					discoverModels: (settingsNs, provider) => remote.llm.discoverModels(settingsNs, { provider })
				},
				settingsNs: LLM_ACP_NS
			});
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "acp-servers",
				order: 15,
				label: () => t("nav"),
				locale: NS,
				inject: injected
			}, AcpSettingsSection));
			const footerApi = {
				describeSettings: () => remote.settings.describe(),
				mutateSettings: (ns, ops, expectedRevision) => remote.settings.mutate(ns, ops, expectedRevision),
				discoverModels: (settingsNs, provider) => remote.llm.discoverModels(settingsNs, { provider })
			};
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "acp-status",
				order: 50,
				locale: NS,
				inject: () => ({
					api: footerApi,
					settingsNs: LLM_ACP_NS
				})
			}, AcpStatusBar));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map