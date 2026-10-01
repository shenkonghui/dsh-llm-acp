/**
 * Register {@link AcpAdapter} instances on `ctx.llm` that delegate model calls
 * to external ACP servers over JSON-RPC stdio. The plugin reads configured
 * servers from its own Config (`servers`); each server spawns one long-lived
 * child process and becomes a provider route `acp-<id>`. Servers can be added
 * or removed through the ACP Servers settings page without a restart: that
 * page edits the same Config through the settings service, the Loader commits
 * the volatile reference in place, and `loader/volatile-update` triggers the
 * reconcile.
 *
 * This plugin uses named exports only; a default would hide its loader
 * metadata (see `docs/postmortem/0001-acp-default-export-drops-inject.md`).
 * @module @deepseek-ai/dsh-llm-acp
 */
import type { Context, Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import registryData from './registry.json';
export { AcpAdapter } from './adapter.ts';
export type { AcpAdapterOptions, AcpToolCallRecorder } from './adapter.ts';
export { AcpConnection, DEFAULT_AUTH_TIMEOUT_MS, DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS, DEFAULT_INIT_TIMEOUT_MS, DEFAULT_INTERACTIVE_AUTH_TIMEOUT_MS, DEFAULT_SESSION_TIMEOUT_MS, } from './connection.ts';
export type { AcpConnectionSpec, AcpPlanItem, ProtocolTraceEntry } from './connection.ts';
export type * from './types.ts';
export { registryData as acpRegistry };
export declare const name = "llm-acp";
/**
 * Required services. `settings` is deliberately absent: the configuration
 * surface is optional (a deployment without it simply keeps the composition
 * value), so the presentation policy is registered through an optional
 * `ctx.inject` in {@link apply}.
 */
export declare const inject: string[];
/**
 * One configured ACP server entry in settings.
 *
 * Every member is readonly: the value a running plugin reads comes from the
 * volatile `servers` reference, whose snapshot is deeply frozen, so a mutable
 * declaration here would not describe what the plugin actually receives.
 */
export interface AcpServerConfig {
    /** The executable to spawn (the external ACP agent server). */
    readonly command: string;
    /** Arguments passed to {@link command}. */
    readonly args: readonly string[];
    /** Human-readable display name for the provider. */
    readonly name: string;
    /**
     * Per-server environment variables merged on top of the plugin-level `env`.
     * Use this for credentials the ACP server needs (e.g. `DEEPSEEK_API_KEY`,
     * `OPENAI_API_KEY`). Per-server values override plugin-level ones.
     */
    readonly env?: Record<string, string>;
    /**
     * Model ids to expose from this server's discovered catalog. When omitted or
     * empty, every discovered model is exposed. When non-empty, only the listed
     * models (intersected with the discovered set) appear in `listModels`.
     */
    readonly models?: readonly string[];
    /**
     * User-defined models to expose in addition to (or instead of) the discovered
     * catalog. Each entry has an `id` (sent to the ACP server as the model name)
     * and a `name` (display label). Custom models with the same id as a discovered
     * model override its display name; custom models with unique ids are added.
     */
    readonly customModels?: readonly {
        readonly id: string;
        readonly name: string;
    }[];
    /**
     * Map a dsh permission preset name (or sandbox mode value) to the ACP
     * session mode applied to this server's sessions, e.g.
     * `{ "danger-full-access": "bypass" }`. Read per prompt so a mid-turn
     * preset switch reaches the next stream. Unmapped states leave the
     * server's mode untouched; servers without a `mode` config option keep
     * their own default.
     */
    readonly modeMap?: Record<string, string>;
    /**
     * Which advertised ACP auth method to log in with, e.g. `external`. Only
     * needed when the server offers a choice: a single advertised method is
     * used automatically, and a server that logs in from cached credentials or
     * env credentials never authenticates at all. Methods are not
     * interchangeable — codebuddy advertises an intranet-only `iOA` alongside a
     * public `external` — so an unset or unknown value leaves authentication
     * blocked (and the ACP Servers UI asks) rather than guessing. Changing this
     * rebuilds the server's connection, which is what actually applies it.
     */
    readonly authMethod?: string;
    /**
     * Map a dsh permission preset name (or sandbox mode value) to whether this
     * server's **subagent activity** is surfaced in the conversation, e.g.
     * `{ "danger-full-access": "silent" }`. `notice` (the default) notes a
     * subagent spawn and finish in the stream; `silent` consumes them. Read per
     * update, so changing it applies immediately and — unlike `modeMap` — never
     * rebuilds the connection.
     *
     * The rationale for mapping this at all: an ACP server runs its subagents
     * inside its own process, where the harness has no approval hook and cannot
     * intervene. A subagent is billed as its own session with its own context
     * window, so the one thing worth doing is telling a supervised session that
     * a fan-out happened, while leaving an already fully delegated one quiet.
     */
    readonly subagentMap?: Record<string, string>;
}
/**
 * Plugin config: defaults applied to every spawned ACP server.
 *
 * A `Volatile` field is one the profile's configuration layer may edit without
 * remounting the plugin: the Loader commits the new snapshot into the running
 * fiber's reference and emits `loader/volatile-update`, which is what lets the
 * ACP Servers page add or remove a server (and flip an include switch) while
 * live connections keep running. Every other field is composition-time: a
 * change to it remounts the row.
 */
export interface Config {
    /** Extra environment variables merged on top of the scrubbed parent env. */
    env?: Record<string, string>;
    /**
     * Whether to include the DSH harness system-prompt additions in the first
     * prompt of each ACP session: the `system` slot plus the harness preamble
     * user message. Default `false` — ACP agents assemble their own system
     * prompt, so the harness copy is duplicate context that persists in the
     * agent's history and is resent on every turn.
     */
    includeHarnessPrompt: Volatile<boolean>;
    /**
     * Whether to include the DSH runtime-context snapshots and the skills
     * `<system-reminder>` catalog in the prompt (default `false`). These are
     * DSH-specific concepts an external ACP agent cannot act on.
     */
    includeRuntimeContext: Volatile<boolean>;
    /** Whether to translate `agent_thought_chunk` into `reasoning-delta` chunks (default `true`). */
    emitReasoning?: boolean;
    /** Whether to surface extension progress notifications as reasoning blocks (default `false`). */
    emitProgress?: boolean;
    /**
     * Whether to surface which tool the ACP server ran as `[tool: …]` reasoning
     * notes (default `true`). Distinct from {@link emitProgress}: that one
     * carries extension log chatter (MCP server connection lines and the like),
     * while this is the structured answer to "what is it doing". Subagent
     * activity has its own switch, `servers.<id>.subagentMap`.
     */
    emitToolCalls?: boolean;
    /** Fallback model id/name when ACP model discovery returns nothing. */
    defaultModelId?: string;
    defaultModelName?: string;
    /** Grace (ms) for the child's EOF-driven quiesce on dispose; must not exceed `MAX_TIMER_DELAY_MS`. */
    disposeEofGraceMs?: number;
    /** Termination-escalation grace (ms) after SIGTERM before SIGKILL; must not exceed `MAX_TIMER_DELAY_MS`. */
    disposeGraceMs?: number;
    /**
     * Bound (ms) on the ACP `initialize` handshake plus any keyed `authenticate`
     * round; must not exceed `MAX_TIMER_DELAY_MS`. Covers `npx` cold fetches, so
     * keep it generous.
     */
    initTimeoutMs?: number;
    /**
     * Bound (ms) on `session/new`, `session/list`, and
     * `session/set_config_option`; must not exceed `MAX_TIMER_DELAY_MS`.
     */
    sessionTimeoutMs?: number;
    /**
     * Bound (ms) on one `authenticate` round — the eager keyed attempt during
     * `initialize`, or the lazy key-less attempt after a failed `session/new`;
     * must not exceed `MAX_TIMER_DELAY_MS`.
     */
    authTimeoutMs?: number;
    /**
     * Bound (ms) on one key-less interactive `authenticate` round — long enough
     * for the user to complete a browser login; when the round settles the failed
     * session call retries automatically. Must not exceed `MAX_TIMER_DELAY_MS`.
     */
    interactiveAuthTimeoutMs?: number;
    /**
     * Working directory for child processes. A relative path resolves against the
     * harness launch directory at load. When omitted, the harness process cwd is used.
     */
    cwd?: string;
    /**
     * Configured server entries keyed by server id; each becomes a provider
     * route `acp-<id>`. One map, written by whichever layer owns it: the
     * composition (bundle or profile patch) supplies the base, and the ACP
     * Servers page edits the live value through the settings service, which
     * persists it as this row's `config` in the profile patch.
     */
    servers: Volatile<Record<string, AcpServerConfig>>;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>, "defined">;
    includeHarnessPrompt: z<boolean, boolean, "volatile-defined">;
    includeRuntimeContext: z<boolean, boolean, "volatile-defined">;
    emitReasoning: z<boolean, boolean, "defined">;
    emitProgress: z<boolean, boolean, "defined">;
    emitToolCalls: z<boolean, boolean, "defined">;
    defaultModelId: z<string, string, "defined">;
    defaultModelName: z<string, string, "defined">;
    disposeEofGraceMs: z<number, number, "defined">;
    disposeGraceMs: z<number, number, "defined">;
    initTimeoutMs: z<number, number, "defined">;
    sessionTimeoutMs: z<number, number, "defined">;
    authTimeoutMs: z<number, number, "defined">;
    interactiveAuthTimeoutMs: z<number, number, "defined">;
    cwd: z<string, string, "plain">;
    servers: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<{
        command?: string | null;
        args?: string[] | null;
        name?: string | null;
        env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null;
        models?: string[] | null;
        customModels?: ({
            id?: string | null;
            name?: string | null;
        } & import("@deepseek-ai/cosmokit").Dict)[] | null;
        modeMap?: import("@deepseek-ai/cosmokit").Dict<string, string> | null;
        authMethod?: string | null;
        subagentMap?: import("@deepseek-ai/cosmokit").Dict<string, string> | null;
    } & import("@deepseek-ai/cosmokit").Dict, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<NoInfer<{
        command: z<string, string, "defined">;
        args: z<string[], string[], "defined">;
        name: z<string, string, "defined">;
        env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>, "defined">;
        models: z<string[], string[], "defined">;
        customModels: z<({
            id?: string | null;
            name?: string | null;
        } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<NoInfer<{
            id: z<string, string, "defined">;
            name: z<string, string, "defined">;
        }>>[], "defined">;
        modeMap: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>, "defined">;
        authMethod: z<string, string, "defined">;
        subagentMap: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>, "defined">;
    }>>, string>>, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>, "defined">;
    includeHarnessPrompt: z<boolean, boolean, "volatile-defined">;
    includeRuntimeContext: z<boolean, boolean, "volatile-defined">;
    emitReasoning: z<boolean, boolean, "defined">;
    emitProgress: z<boolean, boolean, "defined">;
    emitToolCalls: z<boolean, boolean, "defined">;
    defaultModelId: z<string, string, "defined">;
    defaultModelName: z<string, string, "defined">;
    disposeEofGraceMs: z<number, number, "defined">;
    disposeGraceMs: z<number, number, "defined">;
    initTimeoutMs: z<number, number, "defined">;
    sessionTimeoutMs: z<number, number, "defined">;
    authTimeoutMs: z<number, number, "defined">;
    interactiveAuthTimeoutMs: z<number, number, "defined">;
    cwd: z<string, string, "plain">;
    servers: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<{
        command?: string | null;
        args?: string[] | null;
        name?: string | null;
        env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null;
        models?: string[] | null;
        customModels?: ({
            id?: string | null;
            name?: string | null;
        } & import("@deepseek-ai/cosmokit").Dict)[] | null;
        modeMap?: import("@deepseek-ai/cosmokit").Dict<string, string> | null;
        authMethod?: string | null;
        subagentMap?: import("@deepseek-ai/cosmokit").Dict<string, string> | null;
    } & import("@deepseek-ai/cosmokit").Dict, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<NoInfer<{
        command: z<string, string, "defined">;
        args: z<string[], string[], "defined">;
        name: z<string, string, "defined">;
        env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>, "defined">;
        models: z<string[], string[], "defined">;
        customModels: z<({
            id?: string | null;
            name?: string | null;
        } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<NoInfer<{
            id: z<string, string, "defined">;
            name: z<string, string, "defined">;
        }>>[], "defined">;
        modeMap: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>, "defined">;
        authMethod: z<string, string, "defined">;
        subagentMap: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>, "defined">;
    }>>, string>>, "volatile-defined">;
}>>, "plain">;
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map