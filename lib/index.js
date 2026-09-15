import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { accessSync, constants, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
//#region lib/types/types.js
/**
* Type-only module for `@deepseek-ai/dsh-llm-acp`.
* @module @deepseek-ai/dsh-llm-acp/types
*/
/**
* Map an ACP {@link StopReason} to a harness {@link FinishReason}.
*
* ACP `end_turn` maps to `stop` (clean completion with no further tool work).
* `max_tokens` maps to the harness length cap. `refusal` is surfaced as a
* refusal finish. `cancelled` becomes `aborted`. `max_turn_requests` and any
* unknown future variant map to `error`, so an unclean stop is never reported
* as success.
* @param reason - the terminal reason from the child's `session/prompt` response.
* @param failure - the failure payload for error/aborted finishes.
* @returns the harness finish reason.
*/
function acpFinishReason(reason, failure) {
	switch (reason) {
		case "end_turn": return { kind: "stop" };
		case "max_tokens": return { kind: "max-tokens" };
		case "refusal": return {
			kind: "error",
			failure: {
				...failure,
				code: "REFUSAL",
				message: `${failure.message} (the ACP server refused the request — check that the model id is valid and the server is authenticated)`
			}
		};
		case "cancelled": return {
			kind: "aborted",
			failure
		};
		case "max_turn_requests": return {
			kind: "error",
			failure: {
				...failure,
				code: "MAX_TURN_REQUESTS"
			}
		};
		default: return {
			kind: "error",
			failure: {
				...failure,
				code: "UNKNOWN_STOP_REASON"
			}
		};
	}
}
//#endregion
//#region lib/types/adapter.js
/**
* `AcpAdapter`: an {@link LlmAdapter} that delegates each model call to a
* long-lived external ACP server. When the agent advertises `session/load`,
* subsequent turns within the same dsh session reuse the ACP session and send
* only the new user message — avoiding full-history resend. Without
* `loadSession`, each `stream()` call creates a fresh ACP session, sends the
* full conversation as a single user message, and closes it after.
*
* `agent_message_chunk` / `agent_thought_chunk` updates are translated into
* harness `StreamChunk`s; `usage_update` becomes a `usage` chunk carrying the
* server's context occupancy on the prompt side. Tool-call deltas are never
* emitted: the ACP server executes its own tools internally.
*
* @module @deepseek-ai/dsh-llm-acp/adapter
*/
/** Extract the concatenated text of a harness message (non-text blocks contribute nothing). */
function messageText(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
/** Render the full conversation (system + all messages) into one ACP text block. */
function renderPrompt(options) {
	const parts = [];
	if (options.system !== void 0 && options.system.length > 0) parts.push(`[system]\n${options.system}`);
	for (const message of options.messages) {
		const role = message.role === "assistant" ? "assistant" : "user";
		const text = messageText(message);
		if (text.length > 0) parts.push(`[${role}]\n${text}`);
	}
	return [{
		type: "text",
		text: parts.join("\n\n")
	}];
}
/**
* Render only new user messages since `fromIndex` as one ACP text block.
* Assistant messages are skipped: the ACP server already has its own responses
* in context. Used for session-reuse prompts where only the delta is sent.
* ponytail: ceiling — assumes messages[fromIndex:] contains at most one new
* user turn; multiple unsent user turns would be concatenated into one prompt.
*/
function renderPromptDelta(messages, fromIndex) {
	const parts = [];
	for (const message of messages.slice(fromIndex)) {
		if (message.role === "assistant") continue;
		const text = messageText(message);
		if (text.length > 0) parts.push(`[user]\n${text}`);
	}
	if (parts.length === 0) return [{
		type: "text",
		text: ""
	}];
	return [{
		type: "text",
		text: parts.join("\n\n")
	}];
}
/** Deduplicate model entries by id, keeping the first occurrence (highest priority). */
function dedupModels(models) {
	const seen = /* @__PURE__ */ new Set();
	const result = [];
	for (const m of models) {
		if (seen.has(m.id)) continue;
		seen.add(m.id);
		result.push(m);
	}
	return result;
}
/** Merge custom models into a discovered catalog: custom entries override
* matching ids' display names and append unique ids. */
function mergeCustomModels(discovered, custom, provider) {
	const customMap = /* @__PURE__ */ new Map();
	for (const m of custom) customMap.set(m.id, m.name.length > 0 ? m.name : m.id);
	const result = discovered.map((m) => {
		const customName = customMap.get(m.id);
		return customName !== void 0 ? {
			...m,
			name: customName
		} : m;
	});
	for (const [id, name] of customMap) if (!discovered.some((m) => m.id === id)) result.push({
		provider,
		id,
		name
	});
	return result;
}
/**
* The ACP-backed LLM adapter. One instance serves every model name under its
* registered provider route. The model catalog is discovered once from the
* ACP server's `session/new` config options at construction time; when a
* specific model is selected, `stream()` sets it on the ACP session before
* prompting.
*/
var AcpAdapter = class extends LlmAdapter {
	config;
	/** Discovered model catalog; populated after {@link modelsReady} resolves. */
	models = [];
	/** Resolves when the model discovery probe finishes (success or fallback). */
	modelsReady;
	/** Reused ACP sessions keyed by dsh session id (only when `loadSession` is supported). */
	sessionMap = /* @__PURE__ */ new Map();
	/** Last session-mode value applied per ACP session id, to skip redundant writes. */
	appliedMode = /* @__PURE__ */ new Map();
	constructor(config) {
		super();
		this.config = config;
		const fallback = [{
			provider: config.provider,
			id: config.defaultModel.id,
			name: config.defaultModel.name
		}];
		const allow = config.enabledModels;
		let initial = [...(config.customModels ?? []).map((m) => ({
			provider: config.provider,
			id: m.id,
			name: m.name.length > 0 ? m.name : m.id
		}))];
		if (!(allow !== void 0 && allow.length > 0 && !allow.includes(config.defaultModel.id))) initial = [...initial, ...fallback];
		this.models = dedupModels(initial);
		this.modelsReady = this.discoverModels();
	}
	/** Probe the ACP server for its model catalog and cache the result. */
	async discoverModels() {
		try {
			const discovered = await this.config.connection.discoverModels();
			if (discovered !== void 0 && discovered.length > 0) {
				const all = discovered.map((m) => ({
					provider: this.config.provider,
					id: m.id,
					name: m.name
				}));
				const allow = this.config.enabledModels;
				const filtered = allow !== void 0 && allow.length > 0 ? all.filter((m) => allow.includes(m.id)) : all;
				this.models = mergeCustomModels(filtered, this.config.customModels ?? [], this.config.provider);
			}
		} catch {}
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: provider
		};
	}
	/**
	* Advertise the model catalog discovered from the ACP server's session config
	* options. Falls back to a single placeholder entry when the server publishes
	* no model config option.
	*/
	async listModels(provider) {
		await this.modelsReady;
		return this.models.map((m) => ({
			...m,
			provider
		}));
	}
	async resolveModel(provider, model) {
		await this.modelsReady;
		const found = this.models.find((m) => m.id === model);
		const contextWindow = this.config.connection.getContextWindow();
		return {
			provider,
			id: model,
			name: found?.name ?? model,
			...contextWindow === void 0 ? {} : { context: { contextWindow } }
		};
	}
	async prepareCall(provider, model, _signal) {
		return {
			model: await this.resolveModel(provider, model),
			stream: (options) => this.stream(options)
		};
	}
	/**
	* Stream one model call. When the ACP agent supports `session/load` and the
	* request carries a dsh `sessionId`, the ACP session is reused across turns:
	* only new user messages are sent, avoiding full-history resend. Without
	* `loadSession` or for one-shot calls, a fresh ACP session is created with
	* the full conversation and closed after the prompt.
	*
	* Yields `text-delta` (and optionally `reasoning-delta`) chunks as the ACP
	* server streams assistant output, a `usage` chunk whenever the server
	* reports context occupancy, then a terminal `finish` chunk.
	*/
	async *stream(options) {
		const permissionRequester = this.config.permissionRequester?.();
		try {
			await this.config.connection.ready;
		} catch (error) {
			yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: {
						code: "ACP_INIT_FAILED",
						message: `llm-acp: ACP server failed to initialize: ${error instanceof Error ? error.message : String(error)}`
					}
				}
			};
			return;
		}
		const canReuse = this.config.connection.supportsLoadSession && options.sessionId !== void 0 && options.purpose === void 0;
		const dshSessionId = canReuse ? String(options.sessionId) : void 0;
		const existing = dshSessionId !== void 0 ? this.sessionMap.get(dshSessionId) : void 0;
		let sessionId;
		let prompt;
		let isReused = false;
		if (existing !== void 0 && options.messages.length >= existing.messagesSent) try {
			await this.config.connection.loadSession(existing.acpSessionId);
			sessionId = existing.acpSessionId;
			prompt = renderPromptDelta(options.messages, existing.messagesSent);
			isReused = true;
		} catch {
			this.sessionMap.delete(dshSessionId);
			sessionId = await this.createSession(options);
			prompt = renderPrompt(options);
		}
		else {
			if (existing !== void 0 && dshSessionId !== void 0) this.sessionMap.delete(dshSessionId);
			sessionId = await this.createSession(options);
			prompt = renderPrompt(options);
		}
		if (options.model.length > 0 && options.model !== this.config.defaultModel.id) try {
			await this.config.connection.setSessionModel(sessionId, options.model);
		} catch {}
		const targetMode = this.config.resolveSessionMode?.();
		if (targetMode !== void 0 && this.appliedMode.get(sessionId) !== targetMode) try {
			await this.config.connection.setSessionMode(sessionId, targetMode);
			this.appliedMode.set(sessionId, targetMode);
		} catch (error) {
			this.appliedMode.set(sessionId, targetMode);
			this.config.onWarn?.(`llm-acp: failed to set ACP session mode "${targetMode}": ${error instanceof Error ? error.message : String(error)}`);
		}
		const emitReasoning = this.config.emitReasoning;
		const reportUsage = options.purpose === void 0;
		let nextIndex = 0;
		let open;
		const signal = options.signal ?? new AbortController().signal;
		const closeOpen = function* () {
			if (open === void 0) return;
			yield {
				type: "block-end",
				index: open.index,
				block: open.type === "text" ? {
					type: "text",
					text: open.text
				} : {
					type: "reasoning",
					text: open.text
				}
			};
			open = void 0;
		};
		try {
			for await (const update of this.config.connection.promptStream(sessionId, prompt, signal, permissionRequester)) switch (update.kind) {
				case "text":
					if (update.text.length === 0) break;
					if (open === void 0 || open.type !== "text") {
						yield* closeOpen();
						open = {
							type: "text",
							index: nextIndex++,
							text: ""
						};
						yield {
							type: "block-start",
							index: open.index,
							blockType: "text"
						};
					}
					open.text += update.text;
					yield {
						type: "text-delta",
						index: open.index,
						text: update.text
					};
					break;
				case "reasoning":
					if (!emitReasoning || update.text.length === 0) break;
					if (open === void 0 || open.type !== "reasoning") {
						yield* closeOpen();
						open = {
							type: "reasoning",
							index: nextIndex++,
							text: ""
						};
						yield {
							type: "block-start",
							index: open.index,
							blockType: "reasoning"
						};
					}
					open.text += update.text;
					yield {
						type: "reasoning-delta",
						index: open.index,
						text: update.text
					};
					break;
				case "progress":
					if (this.config.emitProgress !== true || update.text.length === 0) break;
					if (open === void 0 || open.type !== "reasoning") {
						yield* closeOpen();
						open = {
							type: "reasoning",
							index: nextIndex++,
							text: ""
						};
						yield {
							type: "block-start",
							index: open.index,
							blockType: "reasoning"
						};
					}
					open.text += update.text + "\n";
					yield {
						type: "reasoning-delta",
						index: open.index,
						text: update.text + "\n"
					};
					break;
				case "usage":
					if (reportUsage) yield {
						type: "usage",
						usage: {
							inputTokens: update.used,
							outputTokens: 0
						}
					};
					break;
				case "done":
					yield* closeOpen();
					if (canReuse) this.sessionMap.set(dshSessionId, {
						acpSessionId: sessionId,
						messagesSent: options.messages.length
					});
					yield {
						type: "finish",
						reason: acpFinishReason(update.reason, {
							code: "ACP_STOP",
							message: `ACP stop reason: ${update.reason}`
						})
					};
					return;
				case "error":
					yield* closeOpen();
					if (isReused && dshSessionId !== void 0) this.sessionMap.delete(dshSessionId);
					yield {
						type: "finish",
						reason: {
							kind: "error",
							failure: {
								code: "ACP_ERROR",
								message: update.error.message
							}
						}
					};
					return;
			}
		} catch (error) {
			yield* closeOpen();
			if (isReused && dshSessionId !== void 0) this.sessionMap.delete(dshSessionId);
			throw new LlmError(`llm-acp: stream failed: ${error instanceof Error ? error.message : String(error)}`, "SERVER");
		} finally {
			if (!isReused && !canReuse) this.config.connection.closeSession(sessionId);
		}
		yield* closeOpen();
		if (isReused && dshSessionId !== void 0) this.sessionMap.delete(dshSessionId);
		yield {
			type: "finish",
			reason: {
				kind: "error",
				failure: {
					code: "ACP_EOF",
					message: "ACP stream ended without a stop reason"
				}
			}
		};
	}
	/** Create a fresh ACP session, throwing `LlmError` on failure. */
	async createSession(_options) {
		try {
			return await this.config.connection.newSession();
		} catch (error) {
			throw new LlmError(`llm-acp: failed to create ACP session: ${error instanceof Error ? error.message : String(error)}`, "NO_ADAPTER");
		}
	}
	/** Close all reused ACP sessions. Called when the adapter's connection is disposed. */
	disposeSessions() {
		for (const { acpSessionId } of this.sessionMap.values()) this.config.connection.closeSession(acpSessionId);
		this.sessionMap.clear();
	}
};
//#endregion
//#region lib/types/connection.js
/**
* Long-lived ACP client connection: spawns one external ACP server subprocess
* at plugin load and drives it over JSON-RPC stdio. Each {@link AcpConnection.promptStream}
* call targets one ACP session, sends one user message, and yields the
* streamed assistant text/reasoning chunks plus a terminal stop reason.
*
* Authentication is lazy: `authenticate` runs eagerly only when a configured
* API key resolves, and otherwise only after a `session/new`/`session/load`
* failure — servers that accept env credentials or a cached login never see
* an `authenticate` call, so a healthy server never triggers a browser login
* it did not need. When a server advertises several auth methods, the round
* waits for the operator's `authMethod` selection instead of guessing:
* methods differ in reachability (codebuddy's intranet-only `iOA` versus its
* public `external`), so a guess can hang for the whole interactive window.
* Every handshake and session operation is bounded by its configured timeout
* so a wedged server fails fast instead of hanging the harness.
*
* @module @deepseek-ai/dsh-llm-acp/connection
*/
/** EOF grace for child flush and nested-process teardown; wider than the signal grace. */
const DEFAULT_DISPOSE_EOF_GRACE_MS = 6e3;
/**
* Grace after `session/cancel` for the server to settle a hanging prompt.
* A non-cooperative server may never answer the cancel; the pending drain
* is force-settled as `cancelled` once this elapses so consumers are not
* stuck on a dead prompt.
*/
const CANCEL_SETTLE_GRACE_MS = 5e3;
/**
* Grace after an `idle` agent phase while a prompt response is still pending.
* Some servers (observed: codebuddy) transition to `idle` on an internal model
* failure without ever answering `session/prompt`; once this elapses the
* pending drain is force-settled as an error so consumers are not stuck on a
* dead prompt.
*/
const IDLE_SETTLE_GRACE_MS = 1e4;
/** Resolve after `ms` milliseconds. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Reject `operation` with a labelled error when it does not settle within `ms`. */
function withTimeout(operation, ms, label) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(/* @__PURE__ */ new Error(`llm-acp: ${label} timed out after ${ms}ms`)), ms);
		operation.then((value) => {
			clearTimeout(timer);
			resolve(value);
		}, (error) => {
			clearTimeout(timer);
			reject(error instanceof Error ? error : new Error(String(error)));
		});
	});
}
/**
* Resolve which advertised auth method a round should use.
*
* A server that advertises exactly one method has no choice to offer, so that
* method is used silently. Several methods are only ever run when the operator
* picked one: guessing would silently select an unusable flow (codebuddy
* advertises an intranet-only `iOA` first, which on an off-network host hangs
* until the round times out), so an unpicked or unknown selection resolves to
* `undefined` and the caller defers to the user instead.
* @param methods - methods advertised in the `initialize` response.
* @param configured - the operator's `authMethod` selection, `''` when unset.
* @returns the method to authenticate with, plus how it was resolved.
*/
function resolveAuthMethod(methods, configured) {
	const picked = configured.length > 0 ? methods.find((m) => m.id === configured) : void 0;
	if (picked !== void 0) return {
		method: picked,
		matched: "configured"
	};
	if (methods.length === 1) return {
		method: methods[0],
		matched: "only"
	};
	return {
		method: void 0,
		matched: "unresolved"
	};
}
/** Default POSIX grace between SIGTERM and SIGKILL on dispose. */
const DEFAULT_DISPOSE_GRACE_MS = 3e3;
/** Default bound on the `initialize` handshake plus any keyed `authenticate` round. */
const DEFAULT_INIT_TIMEOUT_MS = 12e4;
/** Default bound on `session/new`, `session/load`, and `session/set_config_option`. */
const DEFAULT_SESSION_TIMEOUT_MS = 6e4;
/** Default bound on one `authenticate` round, keyed or key-less. */
const DEFAULT_AUTH_TIMEOUT_MS = 15e3;
/** Default bound on one key-less interactive `authenticate` round: generous
* enough for the user to finish a browser login before the failed session
* call retries. */
const DEFAULT_INTERACTIVE_AUTH_TIMEOUT_MS = 3e5;
/** Maximum protocol trace entries retained (ring buffer). */
const MAX_PROTOCOL_TRACE = 100;
/** Cap on one trace entry's serialized detail payload. */
const MAX_TRACE_DETAIL = 8192;
/** Bounded whole-tree exit wait: polls the handle's tree liveness until it exits or `ms` elapses. */
async function treeExitsWithin(child, ms) {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, ms);
	try {
		return await child.waitForExit(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}
/**
* Cooperative teardown ladder over the subprocess seam's public verbs: stdin
* EOF (the child's window to flush and reap descendants), then the
* `terminate()` escalation (SIGTERM → grace → SIGKILL) and its whole-tree exit
* proof. Resolves only at whole-tree quiescence.
* @param child - the spawned ACP child's handle.
* @param eofGraceMs - tier-1 window after stdin EOF.
*/
async function disposeAcpChild(child, eofGraceMs) {
	if (child.pid <= 0) {
		await child.done.catch(() => {});
		return;
	}
	child.stdin?.end();
	if (await treeExitsWithin(child, eofGraceMs)) return;
	child.terminate();
	await child.waitForExit();
}
/** Whether an RPC failure is the ACP `authRequired` error (code -32000) — the
* only failure that earns a lazy authenticate round. Timeout/transport errors
* are not auth failures even though they share the same catch site. */
function isAuthRequiredError(error) {
	if (!(error instanceof Error)) return false;
	if (Reflect.get(error, "code") === -32e3 || /^authentication required/i.test(error.message)) return true;
	const data = Reflect.get(error, "data");
	const details = data === null || typeof data !== "object" ? void 0 : Reflect.get(data, "details");
	return typeof details === "string" && /^authentication required/i.test(details);
}
/** Whether an RPC failure came from a `withTimeout` deadline (message shape is `llm-acp: <label> timed out after Nms`). */
function isTimeoutError(error) {
	return error instanceof Error && /timed out after \d+ms$/.test(error.message);
}
/** Extract text from an ACP content block (non-text blocks contribute nothing). */
/**
* Read an agent-phase extension marker (e.g. `_meta["codebuddy.ai/agentPhase"].phase`)
* from a session update. Returns the phase string (`model_streaming`, `idle`, …)
* or `undefined` when the update carries none.
*/
function acpAgentPhase(update) {
	const meta = Reflect.get(update, "_meta");
	if (meta === null || typeof meta !== "object") return void 0;
	for (const [key, value] of Object.entries(meta)) {
		if (!key.endsWith("agentPhase")) continue;
		if (value === null || typeof value !== "object") continue;
		const phase = Reflect.get(value, "phase");
		if (typeof phase === "string") return phase;
	}
}
function acpContentText(content) {
	return content.type === "text" ? content.text : "";
}
/**
* Accept a wire-reported token count only when it is a finite non-negative
* integer. `usage_update` numbers come from an external process and feed
* harness projections whose schemas demand exactly that shape, so a fractional
* or negative value is dropped at this boundary instead of corrupting a fold.
*/
function acpTokenCount(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : void 0;
}
/** Truncate a string to a display-friendly length for permission prompts. */
function truncate(s, max = 120) {
	return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
/** Best-effort stringification of a non-string `rawInput` value. */
function tryStringify(value) {
	try {
		return typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		return String(value);
	}
}
/** Build a human-readable description of the tool call needing permission.
* Prefers the server-provided `title`; when absent, derives one from
* `kind`, `locations` (file paths), and `rawInput` so the user sees what
* they are approving instead of a generic "ACP operation".
* When all tool-call fields are empty (some agents send only a
* `toolCallId`), the subject is extracted from the permission `options`
* labels — which often embed it in backticks ("Yes, allow `git` commands
* (this session)") — since the full label list is forwarded separately as
* `optionLabels` for the prompt body. */
function describePermissionToolCall(toolCall, options) {
	const title = typeof toolCall.title === "string" && toolCall.title.length > 0 ? toolCall.title : "";
	if (title.length > 0) return title;
	const kind = toolCall.kind ?? "";
	const paths = (toolCall.locations ?? []).map((loc) => loc.path).filter((p) => typeof p === "string" && p.length > 0);
	const rawInput = toolCall.rawInput;
	const inputSummary = typeof rawInput === "string" && rawInput.length > 0 ? rawInput : rawInput !== void 0 && rawInput !== null ? tryStringify(rawInput) : "";
	if (kind.length > 0 && paths.length > 0) return `${kind}: ${paths.join(", ")}`;
	if (kind.length > 0 && inputSummary.length > 0) return `${kind}: ${truncate(inputSummary)}`;
	if (kind.length > 0) return kind;
	if (paths.length > 0) return paths.join(", ");
	if (inputSummary.length > 0) return truncate(inputSummary);
	if (options !== void 0 && options.length > 0) {
		for (const option of options) {
			const name = option.name;
			if (typeof name !== "string" || name.length === 0) continue;
			const subject = /`([^`]+)`/.exec(name)?.[1] ?? name.replace(/^yes,?\s*(?:always\s+)?allow\s+/i, "").replace(/\s*\((?:this session|in all projects)\)\s*$/i, "").trim();
			if (subject.length > 0 && !/^(?:allow|reject)$/i.test(subject)) return `permission: ${truncate(subject)}`;
		}
		return "permission request";
	}
	const dump = tryStringify(toolCall);
	return dump.length > 0 ? truncate(dump, 200) : "ACP operation";
}
/**
* One long-lived ACP client connection backed by a single child server
* process. The connection is ready after {@link AcpConnection.ready}
* resolves; dispose runs the full teardown ladder.
*/
var AcpConnection = class {
	child;
	conn;
	spec;
	queues = /* @__PURE__ */ new Map();
	readyPromise;
	disposed = false;
	disposal;
	/** Capabilities advertised by the agent in its `initialize` response. */
	agentCapabilities;
	/** Session lifecycle capabilities advertised by the agent. */
	sessionCapabilities;
	/** Agent name/version published in the `initialize` response (`agentInfo`). */
	agentInfo;
	/** Negotiated ACP protocol version from the `initialize` response. */
	protocolVersion;
	/** Auth methods advertised in the `initialize` response. */
	authMethods;
	/**
	* The connection's single `authenticate` round — the eager keyed attempt
	* during `initialize`, or the lazy key-less attempt started on the first
	* `session/new`/`session/load` failure. Set at most once; a second round
	* cannot succeed where the first did not.
	*/
	authRound;
	/**
	* Browser login URL published via the `_codebuddy.ai/authUrl` extension
	* notification while an interactive `authenticate` round is in flight.
	* Captured so a key-less auth timeout can tell the user where to log in.
	*/
	pendingAuthUrl;
	/** Set once {@link onAuthUrl} has fired — one browser open per connection. */
	authUrlNotified = false;
	/** Auth method id of the in-flight key-less round, if any. */
	interactiveAuthMethodId;
	/**
	* Set once an authentication attempt has been **blocked** because the server
	* advertises several methods and none is selected. Latched only by an actual
	* blocked attempt, never merely by the shape of the method list: a server
	* whose cached login still works must not ask the user to choose.
	*/
	authChoiceBlocked = false;
	/**
	* Fingerprint of the last "choose an auth method" warning, so a repeated
	* blocked attempt does not repeat the same line on every turn. Cleared when
	* the condition changes (a different selection, or a different method list).
	*/
	authChoiceWarnedKey;
	cachedConfigOptions;
	configOptionsProbe;
	/**
	* Total context window in tokens as reported by the newest `usage_update`
	* sample, across every session on this connection. The capacity belongs to
	* the model behind the server rather than to one session, so it survives the
	* session that published it (including the throwaway discovery probe
	* session) and is exposed to the adapter as this route's model context.
	*/
	reportedContextWindow;
	/** Ring buffer of recent ACP protocol interactions (max {@link MAX_PROTOCOL_TRACE}). */
	protocolTrace = [];
	constructor(spec) {
		this.spec = spec;
		this.child = spec.spawn({
			argv: [spec.command, ...spec.args],
			cwd: spec.cwd,
			stdio: {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "inherit"
			},
			graceMs: spec.disposeGraceMs,
			env: spec.env
		});
		if (this.child.stdin === void 0 || this.child.stdout === void 0) throw new Error("llm-acp: subprocess implementation dropped a piped protocol stream");
		const makeClient = (_agent) => ({
			sessionUpdate: (params) => {
				this.enqueueUpdate(params);
				return Promise.resolve();
			},
			requestPermission: (params) => {
				return this.requestPermission(params);
			},
			extNotification: (method, params) => {
				this.handleExtNotification(method, params);
				return Promise.resolve();
			},
			extMethod: (method, params) => {
				return this.handleExtMethod(method, params);
			}
		});
		this.conn = new ClientSideConnection(makeClient, ndJsonStream(Writable.toWeb(this.child.stdin), Readable.toWeb(this.child.stdout)));
		this.readyPromise = withTimeout(this.initialize(), spec.initTimeoutMs, `initialize of "${spec.command}"`);
	}
	/** Resolves when the ACP server has completed `initialize`. */
	get ready() {
		return this.readyPromise;
	}
	async initialize() {
		const spawnFailed = this.child.done.then(() => new Promise(() => {}), (err) => Promise.reject(err instanceof Error ? err : new Error(String(err))));
		spawnFailed.catch(() => {});
		let initResult;
		try {
			this.traceEvent("send", "initialize", `protocolVersion=${PROTOCOL_VERSION}`, void 0, {
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: {}
			});
			initResult = await Promise.race([this.conn.initialize({
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: {}
			}), spawnFailed]);
		} catch (error) {
			throw new Error(`ACP server "${this.spec.command}" failed to initialize: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.agentCapabilities = initResult.agentCapabilities;
		this.sessionCapabilities = initResult.agentCapabilities?.sessionCapabilities;
		this.agentInfo = initResult.agentInfo ?? void 0;
		this.protocolVersion = initResult.protocolVersion;
		this.authMethods = initResult.authMethods ?? void 0;
		this.traceEvent("recv", "initialize", `protocol=${initResult.protocolVersion} agent=${initResult.agentInfo?.name ?? "?"} v${initResult.agentInfo?.version ?? "?"} authMethods=${initResult.authMethods?.length ?? 0}`, void 0, initResult);
		try {
			await this.authenticateWithKey();
		} catch (error) {
			throw new Error(`ACP server "${this.spec.command}" failed to authenticate: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/** Whether the agent advertises `session/load` (session reuse). */
	get supportsLoadSession() {
		return this.agentCapabilities?.loadSession === true;
	}
	/** Whether the agent advertises `session/list` via sessionCapabilities. */
	get supportsListSessions() {
		return this.sessionCapabilities?.list != null && this.sessionCapabilities.list !== null;
	}
	/** Whether the agent advertises `session/delete` via sessionCapabilities. */
	get supportsDeleteSession() {
		return this.sessionCapabilities?.delete != null && this.sessionCapabilities.delete !== null;
	}
	/**
	* Server identity published in the `initialize` response: the agent's
	* reported name/version and the negotiated ACP protocol version. Returns
	* `undefined` before {@link ready} settles or when no protocol version was
	* negotiated. When the agent omitted or published an invalid `agentInfo`
	* (the SDK silently drops `agentInfo` failing schema validation —
	* `name`/`version` are required non-empty strings), `agentInfoMissing`
	* is `true` and `agentName`/`agentVersion` are empty; callers that need a
	* populated answer should `await ready` first.
	* @returns the agent name/version, protocol version, and whether
	* `agentInfo` was missing; or `undefined` when no protocol version exists.
	*/
	getServerInfo() {
		const protocolVersion = this.protocolVersion;
		if (protocolVersion === void 0) return void 0;
		const info = this.agentInfo;
		if (info === void 0) return {
			agentName: "",
			agentVersion: "",
			protocolVersion,
			agentInfoMissing: true
		};
		return {
			agentName: info.name,
			agentVersion: info.version,
			protocolVersion,
			agentInfoMissing: false
		};
	}
	/**
	* The browser login URL most recently published via the
	* `_codebuddy.ai/authUrl` extension notification, or `undefined` when no
	* interactive login is pending. The settings UI surfaces it as a clickable
	* link so a headless host can still complete the browser login.
	*/
	getPendingAuthUrl() {
		return this.pendingAuthUrl;
	}
	/**
	* Total context window (tokens) the server reported in its newest
	* `usage_update` sample, or `undefined` before it reports one. A server
	* counts this as the capacity of the model behind it, so it is exempt from
	* session lifecycle: it outlives the session that published it and is read
	* by the adapter as the route's model context capacity.
	*/
	getContextWindow() {
		return this.reportedContextWindow;
	}
	/**
	* The auth method id of an in-flight key-less interactive round, or
	* `undefined` when no round is running. Lets callers surface "waiting for
	* interactive login" even before (or without) an auth URL.
	*/
	getPendingAuthMethod() {
		return this.interactiveAuthMethodId;
	}
	/**
	* The advertised auth methods plus the operator's selection, for the ACP
	* Servers picker. `needed` is true only once an authentication attempt was
	* actually blocked for want of a selection — a server that offers several
	* methods but logs in from a cached credential must not be nagged.
	* @returns the method catalog (empty before `initialize`), the configured
	*   method id (`''` when unset), and whether the user must choose.
	*/
	authMethodState() {
		return {
			methods: (this.authMethods ?? []).map((m) => ({
				id: m.id,
				name: m.name
			})),
			selected: this.spec.authMethod ?? "",
			needed: this.authChoiceBlocked
		};
	}
	/**
	* Begin an interactive authenticate round when the server advertises auth
	* methods — a no-op otherwise. Waits for `initialize` first so the
	* advertised method list is populated; failures surface through `onWarn`.
	*/
	requestInteractiveAuth() {
		this.ready.then(() => this.ensureAuthenticated()).catch((error) => {
			this.spec.onWarn?.(`llm-acp: interactive auth for "${this.spec.command}" failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}
	/**
	* Recent ACP protocol interactions (ring buffer, {@link MAX_PROTOCOL_TRACE} entries). The
	* protocol inspector view polls this to show what the server is doing.
	* @returns a snapshot copy of the trace buffer.
	*/
	getProtocolTrace() {
		return [...this.protocolTrace];
	}
	/** Append one trace entry, evicting the oldest when the buffer is full.
	* Consecutive entries sharing `collapseKey` merge into one with a `count`
	* so per-token stream chunks do not flood the buffer. */
	traceEvent(dir, method, summary, collapseKey, detail) {
		const last = this.protocolTrace[this.protocolTrace.length - 1];
		if (collapseKey !== void 0 && last !== void 0 && last.dir === dir && last.method === method && last.collapseKey === collapseKey) {
			last.time = Date.now();
			last.count = (last.count ?? 1) + 1;
			return;
		}
		this.protocolTrace.push({
			time: Date.now(),
			dir,
			method,
			summary,
			...collapseKey === void 0 ? {} : { collapseKey },
			...detail === void 0 ? {} : { detail: tryStringify(detail).slice(0, MAX_TRACE_DETAIL) }
		});
		while (this.protocolTrace.length > MAX_PROTOCOL_TRACE) this.protocolTrace.shift();
	}
	/**
	* Eager `authenticate` round, run during `initialize` only when the server
	* advertises auth methods AND a configured API key resolves. The key rides
	* as `_meta.api_key` for servers that accept direct key authentication.
	* Without a key no `authenticate` call is made: servers that accept env
	* credentials or a cached login go straight to `session/new`, and servers
	* that truly require an interactive round reach it lazily through
	* {@link ensureAuthenticated} on the first failed `session/new` — so a
	* well-configured server never triggers a browser login it did not need.
	*
	* The method is resolved by {@link resolveAuthMethod} like the lazy path, so
	* a server offering several methods is never guessed at here either: an
	* unresolved choice leaves this a no-op and `initialize` succeeds, keeping
	* the connection usable for model discovery and the method picker.
	*/
	async authenticateWithKey() {
		const methods = this.authMethods;
		if (methods === void 0 || methods.length === 0) return;
		const apiKey = this.spec.resolveAuthApiKey !== void 0 ? await this.spec.resolveAuthApiKey().catch(() => void 0) : void 0;
		if (apiKey === void 0) return;
		const { method } = resolveAuthMethod(methods, this.spec.authMethod ?? "");
		if (method === void 0) {
			this.noteAuthChoiceBlocked();
			return;
		}
		this.traceEvent("send", "authenticate", `methodId=${method.id} (with key)`, void 0, { methodId: method.id });
		this.authRound = withTimeout(this.conn.authenticate({
			methodId: method.id,
			_meta: { api_key: apiKey }
		}).then(() => {
			this.traceEvent("recv", "authenticate", `methodId=${method.id} ok`, void 0, { methodId: method.id });
		}), this.spec.authTimeoutMs, "authenticate");
		await this.authRound;
	}
	/**
	* The connection's single key-less `authenticate` round, started lazily by
	* {@link withAuthRetry} when `session/new`/`session/load` fails on a server
	* that advertised auth methods. Servers with cached credentials (e.g.
	* codebuddy) resolve the call immediately — and only then accept
	* `session/new`. The round is bounded and best-effort: on timeout or error
	* the connection stays usable, and a browser login URL published via the
	* `_codebuddy.ai/authUrl` extension notification is surfaced in the
	* warning so the user can complete an interactive login.
	*
	* A server offering several methods with none selected **starts no round at
	* all**: guessing picks a flow the operator did not choose (codebuddy's
	* intranet-only `iOA` hangs an off-network host for the whole interactive
	* window), so the choice is deferred to the UI and the caller is told no
	* round ran.
	* @returns whether an `authenticate` round actually ran.
	*/
	async ensureAuthenticated() {
		const methods = this.authMethods;
		const { method } = resolveAuthMethod(methods ?? [], this.spec.authMethod ?? "");
		if (method === void 0) {
			if (methods !== void 0 && methods.length > 0) this.noteAuthChoiceBlocked();
			return { ran: false };
		}
		this.authChoiceBlocked = false;
		this.authChoiceWarnedKey = void 0;
		if (this.authRound !== void 0) {
			await this.authRound;
			return { ran: true };
		}
		this.pendingAuthUrl = void 0;
		this.interactiveAuthMethodId = method.id;
		this.authRound = (async () => {
			try {
				this.traceEvent("send", "authenticate", `methodId=${method.id} (key-less)`, void 0, { methodId: method.id });
				const attempt = this.conn.authenticate({ methodId: method.id });
				const settled = await Promise.race([attempt.then(() => ({
					done: true,
					error: void 0
				}), (error) => ({
					done: true,
					error
				})), sleep(this.spec.interactiveAuthTimeoutMs).then(() => ({
					done: false,
					error: void 0
				}))]);
				if (settled.done) {
					if (settled.error !== void 0) {
						const message = settled.error instanceof Error ? settled.error.message : String(settled.error);
						this.spec.onWarn?.(`llm-acp: key-less authentication for "${this.spec.command}" failed: ${message}`);
						this.traceEvent("recv", "authenticate", `methodId=${method.id} error: ${message}`, void 0, {
							methodId: method.id,
							error: message
						});
					} else {
						this.pendingAuthUrl = void 0;
						this.traceEvent("recv", "authenticate", `methodId=${method.id} ok`, void 0, { methodId: method.id });
					}
					return;
				}
				const url = this.pendingAuthUrl;
				this.spec.onWarn?.(`llm-acp: interactive authentication for "${this.spec.command}" is still pending after ${this.spec.interactiveAuthTimeoutMs}ms` + (url !== void 0 ? ` — complete the login in a browser: ${url}` : ""));
			} finally {
				this.authRound = void 0;
				this.interactiveAuthMethodId = void 0;
			}
		})();
		await this.authRound;
		return { ran: true };
	}
	/**
	* Latch the "the server offers several auth methods and none is selected"
	* state and warn once per distinct condition. Called only from an attempt
	* that was actually blocked, so a server whose cached login still works
	* never reaches it; the warning repeats only when the selection or the
	* advertised method list changes, so a failing turn does not spam the log.
	*/
	noteAuthChoiceBlocked() {
		this.authChoiceBlocked = true;
		const advertised = (this.authMethods ?? []).map((m) => m.id).join(", ");
		const configured = this.spec.authMethod ?? "";
		const key = `${configured}|${advertised}`;
		if (this.authChoiceWarnedKey === key) return;
		this.authChoiceWarnedKey = key;
		this.spec.onWarn?.(`llm-acp: "${this.spec.command}" requires authentication and advertises ${this.authMethods?.length ?? 0} methods [${advertised}]` + (configured.length > 0 ? `, but the configured authMethod "${configured}" is not one of them` : ", but none is selected") + " — pick one in Settings → ACP Servers (authMethod)");
	}
	/**
	* Run one session operation bounded by `sessionTimeoutMs`. On failure —
	* once, and only while no `authenticate` round has run yet and the server
	* advertised auth methods — run {@link ensureAuthenticated} and retry.
	* This is the lazy-auth path: servers that accept env credentials or a
	* cached login never see an `authenticate` call at all.
	*/
	async withAuthRetry(label, call) {
		try {
			return await withTimeout(call(), this.spec.sessionTimeoutMs, label);
		} catch (error) {
			if (this.authMethods === void 0 || this.authMethods.length === 0 || !isAuthRequiredError(error)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			const { ran } = await this.ensureAuthenticated();
			if (!ran) throw new Error(`llm-acp: ${label} requires authentication for "${this.spec.command}", but ${this.authChoiceRejection()}`);
			this.spec.onWarn?.(`llm-acp: ${label} failed for "${this.spec.command}" (${message}); ran one authenticate round, retrying`);
			return await withTimeout(call(), this.spec.sessionTimeoutMs, label);
		}
	}
	/** Why the connection cannot authenticate on its own, for an error message. */
	authChoiceRejection() {
		const methods = this.authMethods ?? [];
		const configured = this.spec.authMethod ?? "";
		const advertised = methods.map((m) => m.id).join(", ");
		return methods.length > 1 ? `it advertises ${methods.length} auth methods [${advertised}] and ${configured.length > 0 ? `the configured authMethod "${configured}" is not one of them` : "none is selected"} — pick one in Settings → ACP Servers (authMethod)` : "no usable auth method was advertised";
	}
	/** Resolve one ACP permission request through its owning session. */
	async requestPermission(params) {
		const entry = this.queues.get(params.sessionId);
		if (entry?.permissionRequester === void 0) {
			this.spec.onWarn?.("llm-acp: interactive permission request failed closed because no active harness approval requester was available");
			return this.rejectPermission(params);
		}
		let decision;
		try {
			const title = describePermissionToolCall(params.toolCall, params.options);
			const optionLabels = params.options.map((o) => o.name).filter((n) => typeof n === "string" && n.length > 0);
			this.traceEvent("recv", "session/request_permission", `title="${title}"`, void 0, params);
			this.spec.onWarn?.(`llm-acp: permission request toolCall=${JSON.stringify(params.toolCall)} options=${JSON.stringify(params.options.map((o) => ({
				kind: o.kind,
				name: o.name
			})))} -> title="${title}"`);
			decision = await entry.permissionRequester({
				title,
				signal: entry.signal,
				optionLabels
			});
		} catch (error) {
			this.spec.onWarn?.(`llm-acp: permission request failed closed: ${error instanceof Error ? error.message : String(error)}`);
			return this.rejectPermission(params);
		}
		if (decision === "cancel") return { outcome: { outcome: "cancelled" } };
		if (decision === "reject") return this.rejectPermission(params);
		const option = params.options.find((item) => item.kind === "allow_once");
		return option === void 0 ? this.rejectPermission(params) : { outcome: {
			outcome: "selected",
			optionId: option.optionId
		} };
	}
	/** Select an advertised rejection option, or cancel when none is available. */
	rejectPermission(params) {
		const option = params.options.find((item) => item.kind === "reject_once" || item.kind === "reject_always");
		return option === void 0 ? { outcome: { outcome: "cancelled" } } : { outcome: {
			outcome: "selected",
			optionId: option.optionId
		} };
	}
	/** Push an inbound session/update into the owning session's queue. */
	enqueueUpdate(params) {
		const update = params.update;
		if (update.sessionUpdate === "usage_update") {
			const used = acpTokenCount(update.used);
			const size = acpTokenCount(update.size);
			this.traceEvent("recv", "session/update", `usage_update sessionId=${params.sessionId} used=${String(update.used)} size=${String(update.size)}`, `update:usage_update:${params.sessionId}`, params);
			if (size !== void 0 && size > 0) this.reportedContextWindow = size;
			const owner = this.queues.get(params.sessionId);
			if (owner !== void 0 && used !== void 0) {
				owner.queue.push({
					kind: "usage",
					used
				});
				this.signal(owner);
			}
			this.trackAgentPhase(params.sessionId, update);
			return;
		}
		const entry = this.queues.get(params.sessionId);
		if (entry === void 0) {
			const contentDrop = update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk" || update.sessionUpdate === "tool_call" || update.sessionUpdate === "plan";
			this.traceEvent("recv", "session/update-dropped", `${update.sessionUpdate} sessionId=${params.sessionId}`, contentDrop ? `drop:${update.sessionUpdate}:${params.sessionId}` : `drop:${update.sessionUpdate}`, params);
			this.spec.onWarn?.(`llm-acp: dropped session/update ${update.sessionUpdate} for unqueued session ${params.sessionId}`);
			return;
		}
		const isChunk = update.sessionUpdate === "agent_thought_chunk" || update.sessionUpdate === "agent_message_chunk";
		const preview = isChunk ? ` text=${JSON.stringify(acpContentText(update.content).slice(0, 40))}` : "";
		this.traceEvent("recv", "session/update", `${update.sessionUpdate} sessionId=${params.sessionId}${preview}`, isChunk ? `update:${update.sessionUpdate}:${params.sessionId}` : void 0, params);
		if (update.sessionUpdate === "agent_message_chunk") entry.queue.push({
			kind: "text",
			text: acpContentText(update.content)
		});
		else if (update.sessionUpdate === "agent_thought_chunk") entry.queue.push({
			kind: "reasoning",
			text: acpContentText(update.content)
		});
		else if (update.sessionUpdate === "tool_call") {
			const title = update.title ?? "tool";
			entry.queue.push({
				kind: "progress",
				text: `[tool: ${title}]`
			});
		} else if (update.sessionUpdate === "tool_call_update") {} else if (update.sessionUpdate === "plan") {} else if (update.sessionUpdate === "user_message_chunk") {}
		this.trackAgentPhase(params.sessionId, update);
		this.signal(entry);
	}
	/**
	* Arm or clear the idle watchdog from an update's `agentPhase` marker. Every
	* update kind is inspected, not just content: a server may attach the marker
	* to a non-content update (a usage sample, a mode change), and an `idle`
	* phase there means the same thing. Unknown sessions are no-ops — the
	* watchdog guards a prompt drain, so it only exists alongside one.
	*/
	trackAgentPhase(sessionId, update) {
		const entry = this.queues.get(sessionId);
		if (entry === void 0) return;
		const phase = acpAgentPhase(update);
		if (phase === "idle") {
			if (entry.idleTimer === void 0) entry.idleTimer = setTimeout(() => {
				entry.idleTimer = void 0;
				if (entry.promptSettled === true) return;
				this.conn.cancel({ sessionId }).catch(() => {});
				this.spec.onWedged?.(`prompt went idle without answering (session ${sessionId})`);
				entry.queue.push({
					kind: "error",
					error: /* @__PURE__ */ new Error(`llm-acp: agent went idle without answering session/prompt for session ${sessionId} — the server dropped the turn`)
				});
				this.signal(entry);
			}, IDLE_SETTLE_GRACE_MS);
		} else if (phase !== void 0 && entry.idleTimer !== void 0) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = void 0;
		}
	}
	/**
	* Handle extension notifications from ACP servers that use non-standard
	* protocols (e.g. Devin's `_cognition.ai/*` notifications). These are
	* silently consumed to prevent SDK error logs, with progress notifications
	* surfaced to keep the user informed during long operations.
	*/
	handleExtNotification(method, params) {
		this.traceEvent("recv", method, tryStringify(params).slice(0, 100), void 0, params);
		if (method === "_cognition.ai/output") {
			const message = typeof params.message === "string" ? params.message : "";
			const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
			if (message.length > 0 && sessionId.length > 0) {
				const entry = this.queues.get(sessionId);
				if (entry !== void 0) {
					entry.queue.push({
						kind: "progress",
						text: message
					});
					this.signal(entry);
				}
			}
			return;
		}
		if (method === "_cognition.ai/thinking_complete") return;
		if (method === "_cognition.ai/agent_stopped") return;
		if (method === "_cognition.ai/mcp/serversChanged") return;
		if (method === "_cognition.ai/connection_retry") return;
		if (method === "_codebuddy.ai/authUrl") {
			const authUrl = typeof params.authUrl === "string" ? params.authUrl : "";
			if (authUrl.length > 0) {
				this.pendingAuthUrl = authUrl;
				if (!this.authUrlNotified) {
					this.authUrlNotified = true;
					this.spec.onAuthUrl?.(authUrl);
				}
			}
			return;
		}
		this.spec.onWarn?.(`llm-acp: unhandled extension notification ${method}: ${tryStringify(params).slice(0, 200)}`);
	}
	/**
	* Handle extension requests from ACP servers. Currently no extension
	* requests are expected; return an empty object to satisfy the protocol.
	*/
	handleExtMethod(method, _params) {
		this.spec.onWarn?.(`llm-acp: unhandled extension request: ${method}`);
		return Promise.resolve({});
	}
	/** Wake a consumer waiting on an empty queue. */
	signal(entry) {
		const resolve = entry.resolve;
		if (resolve !== void 0) {
			entry.resolve = void 0;
			resolve();
		}
	}
	/** Drain the queue for one session, awaiting new updates when it is empty. */
	async *drainQueue(sessionId) {
		const entry = this.queues.get(sessionId);
		if (entry === void 0) return;
		while (true) {
			while (entry.queue.length > 0) yield entry.queue.shift();
			if (entry.queue.length === 0) await new Promise((resolve) => {
				entry.resolve = resolve;
			});
		}
	}
	/**
	* Create a fresh ACP session for one prompt. The session is removed from the
	* connection's queue map after the generator completes or is abandoned.
	* @returns the remote session id.
	*/
	async newSession() {
		this.traceEvent("send", "session/new", `cwd=${this.spec.cwd}`, void 0, {
			cwd: this.spec.cwd,
			mcpServers: []
		});
		let session;
		try {
			session = await this.withAuthRetry("session/new", () => this.conn.newSession({
				cwd: this.spec.cwd,
				mcpServers: []
			}));
		} catch (error) {
			if (isTimeoutError(error)) this.spec.onWedged?.(`session/new timed out after ${this.spec.sessionTimeoutMs}ms`);
			throw error;
		}
		const returnedId = Reflect.get(session, "sessionId");
		if (typeof returnedId !== "string") throw new Error("llm-acp: ACP server published a session without a string sessionId");
		this.traceEvent("recv", "session/new", `sessionId=${returnedId}`, void 0, session);
		return returnedId;
	}
	/**
	* Load an existing ACP session by id (`session/load`). Only available when
	* the agent advertises the `loadSession` capability. Returns the session's
	* current config options (models, modes, etc.) if the server publishes them.
	* @param sessionId - the remote session id to resume.
	* @returns the config options published by the server, or `undefined`.
	*/
	async loadSession(sessionId) {
		const session = await this.withAuthRetry("session/load", () => this.conn.loadSession({
			sessionId,
			cwd: this.spec.cwd,
			mcpServers: []
		}));
		return Reflect.get(session, "configOptions") ?? void 0;
	}
	/**
	* List existing ACP sessions (`session/list`). Only available when the agent
	* advertises the `session/list` capability. Returns `undefined` when the
	* agent does not support listing.
	* @param cursor - optional pagination cursor from a previous response.
	* @returns the session list and optional next cursor, or `undefined`.
	*/
	async listSessions(cursor) {
		if (!this.supportsListSessions) return void 0;
		const result = await withTimeout(this.conn.listSessions({ cursor: cursor ?? null }), this.spec.sessionTimeoutMs, "session/list");
		const nextCursor = result.nextCursor;
		return nextCursor !== null && nextCursor !== void 0 ? {
			sessions: result.sessions,
			nextCursor
		} : { sessions: result.sessions };
	}
	/**
	* Delete an ACP session (`session/delete`). Only available when the agent
	* advertises the `session/delete` capability. Best-effort: errors are
	* swallowed because the session may already be gone.
	* @param sessionId - the remote session id to delete.
	* @returns `true` if the session was deleted, `false` if unsupported or failed.
	*/
	async deleteSession(sessionId) {
		if (!this.supportsDeleteSession) return false;
		try {
			await this.conn.deleteSession({ sessionId });
			return true;
		} catch {
			return false;
		}
	}
	/**
	* Probe the ACP server for its model catalog by creating a throwaway session
	* and reading the `configOptions` (category `model`) from the `session/new`
	* response. The probe session is closed immediately. Returns `undefined` when
	* the server publishes no model config option.
	* @returns the model entries, or `undefined` if none were advertised.
	*/
	async discoverModels() {
		const options = await this.discoverConfigOptions();
		if (options === void 0) return void 0;
		return this.extractModels(options);
	}
	/**
	* Probe the ACP server for its full config option catalog by creating a
	* throwaway session and reading `configOptions` from the `session/new`
	* response. The probe session is closed immediately. Returns `undefined`
	* when the server publishes no config options.
	* @returns all config options (models, modes, thought levels, etc.).
	*/
	async discoverConfigOptions() {
		await this.ready;
		if (this.cachedConfigOptions !== void 0) return this.cachedConfigOptions;
		this.configOptionsProbe ??= this.probeConfigOptions();
		let options;
		try {
			options = await this.configOptionsProbe;
		} finally {
			this.configOptionsProbe = void 0;
		}
		if (options !== void 0) this.cachedConfigOptions = options;
		return options;
	}
	/** Single config-option probe: one throwaway session, closed immediately. */
	async probeConfigOptions() {
		const session = await this.withAuthRetry("session/new", () => this.conn.newSession({
			cwd: this.spec.cwd,
			mcpServers: []
		}));
		const configOptions = Reflect.get(session, "configOptions");
		const sessionId = Reflect.get(session, "sessionId");
		if (typeof sessionId === "string") this.conn.closeSession({ sessionId }).catch(() => {});
		if (configOptions === void 0 || configOptions === null) return void 0;
		return configOptions;
	}
	/**
	* List the session modes this server advertises via the `mode` config
	* option (category `mode`, type `select`), e.g. Devin's
	* `accept-edits`/`bypass`. `undefined` when the server publishes no mode
	* selector or the config-option probe is unsupported.
	*/
	async discoverModes() {
		const options = await this.discoverConfigOptions();
		if (options === void 0) return void 0;
		return this.extractSelectValues(options, "mode");
	}
	/** Extract model entries from a config option list (category `model`, type `select`). */
	extractModels(options) {
		return this.extractSelectValues(options, "model");
	}
	/** Collect the leaf `{value, name}` pairs of one select config option by
	* category. Handles both flat option lists and grouped option lists per the
	* ACP `SessionConfigSelectOptions` union: a group entry carries its own
	* `options` array of leaf values, so flatten one level before collecting. */
	extractSelectValues(options, category) {
		const selectOption = options.find((opt) => opt.category === category && opt.type === "select");
		if (selectOption === void 0 || selectOption.type !== "select") return void 0;
		const selectOptions = Array.isArray(selectOption.options) ? selectOption.options : [];
		const entries = [];
		for (const opt of selectOptions) if ("value" in opt && typeof opt.value === "string" && typeof opt.name === "string") entries.push({
			id: opt.value,
			name: opt.name
		});
		else if ("group" in opt && Array.isArray(opt.options)) {
			for (const leaf of opt.options) if ("value" in leaf && typeof leaf.value === "string" && typeof leaf.name === "string") entries.push({
				id: leaf.value,
				name: leaf.name
			});
		}
		return entries.length > 0 ? entries : void 0;
	}
	/**
	* Set the model for one ACP session via `session/set_config_option`. Best-effort:
	* if the server rejects the config id or value, the error surfaces from the
	* caller. Only called when the model differs from the server's current value.
	* @param sessionId - the remote session id from {@link AcpConnection.newSession}.
	* @param modelId - the model value id to select.
	*/
	async setSessionModel(sessionId, modelId) {
		await withTimeout(this.conn.setSessionConfigOption({
			sessionId,
			configId: "model",
			value: modelId
		}), this.spec.sessionTimeoutMs, "session/set_config_option");
	}
	/**
	* Switch the ACP session's mode (e.g. `bypass` on agents that publish a
	* `mode` config option). Prefers the unified `session/set_config_option`
	* write and falls back to the legacy `session/set_mode` when the config
	* option is unknown to the server.
	* @param sessionId - the remote session id from {@link AcpConnection.newSession}.
	* @param modeId - the mode value id to select.
	*/
	async setSessionMode(sessionId, modeId) {
		try {
			await withTimeout(this.conn.setSessionConfigOption({
				sessionId,
				configId: "mode",
				value: modeId
			}), this.spec.sessionTimeoutMs, "session/set_config_option");
		} catch {
			await withTimeout(this.conn.setSessionMode({
				sessionId,
				modeId
			}), this.spec.sessionTimeoutMs, "session/set_mode");
		}
	}
	/**
	* Send one user message to `sessionId` and yield streamed assistant updates
	* until the prompt call settles. The SDK v1 contract delivers the terminal
	* `stopReason` in the `session/prompt` response; streamed
	* `agent_message_chunk` updates arrive first via the sessionUpdate callback.
	* The generator emits text/reasoning chunks followed by a single terminal
	* `done` or `error` update, then removes the session queue.
	*
	* Cancellation: when `signal` aborts, a best-effort `session/cancel` is sent
	* and the generator ends after draining any already-queued updates.
	* @param sessionId - the remote session id from {@link AcpConnection.newSession}.
	* @param prompt - ACP content blocks forming the single user message.
	* @param signal - cancellation; abort triggers a best-effort ACP cancel.
	* @param permissionRequester - interactive requester captured for this prompt.
	*/
	async *promptStream(sessionId, prompt, signal, permissionRequester) {
		const entry = {
			queue: [],
			resolve: void 0,
			permissionRequester,
			signal
		};
		this.queues.set(sessionId, entry);
		let cancelTimer;
		const onAbort = () => {
			this.conn.cancel({ sessionId }).catch(() => {});
			cancelTimer = setTimeout(() => {
				entry.queue.push({
					kind: "done",
					reason: "cancelled"
				});
				this.signal(entry);
			}, CANCEL_SETTLE_GRACE_MS);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		const promptSummary = prompt.map((b) => b.type === "text" ? b.text.slice(0, 60) : `[${b.type}]`).join(" ");
		this.traceEvent("send", "session/prompt", `sessionId=${sessionId} prompt=${promptSummary.slice(0, 80)}`, void 0, {
			sessionId,
			prompt
		});
		this.conn.prompt({
			sessionId,
			prompt
		}).then((result) => {
			const stopReason = Reflect.get(result, "stopReason");
			this.traceEvent("recv", "session/prompt", `stopReason=${stopReason ?? "end_turn"}`, void 0, result);
			entry.promptSettled = true;
			if (entry.idleTimer !== void 0) {
				clearTimeout(entry.idleTimer);
				entry.idleTimer = void 0;
			}
			entry.queue.push({
				kind: "done",
				reason: stopReason ?? "end_turn"
			});
			this.signal(entry);
		}, (err) => {
			const error = err instanceof Error ? err : new Error(String(err));
			entry.promptSettled = true;
			if (entry.idleTimer !== void 0) {
				clearTimeout(entry.idleTimer);
				entry.idleTimer = void 0;
			}
			entry.queue.push({
				kind: "error",
				error
			});
			this.signal(entry);
		}).catch(() => {});
		try {
			for await (const update of this.drainQueue(sessionId)) {
				yield update;
				if (update.kind === "done" || update.kind === "error") break;
			}
		} finally {
			signal.removeEventListener("abort", onAbort);
			if (cancelTimer !== void 0) clearTimeout(cancelTimer);
			if (entry.idleTimer !== void 0) clearTimeout(entry.idleTimer);
			this.queues.delete(sessionId);
		}
	}
	/**
	* Close one ACP session after a prompt completes. Best-effort: errors are
	* swallowed because the session may already be gone.
	* @param sessionId - the remote session id to close.
	*/
	closeSession(sessionId) {
		this.conn.closeSession({ sessionId }).catch(() => {});
	}
	/** Best-effort cancel of one in-flight session; unknown ids are no-ops. */
	cancel(sessionId) {
		this.conn.cancel({ sessionId }).catch(() => {});
	}
	/** Idempotent disposal: runs the teardown ladder once and resolves at quiescence. */
	dispose() {
		if (this.disposed) return this.disposal ?? Promise.resolve();
		this.disposed = true;
		this.disposal = (async () => {
			for (const [, entry] of this.queues) {
				entry.queue.push({
					kind: "error",
					error: /* @__PURE__ */ new Error("llm-acp: connection disposed")
				});
				this.signal(entry);
			}
			this.queues.clear();
			await disposeAcpChild(this.child, this.spec.disposeEofGraceMs);
		})();
		return this.disposal;
	}
};
//#endregion
//#region lib/types/registry.json
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
//#region lib/types/index.js
/**
* Register {@link AcpAdapter} instances on `ctx.llm` that delegate model calls
* to external ACP servers over JSON-RPC stdio. The plugin reads configured
* servers from the `llm-acp` settings namespace; each server spawns one
* long-lived child process and becomes a provider route `acp-<id>`. Servers
* can be added or removed dynamically through the settings UI without restart.
*
* This plugin uses named exports only; a default would hide its loader
* metadata (see `docs/postmortem/0001-acp-default-export-drops-inject.md`).
* @module @deepseek-ai/dsh-llm-acp
*/
const name = "llm-acp";
const inject = [
	"llm",
	"subprocess",
	"settings"
];
/** Settings namespace owned by this plugin. */
const NS = "llm-acp";
/** Structural deep equality over JSON-compatible data (objects, arrays, primitives). */
function deepEqualJson(a, b) {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((entry, index) => deepEqualJson(entry, b[index]));
	}
	const left = a;
	const right = b;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => key in right && deepEqualJson(left[key], right[key]));
}
const Config = z.object({
	env: z.dict(z.string()).default({}),
	emitReasoning: z.boolean().default(true),
	emitProgress: z.boolean().default(false),
	defaultModelId: z.string().default("devin"),
	defaultModelName: z.string().default("Devin (ACP)"),
	disposeEofGraceMs: z.number().default(DEFAULT_DISPOSE_EOF_GRACE_MS),
	disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
	initTimeoutMs: z.number().default(DEFAULT_INIT_TIMEOUT_MS),
	sessionTimeoutMs: z.number().default(DEFAULT_SESSION_TIMEOUT_MS),
	authTimeoutMs: z.number().default(DEFAULT_AUTH_TIMEOUT_MS),
	interactiveAuthTimeoutMs: z.number().default(DEFAULT_INTERACTIVE_AUTH_TIMEOUT_MS),
	cwd: z.string(),
	servers: z.dict(z.object({
		command: z.string().required(),
		args: z.array(z.string()).default([]),
		name: z.string().required(),
		env: z.dict(z.string()).default({}),
		models: z.array(z.string()).default([]),
		customModels: z.array(z.object({
			id: z.string().required(),
			name: z.string().default("")
		})).default([]),
		modeMap: z.dict(z.string()).default({}),
		authMethod: z.string().default("")
	})).default({})
});
/** Settings schema: a map of server ids to their spawn configuration. */
const SettingsSchema = z.object({ servers: z.dict(z.object({
	command: z.string().required(),
	args: z.array(z.string()).default([]),
	name: z.string().required(),
	env: z.dict(z.string()).default({}),
	models: z.array(z.string()).default([]),
	customModels: z.array(z.object({
		id: z.string().required(),
		name: z.string().default("")
	})).default([]),
	modeMap: z.dict(z.string()).default({}),
	authMethod: z.string().default("")
})).default({}) });
/** A dispose grace must fit the single Node timer that owns its teardown tier. */
function assertPositiveFinite(name, value) {
	if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) throw new Error(`llm-acp: ${name} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
}
/** Whether `path` names an existing directory the harness can enter (X_OK). */
function isDirectory(path) {
	try {
		if (!statSync(path).isDirectory()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
/** Assert `cwd` is absolute and an accessible directory. */
function assertUsableCwd(label, cwd) {
	if (!isAbsolute(cwd)) throw new Error(`llm-acp: ${label} must be an absolute path: ${cwd}`);
	if (!isDirectory(cwd)) throw new Error(`llm-acp: ${label} is not an accessible directory: ${cwd}`);
	return cwd;
}
/** Derive the bin name an npm package installs (heuristic: last path segment
* of the package name, without scope or version). `@scope/name@ver` → `name`,
* `name@ver` → `name`. The true bin may differ; this is only a PATH probe. */
function npmBinName(pkg) {
	return pkg.startsWith("@") ? pkg.split("@", 2)[1]?.split("/").pop() : pkg.split("@", 0)[0] ?? pkg.split("@")[0];
}
/** User-level install dirs probed after the process PATH. GUI and service
* launches inherit a minimal PATH that misses `~/.local/bin` (devin, pipx,
* uv) and the Homebrew prefix, even though a login shell finds them. */
const EXTRA_BIN_DIRS = process.platform === "win32" ? [] : [
	resolve(homedir(), ".local/bin"),
	"/opt/homebrew/bin",
	"/usr/local/bin",
	resolve(homedir(), "bin")
];
/** Locate an executable in PATH plus {@link EXTRA_BIN_DIRS}; returns the
* absolute path or `undefined`.
* ponytail: ceiling — scans PATH on every probe; called once per server spawn. */
function whichBin(bin) {
	const sep = process.platform === "win32" ? ";" : ":";
	const exts = process.platform === "win32" ? [
		".exe",
		".cmd",
		".bat",
		""
	] : [""];
	for (const dir of (process.env.PATH ?? "").split(sep).concat(EXTRA_BIN_DIRS)) {
		if (dir.length === 0) continue;
		for (const ext of exts) {
			const p = resolve(dir, bin + ext);
			try {
				accessSync(p, constants.X_OK);
				return p;
			} catch {}
		}
	}
}
/** Resolve a bare command name to its absolute path so the spawn does not
* depend on the process PATH. Names already carrying a path separator (or
* absent from every probed dir) pass through unchanged — the spawn error
* then reports the configured name. */
function resolveCommandPath(command) {
	if (command.includes("/") || command.includes("\\")) return command;
	return whichBin(command) ?? command;
}
/**
* Rewrite a `npx -y <pkg> [args…]` spawn to use the package's bin directly
* when it is already in PATH, avoiding an npm fetch. Settings still store the
* `npx` form (portable); the rewrite is a spawn-time optimization. Returns the
* original pair when the pattern doesn't match or the bin is absent.
*/
function resolveNpxShortcut(command, args) {
	if (command !== "npx") return {
		command,
		args: [...args]
	};
	const idx = args.findIndex((a) => a === "-y" || a === "--yes");
	if (idx < 0 || idx + 1 >= args.length) return {
		command,
		args: [...args]
	};
	const pkg = args[idx + 1];
	if (typeof pkg !== "string" || pkg.length === 0) return {
		command,
		args: [...args]
	};
	const rest = args.slice(idx + 2);
	const bin = npmBinName(pkg);
	if (bin === void 0) return {
		command,
		args: [...args]
	};
	const resolved = whichBin(bin);
	if (resolved === void 0) return {
		command,
		args: [...args]
	};
	return {
		command: resolved,
		args: rest
	};
}
/** Append the `approval/asked` + `approval/decided` audit pair for an ACP
* permission request auto-allowed by the session's unrestricted permission
* state (sandbox `danger-full-access` with approval policy `never`). That
* shortcut bypasses `approval.request` (whose `never` policy would reject),
* so without this the session log records no trace of the grant. */
function auditAutoAllowedPermission(session, serverName, title) {
	try {
		const id = randomUUID();
		session.append("approval/asked", {
			id,
			toolName: `ACP: ${title}`,
			reason: `${serverName} requested permission: ${title}. Auto-allowed by session sandbox danger-full-access with approval policy never.`
		});
		session.append("approval/decided", {
			id,
			outcome: "allowed-once"
		});
	} catch {}
}
/** Provider route name for one server id. */
function routeName(serverId) {
	return `acp-${serverId}`;
}
/** Stable JSON fingerprint of a server config, for reconcile change detection. */
function serverFingerprint(server) {
	return JSON.stringify({
		command: server.command,
		args: server.args,
		name: server.name,
		env: server.env ?? {},
		models: server.models ?? [],
		customModels: server.customModels ?? [],
		modeMap: server.modeMap ?? {},
		authMethod: server.authMethod ?? ""
	});
}
/** Directory entries for the configurable-provider directory.
* Always includes at least one entry so the `llm-acp` settings namespace is
* exposed to configuration clients (the web API only serves namespaces that
* appear in `listConfigurableProviders()`). A dormant entry has no
* `settingsPath`, so the Models settings page renders it as a declared route
* the user cannot edit — the ACP Servers page is the intended editor. */
function directoryEntries(servers) {
	const entries = [...servers.entries()].map(([id, server]) => ({
		provider: routeName(id),
		displayName: server.name,
		settingsNs: NS,
		settingsPath: ["servers", id]
	}));
	if (entries.length === 0) entries.push({
		provider: "__acp_dormant__",
		displayName: "ACP",
		settingsNs: NS,
		settingsPath: [],
		declared: true
	});
	return entries;
}
function apply(ctx, config) {
	const resolved = config;
	assertPositiveFinite("disposeEofGraceMs", resolved.disposeEofGraceMs);
	assertPositiveFinite("disposeGraceMs", resolved.disposeGraceMs);
	assertPositiveFinite("initTimeoutMs", resolved.initTimeoutMs);
	assertPositiveFinite("sessionTimeoutMs", resolved.sessionTimeoutMs);
	assertPositiveFinite("authTimeoutMs", resolved.authTimeoutMs);
	assertPositiveFinite("interactiveAuthTimeoutMs", resolved.interactiveAuthTimeoutMs);
	const cwd = config.cwd === void 0 || config.cwd === "" ? process.cwd() : assertUsableCwd("config cwd", resolve(config.cwd));
	/** Current settings source; updated by `settings.installSection`. */
	let currentSettings = () => ({ servers: {} });
	/** Servers from the composition entry (inline config). */
	const configServers = () => {
		const result = /* @__PURE__ */ new Map();
		if (resolved.servers !== void 0) for (const [id, server] of Object.entries(resolved.servers)) result.set(id, server);
		return result;
	};
	/** Merged servers from both config and settings. */
	const mergedServers = () => {
		const result = configServers();
		const settings = currentSettings();
		if (settings?.servers !== void 0) for (const [id, server] of Object.entries(settings.servers)) result.set(id, server);
		return result;
	};
	/** Active connections keyed by server id. */
	const active = /* @__PURE__ */ new Map();
	/** Best-effort system-browser open for an interactive login URL; failure keeps the URL in the auth warning. */
	function openBrowser(url) {
		const argv = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? [
			"cmd",
			"/c",
			"start",
			"",
			url
		] : ["xdg-open", url];
		try {
			ctx.subprocess.spawn({
				argv,
				cwd,
				stdio: {
					stdin: "ignore",
					stdout: "inherit",
					stderr: "inherit"
				},
				graceMs: resolved.disposeGraceMs
			}).done.catch(() => {});
		} catch {}
	}
	/** Create one ACP connection + adapter for a server. */
	function createServer(serverId, server) {
		const serverEnv = {
			...resolved.env,
			...server.env ?? {}
		};
		const { command: npxCommand, args: spawnArgs } = resolveNpxShortcut(server.command, server.args);
		const connection = new AcpConnection({
			command: resolveCommandPath(npxCommand),
			args: spawnArgs,
			cwd,
			env: serverEnv,
			disposeEofGraceMs: resolved.disposeEofGraceMs,
			disposeGraceMs: resolved.disposeGraceMs,
			initTimeoutMs: resolved.initTimeoutMs,
			sessionTimeoutMs: resolved.sessionTimeoutMs,
			authTimeoutMs: resolved.authTimeoutMs,
			interactiveAuthTimeoutMs: resolved.interactiveAuthTimeoutMs,
			spawn: (spec) => ctx.subprocess.spawn(spec),
			onWarn: (message) => ctx.logger.warn(message),
			onAuthUrl: openBrowser,
			authMethod: server.authMethod ?? "",
			resolveAuthApiKey: async () => {
				for (const key of [
					"DEEPSEEK_API_KEY",
					"OPENAI_API_KEY",
					"ANTHROPIC_API_KEY",
					"DEVIN_API_KEY",
					"API_KEY",
					"CODEBUDDY_API_KEY",
					"LLM_API_KEY"
				]) {
					const value = serverEnv[key];
					if (typeof value === "string" && value.length > 0) return value;
				}
			},
			onWedged: (reason) => {
				const existing = active.get(serverId);
				if (existing === void 0 || existing.connection !== connection) return;
				ctx.logger.warn(`llm-acp: rebuilding "${serverId}" (${reason})`);
				existing.adapter.disposeSessions();
				existing.registration();
				existing.connection.dispose().catch((error) => {
					ctx.logger.warn(`llm-acp: connection disposal for "${serverId}" failed: ${error instanceof Error ? error.message : String(error)}`);
				});
				active.delete(serverId);
				try {
					const rebuilt = createServer(serverId, server);
					active.set(serverId, rebuilt);
					rebuilt.connection.requestInteractiveAuth();
				} catch (error) {
					ctx.logger.error(`llm-acp: failed to rebuild server "${serverId}": ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		});
		const adapter = new AcpAdapter({
			connection,
			provider: routeName(serverId),
			emitReasoning: resolved.emitReasoning,
			emitProgress: resolved.emitProgress,
			defaultModel: {
				id: resolved.defaultModelId,
				name: resolved.defaultModelName
			},
			enabledModels: server.models,
			customModels: server.customModels,
			onWarn: (message) => ctx.logger.warn(message),
			resolveSessionMode: () => {
				const modeMap = server.modeMap;
				if (modeMap === void 0 || Object.keys(modeMap).length === 0) return void 0;
				const session = (ctx.get("agents")?.currentInitiator())?.session;
				if (session === void 0) return void 0;
				const permissionPresets = ctx.get("permissionPresets");
				const sandboxPolicy = ctx.get("sandboxPolicy");
				const preset = permissionPresets?.current(session);
				const sandbox = sandboxPolicy?.resolve({ session }).mode;
				return (preset !== void 0 ? modeMap[preset] : void 0) ?? (sandbox !== void 0 ? modeMap[sandbox] : void 0);
			},
			permissionRequester: () => {
				const agent = ctx.get("agents")?.currentInitiator();
				if (agent === void 0) return void 0;
				const permissionPresets = ctx.get("permissionPresets");
				const sandboxPolicy = ctx.get("sandboxPolicy");
				const approval = ctx.get("approval");
				if (approval === void 0 && sandboxPolicy === void 0 && permissionPresets === void 0) return void 0;
				const sessionLike = agent.session;
				return async ({ title, signal, optionLabels }) => {
					let preset;
					if (permissionPresets !== void 0) {
						const current = permissionPresets.current(sessionLike);
						if (permissionPresets.names.includes(current)) preset = permissionPresets.resolve(current);
					}
					const sandbox = sandboxPolicy?.resolve({ session: sessionLike }).mode ?? preset?.sandbox;
					const policy = approval?.overrideOf(sessionLike) ?? approval?.config.policy ?? preset?.approval;
					if (sandbox === "danger-full-access" && policy === "never") {
						auditAutoAllowedPermission(sessionLike, server.name, title);
						return "allow";
					}
					if (approval === void 0) return "reject";
					const reason = optionLabels !== void 0 && optionLabels.length > 0 ? `${server.name} requested permission: ${title}. Options: ${optionLabels.join(", ")}.` : `${server.name} requested permission to run "${title}".`;
					const outcome = await approval.request({
						agent,
						toolName: `ACP: ${title}`,
						reason,
						signal
					});
					if (outcome === "allowed-once") return "allow";
					if (outcome === "cancelled") return "cancel";
					if (outcome === "unavailable") ctx.logger.warn(`llm-acp: permission request for "${title}" denied: no approval answerer on this session (unattended sessions auto-deny); run the session under a preset whose approval policy needs no answerer`);
					else if (outcome === "rejected" && policy === "never") ctx.logger.warn(`llm-acp: permission request for "${title}" auto-rejected by approval policy "never" (effective sandbox: ${sandbox ?? "unknown"}); full-access sessions pair approval "never" with sandbox "danger-full-access"`);
					return "reject";
				};
			}
		});
		return {
			connection,
			adapter,
			registration: ctx.llm.registerAdapter([routeName(serverId)], adapter),
			fingerprint: serverFingerprint(server)
		};
	}
	/** Reconcile active connections with the current server set. */
	function reconcileServers() {
		const desired = mergedServers();
		const desiredIds = new Set(desired.keys());
		for (const [id, server] of active) if (!desiredIds.has(id)) {
			server.adapter.disposeSessions();
			server.registration();
			server.connection.dispose().catch((error) => {
				ctx.logger.warn(`llm-acp: connection disposal for "${id}" failed: ${error instanceof Error ? error.message : String(error)}`);
			});
			active.delete(id);
		}
		for (const [id, server] of desired) {
			const existing = active.get(id);
			if (existing === void 0) try {
				active.set(id, createServer(id, server));
			} catch (error) {
				ctx.logger.error(`llm-acp: failed to create server "${id}": ${error instanceof Error ? error.message : String(error)}`);
			}
			else if (existing.fingerprint !== serverFingerprint(server)) {
				existing.adapter.disposeSessions();
				existing.registration();
				existing.connection.dispose().catch((error) => {
					ctx.logger.warn(`llm-acp: connection disposal for "${id}" failed: ${error instanceof Error ? error.message : String(error)}`);
				});
				active.delete(id);
				try {
					active.set(id, createServer(id, server));
				} catch (error) {
					ctx.logger.error(`llm-acp: failed to rebuild server "${id}": ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
	}
	/** Reconcile the configurable-provider directory. */
	let directory;
	let lastDirectoryFacts;
	function reconcileDirectory() {
		const entries = directoryEntries(mergedServers());
		if (deepEqualJson(entries, lastDirectoryFacts)) return;
		if (directory === void 0) directory = ctx.llm.registerConfigurableProviders(entries);
		else directory.replace(entries);
		lastDirectoryFacts = entries;
	}
	reconcileServers();
	reconcileDirectory();
	const INFO_PREFIX = "acp-info-";
	const RESOLVE_PREFIX = "acp-resolve-";
	const TEST_PREFIX = "acp-test-";
	const AUTH_PREFIX = "acp-auth-";
	const METHODS_PREFIX = "acp-methods-";
	/** How long to wait for `initialize` before the test probe reports failure. */
	const TEST_INIT_TIMEOUT_MS = 15e3;
	/** How long to wait for the probe prompt's terminal update before aborting. */
	const TEST_PROMPT_TIMEOUT_MS = 6e4;
	ctx.effect(() => ctx.llm.registerModelDiscovery(NS, async (request, _signal) => {
		const provider = request.provider ?? "";
		if (provider.length === 0) return [];
		if (provider.startsWith(RESOLVE_PREFIX)) {
			const bin = provider.slice(12);
			if (bin.length === 0) return [];
			const resolved = whichBin(bin);
			if (resolved === void 0) return [];
			return [{
				id: resolved,
				name: bin
			}];
		}
		if (provider.startsWith(INFO_PREFIX)) {
			const serverId = provider.slice(9);
			const server = active.get(serverId);
			if (server === void 0) return [{
				id: "error",
				name: "server is not running — no active connection found for this server id; the server may have been removed or never started"
			}];
			let readySettled = false;
			let readyError;
			try {
				await Promise.race([server.connection.ready.then(() => {
					readySettled = true;
				}, (error) => {
					readyError = error instanceof Error ? error : new Error(String(error));
				}), new Promise((resolve) => setTimeout(() => resolve(void 0), 1e4))]);
			} catch (error) {
				return [{
					id: "error",
					name: `initialize threw synchronously: ${error instanceof Error ? error.message : String(error)}`
				}];
			}
			if (readyError !== void 0) return [{
				id: "error",
				name: `initialize failed: ${readyError.message}`
			}];
			if (!readySettled) {
				const authUrl = server.connection.getPendingAuthUrl();
				return [{
					id: "error",
					name: `initialize timed out after 10s — the agent may still be starting (e.g. npx fetching a package), waiting for an interactive login, or the process may have exited` + (authUrl !== void 0 ? `; a browser login is pending: ${authUrl}` : "; check the host logs for llm-acp warnings")
				}];
			}
			const info = server.connection.getServerInfo();
			if (info === void 0) return [{
				id: "error",
				name: "initialize completed but no protocol version was negotiated — the agent may have returned an invalid initialize response"
			}];
			if (info.agentInfoMissing) return [{
				id: "unknown",
				name: `agentInfo missing — initialize succeeded (protocol ${info.protocolVersion}) but the agent omitted or published an invalid agentInfo; the ACP SDK silently drops agentInfo that fails schema validation (name and version must be non-empty strings); the server may still be functional`,
				contextWindow: info.protocolVersion
			}];
			return [{
				id: info.agentName,
				name: info.agentVersion,
				contextWindow: info.protocolVersion
			}];
		}
		if (provider.startsWith(TEST_PREFIX)) {
			const serverId = provider.slice(9);
			const server = active.get(serverId);
			if (server === void 0) return [{
				id: "error",
				name: "server is not running — no active connection found for this server id; the server may have been removed or never started"
			}];
			const fail = (error) => [{
				id: "error",
				name: error instanceof Error ? error.message : String(error)
			}];
			try {
				await Promise.race([server.connection.ready, new Promise((_, reject) => setTimeout(() => reject(/* @__PURE__ */ new Error(`initialize timed out after ${TEST_INIT_TIMEOUT_MS}ms — the agent may still be starting, waiting for an interactive login, or the process may have exited; check the host logs for llm-acp warnings`)), TEST_INIT_TIMEOUT_MS))]);
			} catch (error) {
				return fail(error);
			}
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), TEST_PROMPT_TIMEOUT_MS);
			let sessionId;
			try {
				sessionId = await server.connection.newSession();
				let reply = "";
				for await (const update of server.connection.promptStream(sessionId, [{
					type: "text",
					text: "Reply with exactly: pong"
				}], controller.signal)) if (update.kind === "text") reply += update.text;
				else if (update.kind === "done") return [{
					id: "ok",
					name: reply
				}];
				else if (update.kind === "error") throw new Error(update.error.message);
				if (controller.signal.aborted) throw new Error(`prompt timed out after ${TEST_PROMPT_TIMEOUT_MS}ms — the agent accepted the prompt but did not respond within the deadline; it may be stuck on an interactive login, a permission request, or an internal error`);
				throw new Error("stream ended without a stop reason — the agent closed the prompt stream without sending a terminal update; this may indicate a crash or protocol violation");
			} catch (error) {
				return fail(error);
			} finally {
				clearTimeout(timer);
				if (sessionId !== void 0) server.connection.closeSession(sessionId);
			}
		}
		if (provider.startsWith(AUTH_PREFIX)) {
			const serverId = provider.slice(9);
			const server = active.get(serverId);
			const url = server?.connection.getPendingAuthUrl();
			if (url !== void 0 && url.length > 0) return [{
				id: "auth",
				name: url
			}];
			const method = server?.connection.getPendingAuthMethod();
			if (method !== void 0) return [{
				id: "pending",
				name: method
			}];
			return [{
				id: "none",
				name: ""
			}];
		}
		if (provider.startsWith(METHODS_PREFIX)) {
			const serverId = provider.slice(12);
			const server = active.get(serverId);
			if (server === void 0) return [{
				id: "methods",
				name: JSON.stringify({
					methods: [],
					selected: "",
					needed: false
				})
			}];
			try {
				await Promise.race([server.connection.ready, new Promise((_, reject) => setTimeout(() => reject(/* @__PURE__ */ new Error("initialize timed out")), 1e4))]);
			} catch {}
			return [{
				id: "methods",
				name: JSON.stringify(server.connection.authMethodState())
			}];
		}
		if (provider.startsWith("acp-trace-")) {
			const serverId = provider.slice(10);
			const server = active.get(serverId);
			if (server === void 0) return [{
				id: "none",
				name: "[]"
			}];
			const trace = server.connection.getProtocolTrace();
			return [{
				id: "trace",
				name: JSON.stringify(trace)
			}];
		}
		if (provider.startsWith("acp-modes-")) {
			const serverId = provider.slice(10);
			const server = active.get(serverId);
			if (server === void 0) return [];
			try {
				return (await Promise.race([server.connection.discoverModes(), new Promise((resolve) => setTimeout(() => resolve(void 0), 1e4))]) ?? []).map((m) => ({
					id: m.id,
					name: m.name
				}));
			} catch {
				return [];
			}
		}
		if (provider === "acp-dsh-presets") {
			const presets = ctx.get("permissionPresets");
			return (presets !== void 0 && presets.names.length > 0 ? [...presets.names] : [
				"read-only",
				"workspace-write",
				"danger-full-access"
			]).map((name) => ({
				id: name,
				name
			}));
		}
		if (!provider.startsWith("acp-")) return [];
		const serverId = provider.slice(4);
		const server = active.get(serverId);
		if (server === void 0) return [];
		try {
			const discovered = await Promise.race([server.connection.discoverModels(), new Promise((resolve) => setTimeout(() => resolve(void 0), 1e4))]);
			if (discovered === void 0) return [];
			return discovered.map((m) => ({
				id: m.id,
				name: m.name
			}));
		} catch {
			return [];
		}
	}), "llm-acp.modelDiscovery()");
	ctx.settings.installSection(ctx, NS, SettingsSchema, { servers: {} }, {
		setSource: (source) => {
			currentSettings = source;
		},
		onChange: () => {
			try {
				reconcileServers();
			} catch (error) {
				ctx.logger.error("llm-acp: keeping previously registered servers after a refused update");
				ctx.logger.error(error);
			}
			try {
				reconcileDirectory();
			} catch (error) {
				ctx.logger.error("llm-acp: keeping previous configurable-provider directory after a refused update");
				ctx.logger.error(error);
			}
		}
	});
	ctx.effect(() => {
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			for (const [, server] of active) {
				server.adapter.disposeSessions();
				server.registration();
				server.connection.dispose().catch(() => {});
			}
			active.clear();
		};
	});
}
//#endregion
export { AcpAdapter, AcpConnection, Config, DEFAULT_AUTH_TIMEOUT_MS, DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS, DEFAULT_INIT_TIMEOUT_MS, DEFAULT_INTERACTIVE_AUTH_TIMEOUT_MS, DEFAULT_SESSION_TIMEOUT_MS, registry_default as acpRegistry, apply, inject, name };
