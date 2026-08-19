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
| `permission` | `allow` | Auto-answer `session/request_permission`: `reject` declines every prompt, `allow` selects the first `allow_once`/`allow_always` option. |
| `emitReasoning` | `true` | Whether `agent_thought_chunk` and extension progress notifications become `reasoning-delta` chunks. |
| `defaultModelId` | `glm-5-2` | Fallback model id when ACP discovery returns no models. |
| `defaultModelName` | `GLM-5.2 High` | Fallback model display name. |
| `disposeEofGraceMs` | `6000` | Positive grace after stdin EOF before platform termination. |
| `disposeGraceMs` | `3000` | Positive POSIX grace after SIGTERM before SIGKILL. |

## Protocol contract

Each `stream()` call:

1. Creates a fresh ACP `session/new` with the configured `cwd`.
2. Renders the harness `messages` plus `system` prompt into one ACP text block.
3. Sends `session/prompt` and streams `agent_message_chunk` updates as `text-delta` chunks.
4. When `emitReasoning` is on, `agent_thought_chunk` updates become `reasoning-delta` chunks.
5. The terminal `session/prompt` response `stopReason` becomes the `finish` chunk.

Tool-call deltas are never emitted. The ACP server executes its own tools internally.

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
- **No session reuse** — every `stream()` call creates a fresh ACP session and re-sends the full conversation.
- **No token usage** — ACP v1 does not deliver token accounting; the adapter emits no `usage` chunk.
- **System prompt is in-band** — ACP `session/new` has no system slot, so the harness system prompt is prepended to the user message text.
- **Full-history re-send** — the adapter renders the entire `messages` array into one user message.
- **ACP v1 (SDK 0.25.1)** — the adapter uses `@agentclientprotocol/sdk` 0.25.1, whose `session/prompt` response carries the terminal `stopReason` (v1 contract).
- **Extension protocol handling** — Devin's `_cognition.ai/*` notifications are consumed silently (progress text surfaced as reasoning when `emitReasoning` is on); other non-standard ACP extensions are swallowed to prevent SDK error logs.

## License

MIT
