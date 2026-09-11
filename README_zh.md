# Command Code Proxy

> [English Docs](README.md)

将 Command Code API 转换为 OpenAI / Anthropic 兼容接口的反代代理。单文件，零外部依赖。

基于对官方 CLI 网络流量的分析，精确还原了 Command Code API 的请求协议（含设备指纹与生命周期预请求），并实现了多层兼容适配。

**完整功能**：内置 cmd 交互式控制台（TUI，可直接查看当前套餐可用模型）| OpenAI Chat Completions + Anthropic Messages API | 流式/非流式输出 | 工具调用 (tool_use) | 多模态图片输入 | 推理强度 (reasoning_effort) | 动态模型列表 | 缓存命中指标 | 设备指纹伪装（per-key 绑定、自动刷新）| `x-api-key` 鉴权（Anthropic SDK）| 客户端断连检测（上游中止） | 零输出 → 429 自动重试 | 连续超时 → 429 自动重试 | 隐私保护日志

**社区**: [Linux.do](https://linux.do) — 一个友好的中文技术社区。

## 快速开始

```bash
npm start        # 启动（仓库自带 config.json，监听 http://0.0.0.0:3050）并进入交互式控制台
npm run dev      # watch 模式（文件修改自动重启）
node proxy.mjs   # 等价启动；不想让 npm 在 C 盘写日志时用这条
```

启动后 cmd 里是一个带序号的菜单：输入 `1` 即可列出**当前 API Key 对应套餐**可用的模型。想只要纯日志（不要控制台）加 `--no-tui`：

```bash
node proxy.mjs --no-tui
```

API Key 通过 `Authorization` 请求头（Anthropic SDK 可用 `x-api-key`）传入，**无需配置到文件中**。Key 必须以 `user_` 开头（自动匹配任意前缀，如 `Bearer token_user_xxx`）：

```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

## 文件结构

```
commandcode/
├── config.json           # 端口 / 日志路径等
├── config.local.json     # 本地覆盖（可选，控制台保存的 API Key；已 gitignore / dockerignore）
├── LICENSE               # MIT License
├── package.json          # npm start / npm run dev
├── proxy.mjs             # 单文件核心代理 + 交互式控制台（~2600 行）
├── Dockerfile            # 容器构建文件（node:22-alpine）
├── docker-compose.yml    # 容器编排
├── .dockerignore         # 构建上下文排除规则
├── .github/
│   └── workflows/
│       └── docker-publish.yml  # 打 v* tag 时自动发布 GHCR 多架构镜像
├── test/
│   ├── mock-cc-server.mjs      # 链路端到端场景测试（模拟上游，免 Key）
│   └── tui-smoke.mjs           # cmd TUI 冒烟测试（模型列表 / 回退提示 / Key 输入）
├── captured-requests/    # CLI 抓包数据（协议逆向参考）
├── README.md             # 英文文档
└── README_zh.md          # 本文档（中文）
```

## 交互式控制台（cmd TUI）

`npm start` / `node proxy.mjs` 在**交互式终端**里会自动进入带序号的菜单；stdout 不是 TTY（Docker、CI、重定向）时自动关闭，行为与旧版一致。

```
────────────────────────────────────────────────────────────
 Command Code → OpenAI / Anthropic 代理 · 控制台
 服务 http://0.0.0.0:3050 │ 运行 3m12s │ 已处理请求 128
 API Key user_****a1b2 （来源: config.local.json）
────────────────────────────────────────────────────────────
 [1] 查看当前套餐可用模型
 [2] 强制刷新模型列表（跳过 5 分钟缓存）
 [3] 查看当前套餐额度
 [4] 服务状态与配置
 [5] 设置 / 更换 API Key
 [6] 查看最近日志
 [7] 清屏
 [8] 强制刷新额度（跳过缓存）
 [0] 退出（停止代理）
请输入序号 >
```

| 序号 | 作用 |
|------|------|
| `1` | 列出**当前套餐可用模型**（`GET {apiBase}/provider/v1/models`，按 Key 区分套餐），带序号、模型 ID、备注 |
| `2` | 跳过 5 分钟缓存重新拉取（刚升级/换套餐后用） |
| `3` | 查看**当前套餐额度**：套餐名 / 订阅状态 / 剩余额度 / 额度池 / 本期已用 + 进度条 / 计费周期与剩余天数。30 秒内重复按直接复用缓存；想立刻刷新用 `[8]` |
| `4` | 监听地址、运行时长、上游 API、模型来源与缓存、请求计数 |
| `5` | 设置 / 更换 API Key（输入不回显；可选择性写入项目内 `config.local.json`） |
| `6` | 最近 40 条日志（内存环形缓冲，最多 300 条，不落盘） |
| `7` | 清屏 |
| `8` | 强制刷新额度（跳过 30 秒缓存） |
| `0` | 退出并停止代理（`q` / `exit` 等价）；Ctrl+C 连按两次也可退出 |

**[3] 套餐额度的效果：**

```
当前套餐额度
 套餐：Go（active）   标称额度 $10.00/月
 账号：your-name
 剩余：$5.04 / 额度池 $10.00
 已用：$4.95  [██████████░░░░░░░░░░] 49.6%
       其中 月度 $5.04 · 加油包 $0.00 · 赠送 $0.00
 周期：2026/8/25 14:03:54 → 2026/9/25 14:03:54 · 还剩 15 天

 数据来源: CC 账单接口 · 刚刚拉取（耗时 4s）
```

额度数据取自 CC 服务端（与官方 CLI 的 `/usage` 面板同一批接口：`/alpha/whoami`、`/alpha/billing/credits`、`/alpha/billing/subscriptions`、`/alpha/usage/summary`），只读 GET，不消耗额度。计算方法与 CLI 的 `projectUsageView` 一致：

- **剩余** = 月度剩余 + 加油包剩余 + 赠送剩余；
- **额度池** = 订阅有效时 `max(套餐标称额度, 月度剩余)` + 加油包 + 赠送，否则 = 已用 + 剩余；
- **已用** = 本计费周期起点以来的 `totalCost`。

**关于慢**：这几个账单接口本身就很慢（实测 `whoami` 7~17s、`subscriptions` 最高 20s+、`summary` ~8s，而 DNS 只要 2ms——慢在 CC 服务端，不是本地网络）。因此：

- 请求改为**并行**（以前是串行，实测最坏要 47 秒），总耗时只取决于最慢的那个；
- 单个请求超时放宽到 **45 秒**，可在 `config.json` 用 `quotaTimeoutMs` 调整，或用环境变量 `CC_QUOTA_TIMEOUT_MS`；
- 等待期间每 5 秒打印一次「仍在读取（已等待 Ns）」，不会看起来像卡死；
- `orgId` 会记住（首次发现组织后，后续刷新直接带上，省掉一轮往返）；
- 拿不到数据时如实报错并给出排查建议（例如超时会指出是哪个端点、可调大 `quotaTimeoutMs`），**绝不编造数字**；某个接口单独失败时，其余数据照常显示，缺失的那块列在「部分数据未取到」里；刷新失败但手里有旧数据时会明确标注"以上为 Ns 前的旧数据"。若服务端返回 `windowLimits` 限流窗口，也会一并列出。

要点：

- **每次操作输出完会自动重新打印一遍菜单**，列表/日志滚过屏幕后不用往上翻就能接着选。
- **模型列表来源如实标注**：成功时显示 `数据来源: Provider API`；失败（Key 无效 401、网络错误、关闭了 `useProviderModels`）会明确提示原因，并说明下面列的是**内置参考列表**，可能包含当前套餐不可用的模型。内置列表是离线兜底用的，可能落后于线上（线上有几十个模型），有 Key 时以 `[1]` 的实时结果为准。
- **API Key 解析顺序**：环境变量 `CC_API_KEY` / `COMMANDCODE_API_KEY` → 项目内 `config.local.json` → `config.json` → 菜单 `[4]` 手动输入。请求侧（`Authorization` / `x-api-key`）仍然照旧，与控制台无关。终端里连续粘贴多份相同的 Key 会自动合并为一份（会明确提示），不会存成一把超长废 Key。
- **不写 C 盘**：控制台自身不落任何文件（readline 历史仅存在内存里）；只有你在菜单 `[4]` 里选择 `y` 时，才会把 Key 写进**项目目录内**的 `config.local.json`（该文件已在 `.gitignore` / `.dockerignore` 里排除，不会被提交或打进镜像）。不会碰 `%APPDATA%` / `%TEMP%` / 家目录 / 注册表。
- **日志不撕界面**：代理运行日志、上游错误都会先清掉当前输入行再打印，然后重绘 `请输入序号 >`，可以边跑边看日志。
- **退出干净**：退出前会等在途的上游请求收尾并排空 stdout，避免 Windows 上硬退撞 libuv 断言（退出码 `0xC0000409`）。

### 控制台相关环境变量

| 变量 | 说明 |
|------|------|
| `CC_TUI` | `1`/`on`/`force` 强制启用，`0`/`off` 强制关闭；默认"是 TTY 就启用" |
| `CC_API_KEY` | 控制台与 `[1]` 模型列表使用的 API Key（等价 `COMMANDCODE_API_KEY`） |
| `NO_COLOR` | 设为任意值即关闭颜色（非 TTY 下本来就不上色） |
| `--no-tui` / `--tui` | 命令行开关，优先级高于 `CC_TUI` |

## 配置

### config.json

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `port` | `3000` | 监听端口（仓库自带 config.json 为 3050） |
| `host` | `0.0.0.0` | 监听地址 |
| `apiBase` | `https://api.commandcode.ai` | CC API 地址 |
| `projectSlug` | `cc-proxy` | `x-project-slug` header |
| `apiKey` | `""` | 可选兜底 API Key（请求也可通过 header 传入） |
| `logFile` | `""` | 日志文件路径（空=仅控制台） |
| `logLevel` | `info` | 日志级别 |
| `useProviderModels` | `true` | 从 Provider API 动态拉取模型列表 |
| `modelRefreshIntervalMs` | `300000` | 模型列表缓存刷新间隔（5min） |
| `quotaTimeoutMs` | `45000` | 账单接口单请求超时（这几个接口实测 8~20s，别调太小） |

另有可选的 `config.local.json`：字段与 `config.json` 完全一致，**优先级更高**（先读 `config.json`，再用它覆盖）。控制台 `[4]` 保存的 API Key 就落在这里；该文件已在 `.gitignore` / `.dockerignore` 中排除，不会被提交或打进镜像。

### 环境变量

| 变量 | 对应 config 字段 |
|------|-----------------|
| `PORT` | `port` |
| `HOST` | `host` |
| `CC_API_BASE` | `apiBase` |
| `PROJECT_SLUG` | `projectSlug` |
| `LOG_FILE` | `logFile` |
| `CC_USE_PROVIDER_MODELS` | `useProviderModels` |
| `CC_TUI` | 强制开/关交互式控制台（见上文） |
| `CC_API_KEY` | 控制台用的 API Key（不参与请求侧鉴权） |
| `CC_QUOTA_TIMEOUT_MS` | 账单接口超时（等价 `quotaTimeoutMs`） |

## API 接口

### `POST /v1/chat/completions`

OpenAI Chat Completions 兼容。支持流式和非流式、工具调用、多模态图片输入、推理强度。

**请求体参数：**

| 参数 | 必填 | 说明 |
|------|------|------|
| `model` | 是 | 模型 ID（见模型列表） |
| `messages` | 是 | 对话消息，支持 `system/user/assistant/tool` 角色 |
| `max_tokens` | 否 | 最大生成 token（默认 64000） |
| `stream` | 否 | 是否 SSE 流式（默认 false） |
| `temperature` | 否 | 采样温度（0-2）|
| `reasoning_effort` | 否 | 推理强度 `low`/`medium`/`high`/`max` |
| `tools` | 否 | 工具定义（OpenAI function calling 格式）|
| `tool_choice` | 否 | 工具选择策略 |
| `parallel_tool_calls` | 否 | 是否允许并行工具调用 |

**简单请求：**
```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [{ "role": "user", "content": "hello" }],
  "stream": true
}
```

**多模态图片输入（需 vision 模型）：**
```json
{
  "model": "xiaomi/mimo-v2.5",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "描述这张图片" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
    ]
  }]
}
```

**工具调用：**
```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [...],
  "tools": [{
    "type": "function",
    "function": { "name": "get_weather", "description": "...", "parameters": {...} }
  }],
  "tool_choice": "auto"
}
```

**流式响应（SSE）：**
```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"思考过程"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"prompt_tokens_details":{"cached_tokens":8}}}

data: [DONE]
```

**非流式响应（含缓存命中）：**
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "deepseek/deepseek-v4-flash",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello!",
      "reasoning_content": "The user said hello, I should respond."
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 7558,
    "completion_tokens": 42,
    "total_tokens": 7600,
    "prompt_tokens_details": { "cached_tokens": 7552 }
  }
}
```

### `POST /v1/messages`

Anthropic Messages API 兼容端点。支持流式和非流式、工具调用。

**请求体：**
```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1000,
  "system": "你是一个有用的助手。",
  "messages": [
    { "role": "user", "content": "hello" }
  ],
  "stream": true
}
```

**Anthropic 协议差异（自动转换）：**

| 概念 | Anthropic 原始格式 | 转换说明 |
|------|-------------------|----------|
| System prompt | 顶层 `system` 字段 | 自动转为 OpenAI `system` message |
| 消息内容 | `content` 数组（text/tool_use/tool_result） | 自动映射为对应角色 |
| 工具结果 | `user` 消息中的 `tool_result` 块 | 自动转为 `role: "tool"` |
| 工具定义 | `input_schema` | 自动映射为 `parameters` |
| `tool_choice` | `{type:"auto"/"any"/"tool"}` | `any`→`required`，`tool`→function 对象 |
| 推理强度 | `thinking.budget_tokens` | 自动映射为 `reasoning_effort`（≥10000→high, ≥5000→medium, ≥2000→low） |
| 停止原因 | `end_turn`/`max_tokens`/`tool_use` | 自动映射为 `stop`/`length`/`tool_calls` |
| Token 用量 | `input_tokens`/`output_tokens` + 缓存 | 透传，缓存字段映射为 Anthropic 格式 |

**流式响应（SSE，Anthropic 格式）：**
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","type":"message","role":"assistant","content":[],"model":"...","usage":{"input_tokens":0,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10,"cache_read_input_tokens":0,"input_tokens":100}}

event: message_stop
data: {"type":"message_stop"}
```

