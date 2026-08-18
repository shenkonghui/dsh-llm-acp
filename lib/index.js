import { isAbsolute, resolve } from "node:path";
import { accessSync, constants, statSync } from "node:fs";
import z from "@deepseek-ai/schemastery";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
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
				code: "REFUSAL"
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
* long-lived external ACP server. One `stream()` call creates a fresh ACP
* session, sends the full conversation as a single user message, and translates
* the streamed `agent_message_chunk` / `agent_thought_chunk` updates into
* harness `StreamChunk`s. Tool-call deltas are never emitted: the ACP server
* executes its own tools internally and does not expose tool-call argument
* deltas to the client, so the harness agent loop sees a single tool-less
* assistant step per turn.
*
* @module @deepseek-ai/dsh-llm-acp/adapter
*/
/** Render the harness message history plus system prompt into one ACP text block. */
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
/** Extract the concatenated text of a harness message (non-text blocks contribute nothing). */
function messageText(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
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
	constructor(config) {
		super();
		this.config = config;
		this.models = [{
			provider: config.provider,
			id: config.defaultModel.id,
			name: config.defaultModel.name
		}];
		this.modelsReady = this.discoverModels();
	}
	/** Probe the ACP server for its model catalog and cache the result. */
	async discoverModels() {
		try {
			const discovered = await this.config.connection.discoverModels();
			if (discovered !== void 0 && discovered.length > 0) this.models = discovered.map((m) => ({
				provider: this.config.provider,
				id: m.id,
				name: m.name
			}));
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
	/**
	* Stream one model call by opening a fresh ACP session and sending the full
	* conversation as one user message. Yields `text-delta` (and optionally
	* `reasoning-delta`) chunks as the ACP server streams assistant output, then
	* a terminal `finish` chunk. Tool-call deltas are never emitted.
	*/
	async *stream(options) {
		await this.config.connection.ready;
		let sessionId;
		try {
			sessionId = await this.config.connection.newSession();
		} catch (error) {
			throw new LlmError(`llm-acp: failed to create ACP session: ${error instanceof Error ? error.message : String(error)}`, "NO_ADAPTER");
		}
		if (options.model.length > 0 && options.model !== this.config.defaultModel.id) try {
			await this.config.connection.setSessionModel(sessionId, options.model);
		} catch {}
		const prompt = renderPrompt(options);
		const emitReasoning = this.config.emitReasoning;
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
			for await (const update of this.config.connection.promptStream(sessionId, prompt, signal)) switch (update.kind) {
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
				case "done":
					yield* closeOpen();
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
			throw new LlmError(`llm-acp: stream failed: ${error instanceof Error ? error.message : String(error)}`, "SERVER");
		}
		yield* closeOpen();
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
};
//#endregion
//#region lib/types/connection.js
/**
* Long-lived ACP client connection: spawns one external ACP server subprocess
* at plugin load and drives it over JSON-RPC stdio. Each {@link AcpConnection.promptStream}
* call creates a fresh ACP session, sends one user message, and yields the
* streamed assistant text/reasoning chunks plus a terminal stop reason.
*
* The connection is deliberately stateless across prompts (no session reuse):
* every prompt creates a new ACP session and sends the full conversation as a
* single user message. This avoids cross-prompt state synchronization with the
* remote agent and stays safe under compaction/fork, at the cost of remote KV
* cache reuse.
*
* @module @deepseek-ai/dsh-llm-acp/connection
*/
/** EOF grace for child flush and nested-process teardown; wider than the signal grace. */
const DEFAULT_DISPOSE_EOF_GRACE_MS = 6e3;
/** Default POSIX grace between SIGTERM and SIGKILL on dispose. */
const DEFAULT_DISPOSE_GRACE_MS = 3e3;
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
/** Extract text from an ACP content block (non-text blocks contribute nothing). */
function acpContentText(content) {
	return content.type === "text" ? content.text : "";
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
				if (spec.permission === "allow") {
					const allow = params.options.find((o) => o.kind === "allow_once" || o.kind === "allow_always");
					if (allow !== void 0) return Promise.resolve({ outcome: {
						outcome: "selected",
						optionId: allow.optionId
					} });
				}
				return Promise.resolve({ outcome: { outcome: "cancelled" } });
			}
		});
		this.conn = new ClientSideConnection(makeClient, ndJsonStream(Writable.toWeb(this.child.stdin), Readable.toWeb(this.child.stdout)));
		this.readyPromise = this.initialize();
	}
	/** Resolves when the ACP server has completed `initialize`. */
	get ready() {
		return this.readyPromise;
	}
	async initialize() {
		const spawnFailed = this.child.done.then(() => new Promise(() => {}), (err) => Promise.reject(err instanceof Error ? err : new Error(String(err))));
		spawnFailed.catch(() => {});
		await Promise.race([this.conn.initialize({
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: {}
		}), spawnFailed]);
	}
	/** Push an inbound session/update into the owning session's queue. */
	enqueueUpdate(params) {
		const entry = this.queues.get(params.sessionId);
		if (entry === void 0) return;
		const update = params.update;
		if (update.sessionUpdate === "agent_message_chunk") entry.queue.push({
			kind: "text",
			text: acpContentText(update.content)
		});
		else if (update.sessionUpdate === "agent_thought_chunk") entry.queue.push({
			kind: "reasoning",
			text: acpContentText(update.content)
		});
		this.signal(entry);
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
		const session = await this.conn.newSession({
			cwd: this.spec.cwd,
			mcpServers: []
		});
		const returnedId = Reflect.get(session, "sessionId");
		if (typeof returnedId !== "string") throw new Error("llm-acp: ACP server published a session without a string sessionId");
		return returnedId;
	}
	/**
	* Probe the ACP server for its model catalog by creating a throwaway session
	* and reading the `configOptions` (category `model`) from the `session/new`
	* response. The probe session is closed immediately. Returns `undefined` when
	* the server publishes no model config option.
	* @returns the model entries, or `undefined` if none were advertised.
	*/
	async discoverModels() {
		await this.ready;
		const session = await this.conn.newSession({
			cwd: this.spec.cwd,
			mcpServers: []
		});
		const configOptions = Reflect.get(session, "configOptions");
		const sessionId = Reflect.get(session, "sessionId");
		if (typeof sessionId === "string") this.conn.closeSession({ sessionId }).catch(() => {});
		if (configOptions === void 0 || configOptions === null) return void 0;
		const modelOption = configOptions.find((opt) => opt.category === "model" && opt.type === "select");
		if (modelOption === void 0 || modelOption.type !== "select") return void 0;
		const options = Array.isArray(modelOption.options) ? modelOption.options : [];
		const models = [];
		for (const opt of options) if ("value" in opt && typeof opt.value === "string" && typeof opt.name === "string") models.push({
			id: opt.value,
			name: opt.name
		});
		return models.length > 0 ? models : void 0;
	}
	/**
	* Set the model for one ACP session via `session/set_config_option`. Best-effort:
	* if the server rejects the config id or value, the error surfaces from the
	* caller. Only called when the model differs from the server's current value.
	* @param sessionId - the remote session id from {@link AcpConnection.newSession}.
	* @param modelId - the model value id to select.
	*/
	async setSessionModel(sessionId, modelId) {
		await this.conn.setSessionConfigOption({
			sessionId,
			configId: "model",
			value: modelId
		});
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
	*/
	async *promptStream(sessionId, prompt, signal) {
		const entry = {
			queue: [],
			resolve: void 0
		};
		this.queues.set(sessionId, entry);
		const onAbort = () => {
			this.conn.cancel({ sessionId }).catch(() => {});
		};
		signal.addEventListener("abort", onAbort, { once: true });
		this.conn.prompt({
			sessionId,
			prompt
		}).then((result) => {
			const stopReason = Reflect.get(result, "stopReason");
			entry.queue.push({
				kind: "done",
				reason: stopReason ?? "end_turn"
			});
			this.signal(entry);
		}, (err) => {
			const error = err instanceof Error ? err : new Error(String(err));
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
			this.queues.delete(sessionId);
		}
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
const inject = ["llm", "subprocess"];
/** Settings namespace owned by this plugin. */
const NS = settingsNamespace("llm-acp");
const Config = z.object({
	permission: z.union(["allow", "reject"]).default("reject"),
	env: z.dict(z.string()).default({}),
	emitReasoning: z.boolean().default(false),
	defaultModelId: z.string().default("devin"),
	defaultModelName: z.string().default("Devin (ACP)"),
	disposeEofGraceMs: z.number().default(DEFAULT_DISPOSE_EOF_GRACE_MS),
	disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
	cwd: z.string(),
	servers: z.dict(z.object({
		command: z.string().required(),
		args: z.array(z.string()).default([]),
		name: z.string().required()
	})).default({})
});
/** Settings schema: a map of server ids to their spawn configuration. */
const SettingsSchema = z.object({ servers: z.dict(z.object({
	command: z.string().required(),
	args: z.array(z.string()).default([]),
	name: z.string().required()
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
/** Provider route name for one server id. */
function routeName(serverId) {
	return `acp-${serverId}`;
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
	const cwd = config.cwd === void 0 || config.cwd === "" ? process.cwd() : assertUsableCwd("config cwd", resolve(config.cwd));
	/** Current settings source; updated by `installSettingsSection`. */
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
	/** Create one ACP connection + adapter for a server. */
	function createServer(serverId, server) {
		const connection = new AcpConnection({
			command: server.command,
			args: server.args,
			cwd,
			permission: resolved.permission,
			env: resolved.env,
			disposeEofGraceMs: resolved.disposeEofGraceMs,
			disposeGraceMs: resolved.disposeGraceMs,
			spawn: (spec) => ctx.subprocess.spawn(spec),
			onWarn: (message) => ctx.logger.warn(message)
		});
		const adapter = new AcpAdapter({
			connection,
			provider: routeName(serverId),
			emitReasoning: resolved.emitReasoning,
			defaultModel: {
				id: resolved.defaultModelId,
				name: resolved.defaultModelName
			}
		});
		return {
			connection,
			registration: ctx.llm.registerAdapter([routeName(serverId)], adapter)
		};
	}
	/** Reconcile active connections with the current server set. */
	function reconcileServers() {
		const desired = mergedServers();
		const desiredIds = new Set(desired.keys());
		for (const [id, server] of active) if (!desiredIds.has(id)) {
			server.registration();
			server.connection.dispose().catch((error) => {
				ctx.logger.warn(`llm-acp: connection disposal for "${id}" failed: ${error instanceof Error ? error.message : String(error)}`);
			});
			active.delete(id);
		}
		for (const [id, server] of desired) if (!active.has(id)) try {
			active.set(id, createServer(id, server));
		} catch (error) {
			ctx.logger.error(`llm-acp: failed to create server "${id}": ${error instanceof Error ? error.message : String(error)}`);
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
	installSettingsSection(ctx, NS, SettingsSchema, { servers: {} }, {
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
				server.registration();
				server.connection.dispose().catch(() => {});
			}
			active.clear();
		};
	});
}
//#endregion
export { AcpAdapter, AcpConnection, Config, DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS, registry_default as acpRegistry, apply, inject, name };
