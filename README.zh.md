# @deepseek-ai/dsh-llm-acp

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 ACP 客户端 LLM 适配器 + ACP 服务设置界面。通过外部 [Agent Client Protocol](https://agentclientprotocol.com) 服务器作为模型提供方接入 harness 的 LLM 层，并提供一个 Web 设置页面用于浏览 ACP 注册表和管理已配置的服务器。

本包是一个**双面 dsh 插件**：宿主端（`lib/index.js`）是传输适配器，在 `ctx.llm` 上注册 provider 路由；客户端（`lib/client.js`）是浏览器设置页面，让用户从 Web UI 浏览 ACP 注册表并添加/删除 ACP agent 服务器。

## 安装

```sh
dsh plugin --profile my-acp add github:shenkonghui/dsh-llm-acp
```

或从本地目录安装：

```sh
dsh plugin --profile my-acp add ./dsh-llm-acp
```

构建产物（`lib/`）已提交到仓库，安装时无需运行任何构建脚本。

## 卸载

```sh
dsh plugin --profile my-acp remove @deepseek-ai/dsh-llm-acp
```

这会从 profile 中移除依赖和 bundle 层。

## 配置

安装后，在 Web UI 中打开 **设置 → ACP 服务**。浏览 ACP 注册表，在任意 agent（如 Devin、Codex、Claude Agent）上点击 **添加**，即可将其配置为 ACP 服务器。每个已配置的服务器会创建一个独立的 provider 路由 `acp-<server-id>`。

在 **我的服务** 标签页中，点击任意已配置服务器上的 **编辑** 按钮，可以：
- 设置**环境变量**用于认证（如 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY`）。每个服务器的环境变量会与插件级 `env` 合并，服务级优先。
- 选择要**启用的模型**。从服务器发现的模型目录中多选要暴露的模型，不选则启用全部已发现的模型。

也可以直接在 `settings.yaml` 中配置：

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

## 工作原理

### 宿主端 — LLM 适配器

`apply(ctx, config)` 从 `llm-acp` 设置命名空间读取已配置的服务器列表。对每个服务器，启动一个长生命周期的子进程，通过 stdin/stdout 建立 ACP `ClientSideConnection`，并在 `ctx.llm` 上注册路由为 `acp-<server-id>` 的 `AcpAdapter`。每次模型调用会创建新的 ACP session，将完整对话作为一条用户消息发送，并将流式 `agent_message_chunk` 更新转换为 harness 的 `StreamChunk`。

### 客户端 — 设置界面

浏览器端注册一个 `settings.section` slot，渲染 ACP 注册表浏览器和"我的服务"列表。添加服务器时会将其持久化到 `llm-acp` 设置命名空间；宿主端监听变更并同步更新 provider 目录。

### 注册表命令推导

ACP 注册表指定了不同的分发类型：

| 类型 | 命令 |
|---|---|
| `npx` | `npx -y <package> ...args` |
| `uvx` | `uvx <package> ...args` |
| `binary` | 取注册表 `cmd` 的 basename（如 `./bin/devin` → `devin`） |

binary 类型使用可执行文件的 basename，这样已安装到 PATH 的二进制文件可以直接找到，避免 `spawn ./bin/devin ENOENT` 错误。

## 配置项

| 配置 | 默认值 | 说明 |
|---|---|---|
| `permission` | `allow` | 自动应答 `session/request_permission`：`reject` 拒绝所有请求，`allow` 选择第一个 `allow_once`/`allow_always` 选项。 |
| `emitReasoning` | `true` | 是否将 `agent_thought_chunk` 和扩展进度通知转换为 `reasoning-delta` chunk。 |
| `defaultModelId` | `glm-5-2` | ACP 发现未返回模型时的回退模型 ID。 |
| `defaultModelName` | `GLM-5.2 High` | 回退模型显示名称。 |
| `disposeEofGraceMs` | `6000` | stdin EOF 后等待平台终止的宽限时间（毫秒）。 |
| `disposeGraceMs` | `3000` | SIGTERM 后等待 SIGKILL 的 POSIX 宽限时间（毫秒）。 |

## 协议契约

每次 `stream()` 调用：

1. 创建新的 ACP `session/new`，使用配置的 `cwd`。
2. 将 harness 的 `messages` 和 `system` prompt 渲染为一条 ACP 文本块。
3. 发送 `session/prompt`，将流式 `agent_message_chunk` 更新作为 `text-delta` chunk 传输。
4. 当 `emitReasoning` 开启时，`agent_thought_chunk` 更新转换为 `reasoning-delta` chunk。
5. `session/prompt` 响应的终态 `stopReason` 转换为 `finish` chunk。

工具调用增量不会被输出。ACP 服务器内部执行自己的工具。

### 停止原因映射

| ACP | Harness finish |
|---|---|
| `end_turn` | `stop` |
| `max_tokens` | `max-tokens` |
| `refusal` | `error`（code `REFUSAL`） |
| `cancelled` | `aborted` |
| `max_turn_requests` / 未知 | `error` |

## 构建

```sh
pnpm install
pnpm build    # tsc -b && tsdown
```

构建产物已提交到仓库，用户安装时只需 `pnpm install` 即可。

## 已知限制与待办事项

- **不支持 harness 工具生态** — ACP 服务器执行自己的工具；harness 的 `GenerateOptions.tools` 被忽略。
- **无 session 复用** — 每次 `stream()` 调用创建新的 ACP session 并重新发送完整对话。
- **无 token 用量** — ACP v1 不提供 token 计数；适配器不输出 `usage` chunk。
- **系统提示在消息体内** — ACP `session/new` 没有 system 槽位，harness 的 system prompt 被拼接到用户消息文本前。
- **全量历史重发** — 适配器将整个 `messages` 数组渲染为一条用户消息。
- **ACP v1（SDK 0.25.1）** — 适配器使用 `@agentclientprotocol/sdk` 0.25.1，其 `session/prompt` 响应携带终态 `stopReason`（v1 契约）。
- **扩展协议处理** — Devin 的 `_cognition.ai/*` 通知被静默消费（进度文本在 `emitReasoning` 开启时作为 reasoning 输出）；其他非标准 ACP 扩展被吞掉以避免 SDK 错误日志。

## 许可证

MIT
