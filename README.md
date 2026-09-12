# Command Code Proxy

> [中文文档](README_zh.md)

A reverse proxy that converts Command Code API to OpenAI / Anthropic compatible endpoints. Single file, zero external dependencies.

Built by analyzing official CLI network traffic to accurately replicate the Command Code API request protocol, including device-fingerprint and lifecycle pre-requests.

**Features**: Built-in interactive console (cmd TUI — list the models your plan can use) | OpenAI Chat Completions + Anthropic Messages API | Streaming & non-streaming | Tool calling (tool_use) | Multimodal image input | Reasoning effort | Dynamic model list | Cache hit metrics | Device fingerprint disguise (per-key, auto-refresh) | `x-api-key` auth (Anthropic SDK) | Client disconnect detection with upstream abort | Zero-output → 429 auto-retry | Consecutive timeout → 429 auto-retry | Privacy-aware logging

**Community**: [Linux.do](https://linux.do) — a friendly Chinese tech community.

## Quick Start

**Windows one-click**: double-click `start.bat` (it switches to its own folder, sets a UTF-8 code page, and keeps the window open with a hint if Node.js is missing).

From a shell:

```bash
npm start        # Start (repo config.json listens on http://0.0.0.0:3050) and enter the interactive console
npm run dev      # Watch mode (auto-reload on file changes)
node proxy.mjs   # Same start, without npm writing logs to your C: drive
```

Once started, cmd shows a numbered menu and **prints nothing else on its own** — press `1` to list the models your plan can use, or `3` for your plan quota. For plain log output only, add `--no-tui`:

```bash
start.bat --no-tui
node proxy.mjs --no-tui
```

API Key is passed via the `Authorization` request header (or `x-api-key` for Anthropic SDKs) — no need to store it in config files. Key must start with `user_` (automatically matched with any prefix, e.g. `Bearer token_user_xxx`):

```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

## File Structure

```
commandcode/
├── start.bat             # Windows one-click launcher (just double-click)
├── config.json           # Port / log path etc.
├── config.local.json     # Local overrides (optional; console-saved API key; git/docker-ignored)
├── LICENSE               # MIT License
├── package.json          # npm start / npm run dev
├── proxy.mjs             # Single-file proxy core + interactive console (~2600 lines)
├── Dockerfile            # Container build (node:22-alpine)
├── docker-compose.yml    # Container orchestration
├── .dockerignore         # Build context exclusions
├── .github/
│   └── workflows/
│       └── docker-publish.yml  # GHCR multi-arch publish on v* tags
├── test/
│   ├── mock-cc-server.mjs      # End-to-end scenario tests (mock upstream, no key needed)
│   └── tui-smoke.mjs           # TUI smoke tests (model list / quota / fallback warning / key input)
├── docs/
│   └── QUOTA.md          # How the plan-quota display works (protocol / math / rendering)
├── captured-requests/    # Captured CLI traffic (protocol analysis reference)
├── README.md             # This document (English)
└── README_zh.md          # Chinese documentation
```

## Interactive Console (cmd TUI)

`npm start` / `node proxy.mjs` enters a numbered menu when stdout is an interactive terminal. When stdout is not a TTY (Docker, CI, redirection) it stays off and behaviour is identical to previous versions.

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

| Key | Action |
|-----|--------|
| `1` | List the models **your plan** can use (`GET {apiBase}/provider/v1/models`, scoped to your key) with index, model ID and note |
| `2` | Force a re-fetch, bypassing the 5-minute cache |
| `3` | Show **your plan quota**: three usage windows (5-hour / weekly / monthly) with progress bars, remaining credits and reset countdowns, plus the credit pool, spend this period, **cumulative usage (tokens, in millions)**, billing cycle and **refresh time**. Serves a 30-second cache; use `[8]` to force a refresh |
| `4` | Listen address, uptime, upstream API, model source & cache, request counters |
| `5` | Set / change the API key (no echo; optionally saved to the project's `config.local.json`) |
| `6` | Last 40 log lines (in-memory ring buffer, max 300, never written to disk) |
| `7` | Clear screen |
| `8` | Force-refresh the quota, bypassing the 30-second cache |
| `0` | Exit and stop the proxy (`q` / `exit` also work); press Ctrl+C twice |

**What `[3]` looks like:**

```
当前套餐额度
 套餐：Go（active）   $10.00/月
 账号：your-name

 用量窗口
 5小时  [█░░░░░░░░░░░░░░░░░░░]   3%  剩余 $2.90 · 10分后重置（23:04）
 每周   [██████░░░░░░░░░░░░░░]  31%  剩余 $4.14 · 16小时51分后重置（2026/9/12 15:45）
 每月   [██████████░░░░░░░░░░]  51%  剩余 $4.93 / $10.00 · 14天后续期（2026/9/25 14:03）

 额度池：剩余 $4.93 / $10.00   已用 $5.04
         其中 月度 $4.93 · 加油包 $0.00 · 赠送 $0.00
 累计用量：233.4M tokens（输入 231.9M · 输出 1.5M） · 3,012 次请求 · 均次 $0.0017
           统计自本计费周期起点
 周期：2026/8/25 14:03:54 → 2026/9/25 14:03:54 · 还剩 14 天
 刷新时间：2026/9/11 22:54:31（耗时 6s · 数据来源 CC 账单接口）
```

The three usage windows mirror the official CLI's `/usage` panel:

- **5-hour / weekly** come from `windowLimits` in the `billing/credits` response — note it is a **top-level field** alongside `credits`, its windows use `used` / `cap`, and `resetAt` is epoch milliseconds. The bar is `used/cap`, colored by utilization (<70% green, ≥70% yellow, ≥90% red), and an exceeded window is flagged in red.
- **Monthly** is usually absent from `windowLimits`, so it is computed from the plan cycle: `spent / credit pool`, with the renewal time.
- Every window shows the **time until reset plus the reset clock** (time-only if it resets today, with a date otherwise), and the last line is the **refresh time** (absolute) with the fetch duration.

Quota comes from Command Code's own billing endpoints — the same ones the official CLI's `/usage` panel uses (`/alpha/whoami`, `/alpha/billing/credits`, `/alpha/billing/subscriptions`, `/alpha/usage/summary`). They are read-only GETs and consume no credits. The math matches the CLI's `projectUsageView`:

- **remaining** = monthly + purchased + free credits;
- **credit pool** = when the subscription is active, `max(plan's nominal credits, monthly remaining)` + purchased + free; otherwise spent + remaining;
- **spent** = `totalCost` since the start of the current billing period;
- **cumulative usage** = tokens consumed within the current billing period, shown in millions (e.g. `233.4M`) with an input/output split, request count and average cost per request.

> ⚠️ The `since` parameter of `usage/summary` is ignored by the server in practice (passing year 2020 returns identical numbers and `periodBasis` stays `billing-period`), so this is the **current billing period's** total, not all-time history — the UI says so explicitly.
>
> 📖 Implementation details (endpoint protocol, field pitfalls, parallelism and degradation strategy, honesty-by-design) are in **[docs/QUOTA.md](docs/QUOTA.md)** (written in Chinese).

**On latency**: these billing endpoints are simply slow (measured: `whoami` 7–17s, `subscriptions` up to 20s+, `summary` ~8s — while DNS takes 2ms, so the slowness is server-side, not your network). Therefore:

- requests now run **in parallel** (they used to be sequential, measured at 47s worst case), so total time is bounded by the slowest single call;
- the per-request timeout is a generous **45 seconds**, tunable via `quotaTimeoutMs` in `config.json` or the `CC_QUOTA_TIMEOUT_MS` env var;
- while waiting, a progress line is printed every 5 seconds (`仍在读取（已等待 Ns）`) so it never looks hung;
- `orgId` is remembered after the first lookup, saving a round trip on later refreshes;
- when data can't be fetched it reports the error honestly with a concrete hint (a timeout names the endpoint and points at `quotaTimeoutMs`) and **never invents numbers**; if one endpoint fails alone, the rest is still shown and the missing piece is listed under `部分数据未取到`; when a refresh fails while older data is cached, the panel explicitly labels it as stale. Any `windowLimits` rate-limit windows returned by the server are listed too.

Notes:

- **The menu is reprinted after every command's output**, so you never have to scroll back up to pick the next option. On startup the console only prints the menu — it does not auto-fetch and dump the model list.
- **Model list provenance is labeled honestly**: on success it shows `数据来源: Provider API`; on failure (invalid key 401, network error, `useProviderModels` disabled) it states the reason and makes clear the listed entries are the **built-in reference list**, which may contain models your plan cannot use. That built-in list is an offline fallback and can lag behind production (which carries dozens of models) — with a valid key, trust the live result from `[1]`.
- **API key resolution order**: `CC_API_KEY` / `COMMANDCODE_API_KEY` env → project `config.local.json` → `config.json` → menu `[4]`. Request-side auth (`Authorization` / `x-api-key`) is unchanged and independent of the console. If a terminal paste repeats the same key several times, the copies are collapsed into one (with an explicit notice) instead of saving one giant invalid key.
- **Nothing is written to your C: drive**: the console itself creates no files (readline history is memory-only). Only when you answer `y` in menu `[4]` is the key written to `config.local.json` **inside the project directory** (excluded via `.gitignore` / `.dockerignore`, so it is never committed or baked into an image) — never `%APPDATA%`, `%TEMP%`, your home directory or the registry.
- **Logs never shred the prompt**: runtime logs and upstream errors clear the current input line, print, then redraw `请输入序号 >`.
- **Clean exit**: shutdown waits for in-flight upstream requests and drains stdout, avoiding an abrupt exit that trips a libuv assertion on Windows (exit code `0xC0000409`).

### Console environment variables

| Variable | Description |
|----------|-------------|
| `CC_TUI` | `1`/`on`/`force` to force on, `0`/`off` to force off; default is "on when stdout is a TTY" |
| `CC_API_KEY` | API key used by the console and `[1]` (alias: `COMMANDCODE_API_KEY`) |
| `NO_COLOR` | Set to anything to disable colors (already off when not a TTY) |
| `--no-tui` / `--tui` | CLI flags, take precedence over `CC_TUI` |

## Configuration

### config.json

| Field | Default | Description |
|------|--------|-------------|
| `port` | `3000` | Listen port (repo config.json ships with `3050`) |
| `host` | `0.0.0.0` | Listen address |
| `apiBase` | `https://api.commandcode.ai` | CC API base URL |
| `projectSlug` | `cc-proxy` | `x-project-slug` header |
| `apiKey` | `""` | Optional fallback API key (requests can also send it via header) |
| `logFile` | `""` | Log file path (empty = console only) |
| `logLevel` | `info` | Log level |
| `useProviderModels` | `true` | Dynamically fetch model list from Provider API |
| `modelRefreshIntervalMs` | `300000` | Model list cache refresh interval (5 min) |
| `quotaTimeoutMs` | `45000` | Per-request timeout for billing endpoints (measured 8–20s — don't set it too low) |
| `maxBodySize` | `67108864` | Request body limit in bytes (64MB default). Multimodal payloads (video base64) get large; exceeding it returns 413 |

An optional `config.local.json` may also be present: same fields as `config.json`, but it **takes precedence** (`config.json` is read first, then overridden by this file). The API key saved by console menu `[4]` lands here; the file is excluded via `.gitignore` / `.dockerignore`, so it is never committed or baked into an image.

### Environment Variables

| Variable | Overrides |
|----------|-----------|
| `PORT` | `port` |
| `HOST` | `host` |
| `CC_API_BASE` | `apiBase` |
| `PROJECT_SLUG` | `projectSlug` |
| `LOG_FILE` | `logFile` |
| `CC_USE_PROVIDER_MODELS` | `useProviderModels` |
| `CC_TUI` | Force the interactive console on/off (see above) |
| `CC_API_KEY` | API key used by the console (not used for request-side auth) |
| `CC_QUOTA_TIMEOUT_MS` | Billing endpoint timeout (same as `quotaTimeoutMs`) |
| `CC_MAX_BODY_SIZE` | Request body limit in bytes (same as `maxBodySize`) |

## API Endpoints

### `POST /v1/chat/completions`

OpenAI Chat Completions compatible. Supports streaming, non-streaming, tool calling, multimodal image input, and reasoning effort.

**Request parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `model` | Yes | Model ID (see model list) |
| `messages` | Yes | Conversation messages, supports `system/user/assistant/tool` roles |
| `max_tokens` | No | Max tokens to generate (default 64000) |
| `stream` | No | SSE streaming (default false) |
| `temperature` | No | Sampling temperature (0-2) |
| `reasoning_effort` | No | Reasoning intensity: `low`/`medium`/`high`/`max` |
| `tools` | No | Tool definitions (OpenAI function calling format) |
| `tool_choice` | No | Tool selection strategy |
| `parallel_tool_calls` | No | Allow parallel tool calls |

**Simple request:**
```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [{ "role": "user", "content": "hello" }],
  "stream": true
}
```

**Multimodal image input (vision model required):**
```json
{
  "model": "xiaomi/mimo-v2.5",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "Describe this image" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
    ]
  }]
}
```

**Video / audio input:**

> ⚠️ **`messages[].content` in the Command Code API supports only two part types** (source: the official CLI internals plus the upstream 400 validation message):
>
> ```jsonc
> { "type": "text",  "text": "..." }
> { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } }
> ```
>
> **There is no video / audio part type.** Video and audio are downgraded to a text note stating why, instead of fabricating a part upstream rejects (which fails the whole request with a 400).

What the proxy accepts and converts:

| Input | Result |
|-------|--------|
| OpenAI `{ type:"image_url", image_url:{ url:"data:image/...;base64,..." } }` | → `{ type:"image", source:{ type:"base64", media_type, data } }` |
| Anthropic `{ type:"image", source:{ type:"base64", media_type, data } }` | Same (`media_type` and data preserved) |
| Image blocks inside `tool_result` | Converted to a valid image part and forwarded |
| Video / audio (any shape) | **Downgraded to a text note** explaining only text and image are supported |
| Remote image URL (`https://...`) | **Downgraded to a text note** (CC only accepts base64-inlined images; the proxy does not download for you) |

> Everything forwarded is guaranteed to be a valid `text` or `image` part; tests assert this so an illegal part can never cause a 400 again.

> 💡 **Size**: image base64 gets large, and **the same image often appears several times in context** (e.g. once in the user message and again in the `Read` tool result), so a request can exceed twice a single copy. The default limit is a roomy 64MB (tunable via `maxBodySize`); when exceeded the proxy returns **413** stating the actual size and the limit instead of dropping the connection.

**Tool calling:**
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

**Streaming response (SSE):**
```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"thinking..."}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"prompt_tokens_details":{"cached_tokens":8}}}

data: [DONE]
```

**Non-streaming response (with cache hits):**
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

Anthropic Messages API compatible endpoint. Supports streaming, non-streaming, and tool calling.

**Request body:**
```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1000,
  "system": "You are a helpful assistant.",
  "messages": [
    { "role": "user", "content": "hello" }
  ],
  "stream": true
}
```

**Anthropic protocol conversion (automatic):**

| Concept | Anthropic Format | Conversion |
|---------|-----------------|------------|
| System prompt | Top-level `system` field | Auto-converted to OpenAI `system` message |
| Message content | `content` array (text/tool_use/tool_result) | Auto-mapped to corresponding roles |
| Tool results | `tool_result` blocks in `user` messages | Auto-converted to `role: "tool"` |
| Tool definitions | `input_schema` | Auto-mapped to `parameters` |
| `tool_choice` | `{type:"auto"/"any"/"tool"}` | `any`→`required`, `tool`→function object |
| Reasoning | `thinking.budget_tokens` | Auto-mapped to `reasoning_effort` (≥10000→high, ≥5000→medium, ≥2000→low) |
| Stop reason | `end_turn`/`max_tokens`/`tool_use` | Auto-mapped to `stop`/`length`/`tool_calls` |
| Token usage | `input_tokens`/`output_tokens` + cache | Passed through, cache fields mapped to Anthropic format |

**Streaming response (SSE, Anthropic format):**
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

**Non-streaming response:**
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

Returns available model list. Fetched dynamically from Provider API (5 min cache), falls back to hardcoded list on failure.

> Want to know exactly which models **your plan** can use? Press `1` in the console after startup: it fetches the same live list with your API key and prints it with indices; press `2` to force a refresh. If the key is invalid or the network is down, the console says so explicitly instead of passing the fallback list off as your plan's list.

### `GET /health`

Health check. Returns `OK`.

## Error Codes

| HTTP Status | Description |
|-------------|-------------|
| 400 | Invalid request format |
| 401 | API Key missing / invalid format / rejected (Key must start with `user_`; sent via `Authorization: Bearer` or `x-api-key`) |
| 413 | Request body exceeds `maxBodySize` (64MB default; large video base64 is the usual cause) — states the actual size and limit, never drops the connection |
| 429 | Zero output tokens, or idle timeout (30s streaming / 90s non-streaming) — SDK auto-retry with `Retry-After`; after 3 consecutive timeouts a "reduce context" hint is returned |
| 502 | CC upstream error |

## Model List

The proxy returns a live model list via `GET /v1/models`. Below are common models for reference; the actual list depends on the live API response — see [Command Code Pricing](https://commandcode.ai/docs/resources/pricing-limits) for plan details.

### Common Models

| Model ID | Provider |
|----------|----------|
| `claude-sonnet-4-6` / `claude-opus-4-8` / `claude-opus-4-7` / `claude-haiku-4-5-20251001` | Anthropic |
| `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.3-codex` | OpenAI |
| `deepseek/deepseek-v4-pro` / `deepseek/deepseek-v4-flash` | DeepSeek |
| `moonshotai/Kimi-K2.6` / `moonshotai/Kimi-K2.5` | Kimi |
| `zai-org/GLM-5.1` / `zai-org/GLM-5` | GLM |
| `MiniMaxAI/MiniMax-M3` / `MiniMaxAI/MiniMax-M2.7` / `MiniMaxAI/MiniMax-M2.5` | MiniMax |
| `Qwen/Qwen3.7-Max` / `Qwen/Qwen3.6-Max-Preview` / `Qwen/Qwen3.6-Plus` | Qwen |
| `stepfun/Step-3.7-Flash` / `stepfun/Step-3.5-Flash` | Step |
| `xiaomi/mimo-v2.5-pro` / `xiaomi/mimo-v2.5` | Xiaomi (**image input supported**) |
| `google/gemini-3.5-flash` / `google/gemini-3.1-flash-lite` | Gemini |

> ⚠️ Some models (e.g. `deepseek-v4-flash`, `claude-sonnet-4-6`) do not support image input. Use `xiaomi/mimo-v2.5`, `Kimi-K2.5`, or other vision models for multimodal.

## Integration Examples

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
Add a Custom Provider in Cursor settings:
- **API Base URL**: `http://127.0.0.1:3050/v1`
- **API Key**: `user_xxxxxxxxx`
- **Model**: Choose from the model list

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

The Anthropic SDK authenticates via the `x-api-key` header — supported by the proxy natively (no `Authorization` header needed).

### OpenCode
```json
{
  "provider": "openai-compatible",
  "baseUrl": "http://127.0.0.1:3050/v1",
  "apiKey": "user_xxxxxxxxx"
}
```

## Anti-Detection

Based on analysis of official CLI traffic (version auto-fetched from npm registry):

| Mechanism | Implementation |
|-----------|---------------|
| **Device Fingerprint** | `POST /alpha/fingerprint/record` before first request per key; random fingerprint pool (15 CPUs, global timezones), SHA-256 hashed, per-key binding, refreshed every 8h + 2h jitter |
| **Lifecycle Events** | `POST /alpha/lifecycle-events` (`cli_session_exists`) sent in parallel with fingerprint on session init |
| **Per-Key Session** | One session per API key, 12h expiry + 1h random jitter |
| **Version** | `x-command-code-version` auto-fetched from npm registry (24h refresh) |
| **CLI Envelope** | config/memory/taste/skills/permissionMode/params |
| **OpenTelemetry** | `traceparent` (W3C Trace Context) |
| **Environment** | `x-cli-environment: production`, `x-co-flag: "false"`, `x-taste-learning: "false"` |
| **Project Slug** | `x-project-slug` generated from session ID (CLI-compatible format) |
| **Reasoning Effort** | `reasoning_effort` pass-through (low/medium/high/max) |
| **Key Validation** | Regex `user_[a-zA-Z0-9_-]+` on `Authorization: Bearer` or `x-api-key`, auto-cleans extra paths/prefixes, rejects `sk-xxx` format |
| **Stream Timeout** | 30s streaming / 90s non-streaming → 429 with SDK auto-retry |
| **Consecutive Timeout** | 3 consecutive timeouts before "reduce context" hint |
| **Zero-Output Guard** | outputTokens=0 → 429 `rate_limit_error` (SDK auto-retry, anti false billing) |
| **Upstream Abort** | `AbortController` on client disconnect + all error paths |
| **Privacy Logging** | No API key fragments, no error bodies, no stack traces in logs |

## Protocol Details

### CC API Request Structure

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

Conditional fields: `system` (extracted from `system` messages), `temperature`, `reasoning_effort`, `tools` (mapped to CC `input_schema` format).

### CC API Image Message Format

The CLI sends images in this format:

```json
{
  "role": "user",
  "content": [
    { "type": "image", "image": "data:image/jpeg;base64,..." },
    { "type": "text", "text": "What does this image say?" }
  ]
}
```

The proxy receives OpenAI `image_url` format and converts it to the above CC format transparently.

## Docker Deployment

### Pull from GHCR

Pre-built multi-arch images (`linux/amd64` + `linux/arm64`) are published to the GitHub Container Registry automatically on every `v*` tag via GitHub Actions.

> ⚠️ The command below pulls the **upstream project's image** (`maxeaglet/commandcode-proxy`), which does **not** include this repository's interactive console and other changes. To run this repository's code, build it yourself (see "Build from Source" below), or push a `v*` tag so Actions publishes to this repo's own namespace (`ghcr.io/<your-user>/commandcode-proxy`).

```bash
docker pull ghcr.io/maxeaglet/commandcode-proxy:latest
docker run -d --name cc-proxy -p 3050:3050 -e PORT=3050 ghcr.io/maxeaglet/commandcode-proxy:latest
```

The `latest` tag is updated on each release. The upstream image is public — no login required to pull.

### Quick Start (docker compose)

```bash
docker compose up -d
```

The proxy will listen on `http://0.0.0.0:3050`. Set `PROXY_PORT` to customize the host port:

```bash
PROXY_PORT=13050 docker compose up -d
```

### Build from Source

```bash
docker build -t commandcode-proxy:latest .
docker run -d -p 3050:3050 -e PORT=3050 commandcode-proxy:latest
```

### Multi-Architecture Build

```bash
npm run docker:build:multi
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3050` | Container listen port |
| `PROXY_PORT` | `3050` | Host port (compose only) |

## Disclaimer

This project is for **educational and research purposes** only.

- **Unofficial**: This project is not affiliated with Command Code in any way.
- **Origin & Credits**: This repository is a derivative of [MAXeaglet/commandcode-proxy](https://github.com/maxeaglet/commandcode-proxy) (MIT); the original copyright notice is retained in [LICENSE](LICENSE). It adds a built-in interactive console (cmd TUI) for listing the models your plan can use, 5-hour / weekly / monthly usage windows and quota, service status, plus a one-click `start.bat`.
- **Personal Use**: Users assume all responsibility. Please comply with the [Command Code Terms of Service](https://commandcode.ai/tos).
- **API Key**: This project does not collect, upload, or leak your API Key. The key is sent per request via the `Authorization: Bearer <key>` or `x-api-key` header and is never logged; an optional `apiKey` field in `config.json` and the console-saved `config.local.json` serve only as local fallbacks and never leave your machine (`config.local.json` is excluded via `.gitignore` / `.dockerignore`).
- **Compliance**: The protocol is based on passive observation of local CLI network traffic. No unauthorized access, cracking, or tampering of the server has been performed.
- **Account Risk**: Keep usage frequency consistent with normal CLI usage. Extremely high concurrent calls may trigger risk controls.

---

## Development

```bash
# Start with watch mode (auto-reload on file changes)
npm run dev

# End-to-end pipeline tests (mock upstream; no network or real key required)
npm test

# TUI smoke tests (model list / 401 fallback warning / key input masking / no disk writes)
npm run test:tui
```