**非流式响应：**
```json
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "model": "deepseek/deepseek-v4-flash",
  "content": [{ "type": "text", "text": "Hello!" }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 7558,
    "output_tokens": 42,
    "cache_read_input_tokens": 7552,
    "cache_creation_input_tokens": null
  }
}
```

### `GET /v1/models`

返回可用模型列表。优先从 Provider API 动态拉取（5min 缓存），失败回退硬编码列表。

> 想知道**你的套餐**到底能用哪些模型？启动后在控制台按 `1`：它用你的 API Key 拉同一份实时列表并带序号打印；拉了缓存想立刻刷新按 `2`。踩到 Key 无效/断网时，控制台会明确告诉你是回退列表，不会假装那是套餐列表。

### `GET /health`

健康检查。返回 `OK`。

## 错误码

| HTTP 状态 | 说明 |
|-----------|------|
| 400 | 请求格式错误 |
| 401 | API Key 缺失/格式不对/无效（Key 必须以 `user_` 开头；通过 `Authorization: Bearer` 或 `x-api-key` 传入） |
| 429 | 零输出 token，或流空闲超时（30s 流式 / 90s 非流式）——带 `Retry-After`，SDK 自动重试；连续 3 次超时返回"压缩上下文"提示 |
| 502 | CC 上游错误 |

