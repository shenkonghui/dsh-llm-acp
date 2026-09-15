# @deepseek-ai/dsh-llm-acp

[中文](README.md) | English

ACP-client LLM adapter + ACP Servers settings UI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Drives an external [Agent Client Protocol](https://agentclientprotocol.com) server as a model provider on the harness LLM seam, with a web settings page for browsing the ACP registry and managing configured servers.

This package is a **dual-face dsh plugin**: the host half (`lib/index.js`) is a transport adapter that registers provider routes on `ctx.llm`; the client half (`lib/client.js`) is a browser settings section that lets users browse the ACP registry and add/remove ACP agent servers from the web UI.

## Install

```sh
dsh plugin --profile my-acp add github:shenkonghui/dsh-llm-acp
```

Or from a local checkout:

```sh
dsh plugin --profile my-acp add ./dsh-llm-acp
```

Built artifacts (`lib/`) are committed to the repository, so no build scripts run during install.

## Uninstall

```sh
dsh plugin --profile my-acp remove @deepseek-ai/dsh-llm-acp
```

This removes the dependency and the bundle layer from the profile.

## Configure

After installation, open **Settings → ACP Servers** in the web UI. Browse the ACP registry, click **添加** on any agent (e.g. Devin, Codex, Claude Agent), and it becomes a configured ACP server. Each configured server creates an independent provider route `acp-<server-id>`.

In the **My Servers** tab, click **Edit** on any configured server to:
- Set **environment variables** for authentication (e.g. `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`). Per-server env is merged on top of the plugin-level `env`.
- Select which **models** to expose from the server's discovered catalog. Leave empty to expose all discovered models.

ACP servers do not store separate permission policies. They use the existing session permission list: `read-only` and `workspace-write` forward sensitive operations to the harness approval UI, while `danger-full-access` allows them automatically.

Alternatively, configure servers directly in `settings.yaml`:

```yaml
llm-acp:
  servers:
    devin:
      command: devin
      args:
        - acp
      name: Devin
      env:
        DEEPSEEK_API_KEY: sk-xxx
      models:
        - deepseek-chat
        - deepseek-reasoner
```

## How it works

### Host half — LLM adapter

`apply(ctx, config)` reads the `llm-acp` settings namespace for configured servers. For each server, it spawns a long-lived child process, opens an ACP `ClientSideConnection` over stdin/stdout, and registers an `AcpAdapter` on `ctx.llm` under route `acp-<server-id>`. Each model call opens a fresh ACP session, sends the full conversation as one user message, and translates streamed `agent_message_chunk` updates into harness `StreamChunk`s.

### Client half — Settings UI

The browser half registers a `settings.section` slot that renders the ACP registry browser and a "My Servers" list. Adding a server persists it to the `llm-acp` settings namespace; the host half observes the change and reconciles its provider directory.

### Registry command derivation

The ACP registry specifies distribution types:

| Type | Command |
|---|---|
| `npx` | `npx -y <package> ...args` |
| `uvx` | `uvx <package> ...args` |
| `binary` | basename of the registry's `cmd` (e.g. `./bin/devin` → `devin`) |

Binary entries use the executable basename so a PATH-installed binary is found directly, avoiding `spawn ./bin/devin ENOENT`.

## Config

| Config | Default | Meaning |
|---|---|---|
| `emitReasoning` | `true` | Whether `agent_thought_chunk` and extension progress notifications become `reasoning-delta` chunks. |
| `defaultModelId` | `devin` | Fallback model id when ACP discovery returns no models. |
| `defaultModelName` | `Devin (ACP)` | Fallback model display name. |
| `disposeEofGraceMs` | `6000` | Positive grace after stdin EOF before platform termination. |
| `disposeGraceMs` | `3000` | Positive POSIX grace after SIGTERM before SIGKILL. |
| `initTimeoutMs` | `120000` | Bound on the `initialize` handshake (plus any keyed `authenticate` round). |
| `sessionTimeoutMs` | `60000` | Bound on `session/new`, `session/load`, `session/list`, and `session/set_config_option`. |
| `authTimeoutMs` | `15000` | Bound on one `authenticate` round. |

## Protocol contract

Each `stream()` call:

1. Creates a fresh ACP `session/new` with the configured `cwd`.
2. Renders the harness `messages` plus `system` prompt into one ACP text block.
3. Sends `session/prompt` and streams `agent_message_chunk` updates as `text-delta` chunks.
4. When `emitReasoning` is on, `agent_thought_chunk` updates become `reasoning-delta` chunks.
5. A `usage_update` notification becomes a `usage` chunk (`inputTokens` is the server-reported context occupancy) and its `size` is remembered as the route's `context.contextWindow`.
6. The terminal `session/prompt` response `stopReason` becomes the `finish` chunk.

Tool-call deltas are never emitted. The ACP server executes its own tools internally. A `usage` chunk is reported for conversation calls only: an auxiliary call (compaction, session-title) renders a purpose-built prompt whose occupancy would displace the real sample. `session/request_permission` follows the current session permission preset: `danger-full-access` allows automatically, while other presets use a one-shot harness approval request. Unavailable or failing approval and ACP requests without `allow_once` fail closed.

### Stop-reason mapping

| ACP | Harness finish |
|---|---|
| `end_turn` | `stop` |
| `max_tokens` | `max-tokens` |
| `refusal` | `error` (code `REFUSAL`) |
| `cancelled` | `aborted` |
| `max_turn_requests` / unknown | `error` |

## Build

```sh
pnpm install
pnpm build    # tsc -b && tsdown
```

Built artifacts are committed to the repository, so `pnpm install` alone is sufficient for consumers.

## Known Limitations and Deferred Work

- **No harness tool ecosystem** — the ACP server executes its own tools; harness `GenerateOptions.tools` is ignored.
- **Context occupancy without output accounting** — ACP's `usage_update` reports only the tokens currently in context (`used`) and the context window (`size`); it carries no response-token count. The adapter therefore emits a `usage` chunk with `inputTokens = used` and `outputTokens = 0`, and advertises `context.contextWindow` from `resolveModel`, which lights up the harness's context-occupancy ring while cumulative output tokens stay at 0. The figure describes the ACP server's own context, not the harness-side prompt projection. How the window falls back:

- No capacity is advertised before the server reports a sample, so the first request's ring does not render (the harness will not invent a 0%); the next request picks it up.
- A sample reported from `session/new` counts too, even when no prompt is consuming that session (the throwaway model-discovery probe).
- A later sample with an unusable window (not a positive integer) keeps the last known value instead of blanking an already-lit ring.
- A later sample with a new usable window replaces it, so switching to a larger model shows up immediately.
- Switching to another provider route that has not reported yet makes the harness clear the old capacity rather than reuse the previous server's window.
- **System prompt is in-band** — ACP `session/new` has no system slot, so the harness system prompt is prepended to the user message text.
- **Full-history re-send without `session/load`** — when the agent does not advertise `loadSession`, the adapter renders the entire `messages` array into one user message per call.
- **ACP v1 (SDK 0.25.1)** — the adapter uses `@agentclientprotocol/sdk` 0.25.1, whose `session/prompt` response carries the terminal `stopReason` (v1 contract).
- **Extension protocol handling** — Devin's `_cognition.ai/*` notifications are consumed silently (progress text surfaced as reasoning when `emitReasoning` is on); other non-standard ACP extensions are swallowed to prevent SDK error logs.
- **Lazy authentication** — with no configured API key, `authenticate` is not called up front: servers accepting env credentials or a cached login go straight to `session/new`. Only a failed `session/new`/`session/load` triggers one bounded (`authTimeoutMs`) `authenticate` round plus a retry, so an interactive browser login only fires when genuinely required; the URL is surfaced via the warning log and the `acp-auth-<id>` settings route.
- **Several login methods require a choice, never a guess** — when a server advertises more than one method (codebuddy offers `iOA`, reachable only from its intranet, alongside the public `external`), the adapter no longer takes the first: with nothing selected it starts no `authenticate` round, fails fast, and the conversation raises a picker fed by the `acp-methods-<id>` route. The pick is stored in `servers.<id>.authMethod` and can be changed later under Settings → ACP Servers. **A single advertised method is used automatically**, and a selection the server does not advertise counts as unselected (never a fallback to the first). Changing the selection rebuilds that server's connection, which applies the new method and abandons an `authenticate` round still hung on the old one. The eager keyed round resolves through the same rule, so a configured API key no longer picks a method on your behalf.

## License

MIT
