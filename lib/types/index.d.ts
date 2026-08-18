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
import type { PermissionPolicy } from './types.ts';
import registryData from './registry.json';
export { AcpAdapter } from './adapter.ts';
export type { AcpAdapterOptions } from './adapter.ts';
export { AcpConnection, DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS, } from './connection.ts';
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
}
/** Plugin config: defaults applied to every spawned ACP server. */
export interface Config {
    /** How to auto-answer the child's `session/request_permission` prompts (default `reject`). */
    permission?: PermissionPolicy;
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