## 模型列表

代理访问 `GET /v1/models` 会返回实时模型列表。以下为常见模型参考，完整列表以实际接口返回为准——各模型套餐可参考 [Command Code Pricing](https://commandcode.ai/docs/resources/pricing-limits)。

### 常用模型

| 模型 ID | 提供商 |
|---------|--------|
| `claude-sonnet-4-6` / `claude-opus-4-8` / `claude-opus-4-7` / `claude-haiku-4-5-20251001` | Anthropic |
| `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.3-codex` | OpenAI |
| `deepseek/deepseek-v4-pro` / `deepseek/deepseek-v4-flash` | DeepSeek |
| `moonshotai/Kimi-K2.6` / `moonshotai/Kimi-K2.5` | Kimi |
| `zai-org/GLM-5.1` / `zai-org/GLM-5` | GLM |
| `MiniMaxAI/MiniMax-M3` / `MiniMaxAI/MiniMax-M2.7` / `MiniMaxAI/MiniMax-M2.5` | MiniMax |
| `Qwen/Qwen3.7-Max` / `Qwen/Qwen3.6-Max-Preview` / `Qwen/Qwen3.6-Plus` | Qwen |
| `stepfun/Step-3.7-Flash` / `stepfun/Step-3.5-Flash` | Step |
| `xiaomi/mimo-v2.5-pro` / `xiaomi/mimo-v2.5` | Xiaomi（**支持图片输入**） |
| `google/gemini-3.5-flash` / `google/gemini-3.1-flash-lite` | Gemini |

> ⚠️ 部分模型（如 `deepseek-v4-flash`、`claude-sonnet-4-6`）不支持图片输入。如需多模态请用 `xiaomi/mimo-v2.5`、`Kimi-K2.5` 等 vision 模型。

## 接入示例

### Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    api_key="user_xxxxxxxxx",
    base_url="http://127.0.0.1:3050/v1",
)

