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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import registryData from './registry.json';
export { AcpAdapter } from './adapter.ts';
export type { AcpAdapterOptions } from './adapter.ts';
export { AcpConnection, DEFAULT_AUTH_TIMEOUT_MS, DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS, DEFAULT_INIT_TIMEOUT_MS, DEFAULT_SESSION_TIMEOUT_MS, } from './connection.ts';
export type { AcpConnectionSpec } from './connection.ts';
export type * from './types.ts';
export { registryData as acpRegistry };
export declare const name = "llm-acp";
export declare const inject: string[];
/** One configured ACP server entry in settings. */
export interface AcpServerConfig {
    /** The executable to spawn (the external ACP agent server). */
    command: string;
    /** Arguments passed to {@link command}. */
    args: string[];
    /** Human-readable display name for the provider. */
    name: string;
    /**
     * Per-server environment variables merged on top of the plugin-level `env`.
     * Use this for credentials the ACP server needs (e.g. `DEEPSEEK_API_KEY`,
     * `OPENAI_API_KEY`). Per-server values override plugin-level ones.
     */
    env?: Record<string, string>;
    /**
     * Model ids to expose from this server's discovered catalog. When omitted or
     * empty, every discovered model is exposed. When non-empty, only the listed
     * models (intersected with the discovered set) appear in `listModels`.
     */
    models?: string[];
    /**
     * User-defined models to expose in addition to (or instead of) the discovered
     * catalog. Each entry has an `id` (sent to the ACP server as the model name)
     * and a `name` (display label). Custom models with the same id as a discovered
     * model override its display name; custom models with unique ids are added.
     */
    customModels?: {
        id: string;
        name: string;
    }[];
}
/** Plugin config: defaults applied to every spawned ACP server. */
export interface Config {
    /** Extra environment variables merged on top of the scrubbed parent env. */
    env?: Record<string, string>;
    /** Whether to translate `agent_thought_chunk` into `reasoning-delta` chunks (default `false`). */
    emitReasoning?: boolean;
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
     * Bound (ms) on `session/new`, `session/load`, `session/list`, and
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
     * Working directory for child processes. A relative path resolves against the
     * harness launch directory at load. When omitted, the harness process cwd is used.
     */
    cwd?: string;
    /**
     * Inline server entries composed at load time (in addition to settings).
     * Each entry becomes a provider route `acp-<id>`.
     */
    servers?: Record<string, AcpServerConfig>;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map