response = client.chat.completions.create(
    model="deepseek/deepseek-v4-flash",
    messages=[{"role": "user", "content": "hello"}],
    stream=True,
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### cURL
```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "hello"}],
    "stream": true
  }'
```

### Cursor
在 Cursor 设置中添加 Custom Provider：
- **API Base URL**: `http://127.0.0.1:3050/v1`
- **API Key**: `user_xxxxxxxxx`
- **Model**: 从模型列表中选择

### Anthropic (Python SDK)
```python
import anthropic

client = anthropic.Anthropic(
    api_key="user_xxxxxxxxx",
    base_url="http://127.0.0.1:3050",
)
message = client.messages.create(
    model="deepseek/deepseek-v4-flash",
    max_tokens=1000,
    system="You are helpful.",
    messages=[{"role": "user", "content": "hello"}],
)
print(message.content[0].text)
```

Anthropic SDK 通过 `x-api-key` 头鉴权——代理已原生支持（无需 `Authorization` 头）。

### OpenCode
```json
{
  "provider": "openai-compatible",
  "baseUrl": "http://127.0.0.1:3050/v1",
  "apiKey": "user_xxxxxxxxx"
}
```

## 反检测

基于对官方 CLI 网络流量的分析（版本号从 npm registry 动态拉取），实现了以下兼容适配：

| 机制 | 实现 |
|------|------|
| **设备指纹** | 每个 Key 首次请求前发送 `POST /alpha/fingerprint/record`；随机指纹池（15 种 CPU、全球时区）、SHA-256 哈希、per-key 绑定，每 8h+2h 抖动刷新 |
| **生命周期声明** | 会话初始化时与指纹并行发送 `POST /alpha/lifecycle-events`（`cli_session_exists`） |
| **按 Key 分 Session** | 每个 API Key 独立 session，12h 过期 + 1h 随机抖动 |
| **动态版本号** | `x-command-code-version` 从 npm registry 自动拉取（24h 刷新） |
| **CLI 信封格式** | config/memory/taste/skills/permissionMode/params |
| **OpenTelemetry** | `traceparent` (W3C Trace Context) |
| **环境标识** | `x-cli-environment: production`、`x-co-flag: "false"`、`x-taste-learning: "false"` |
| **Project Slug** | 从 sessionId 生成的 `x-project-slug`（与真实 CLI 格式一致） |
| **思考强度** | `reasoning_effort` 透传 (low/medium/high/max) |
| **API Key 格式验证** | 对 `Authorization: Bearer` 或 `x-api-key` 用正则 `user_[a-zA-Z0-9_-]+` 提取，自动清理多余路径/前缀，`sk-xxx` 等非 `user_` 格式拒 |
| **流式超时保护** | 流式 30s、非流式 90s → 429 + SDK 自动重试 |
| **连续超时阈值** | 连续 3 次超时后才提示压缩上下文 |
| **零输出防护** | outputTokens=0 → 429 `rate_limit_error`（SDK 自动重试，反异常计费） |
| **上游中止** | 客户端断连 + 全部错误路径 `AbortController` 打断 CC |
| **隐私保护日志** | 日志不含 API Key 片段、错误 body、stack trace |

## 协议细节

### CC API 请求体结构

```json
{
  "config": {
    "workingDir": "C:\\project",
    "date": "2026-06-07",
    "environment": "win32-x64, Node.js v24.16.0",
    "structure": [],
    "isGitRepo": false,
    "currentBranch": "",
    "mainBranch": "",
    "gitStatus": "",
    "recentCommits": []
  },
  "memory": null,
  "taste": null,
  "skills": "",
  "permissionMode": "standard",
  "params": {
    "model": "deepseek/deepseek-v4-flash",
    "messages": [...],
    "max_tokens": 64000,
    "stream": true,
    "reasoning_effort": "max"
  }
}
```

条件字段：`system`（从 system 消息提取）、`temperature`、`reasoning_effort`、`tools`（映射为 CC `input_schema` 格式）。

### CC API 图片消息格式

CLI 发送图片的格式：

```json
{
  "role": "user",
  "content": [
    { "type": "image", "image": "data:image/jpeg;base64,..." },
    { "type": "text", "text": "图里写了什么" }
  ]
}
```

代理收到 OpenAI `image_url` 格式后自动转为上述 CC 格式透传。

## Docker 部署

### 从 GHCR 拉取

每次打 `v*` tag 时 GitHub Actions 会自动构建并推送多架构镜像（`linux/amd64` + `linux/arm64`）到 GitHub Container Registry：

```bash
docker pull ghcr.io/maxeaglet/commandcode-proxy:latest
docker run -d --name cc-proxy -p 3050:3050 -e PORT=3050 ghcr.io/maxeaglet/commandcode-proxy:latest
```

每次发版都会更新 `latest` 标签。镜像为公共可见，拉取无需登录。

### 快速启动 (docker compose)

```bash
docker compose up -d
```

代理将在 `http://0.0.0.0:3050` 监听。通过 `PROXY_PORT` 自定义主机端口：

```bash
PROXY_PORT=13050 docker compose up -d
```

### 从源码构建

```bash
docker build -t commandcode-proxy:latest .
docker run -d -p 3050:3050 -e PORT=3050 commandcode-proxy:latest
```

### 多架构构建

```bash
npm run docker:build:multi
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3050` | 容器内监听端口 |
| `PROXY_PORT` | `3050` | 主机映射端口（仅 compose） |

## 免责声明

本项目仅供**学习和研究**使用。

- **非官方**：本项目与 Command Code 无任何关联，非官方产品。
- **个人使用**：使用者应自行承担所有责任。请遵守 [Command Code 服务条款](https://commandcode.ai/tos)。
- **API Key**：本项目不会收集、上传或泄露你的 API Key。Key 通过每次请求的 `Authorization: Bearer <key>` 或 `x-api-key` 头传入，日志中不记录；`config.json` 中的可选 `apiKey` 字段仅作本地兜底，不会离开你的机器。
- **合规性**：协议基于对本地 CLI 网络流量的被动观察，未对服务端进行任何未授权访问、破解或篡改。
- **账号风险**：建议和正常 CLI 使用频率保持一致，超高并发调用可能触发风控。

---

[Linux.do](https://linux.do)

## 开发

```bash
# 带 watch 模式启动（文件修改自动重启）
npm run dev

# 链路端到端测试（模拟上游，不需要外网与真实 Key）
npm test

# cmd TUI 冒烟测试（模型列表 / 401 回退提示 / Key 输入不回显 / 不写盘）
npm run test:tui
```
