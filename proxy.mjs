/**
 * Command Code → OpenAI 兼容代理
 * 基于真实 CLI 流量抓包数据构建
 */
import http from 'http';
import crypto from 'crypto';
import { randomUUID } from 'crypto';
import { readFileSync, existsSync, appendFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

// ── 配置加载 ──────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const defaults = {
    port: 3000,
    host: '0.0.0.0',
    apiBase: 'https://api.commandcode.ai',
    projectSlug: 'cc-proxy',
    logFile: '',
    logLevel: 'info',
    useProviderModels: true,
    modelRefreshIntervalMs: 5 * 60 * 1000,  // 5 minutes
    quotaTimeoutMs: 45000,                   // CC 账单接口实测 8~20s，超时给足
    maxBodySize: 64 * 1024 * 1024,           // 64MB — 多模态请求（视频 base64）可能很大
  };

  const configPath = resolve(__dirname, 'config.json');
  if (existsSync(configPath)) {
    try {
      const user = JSON.parse(readFileSync(configPath, 'utf-8'));
      Object.assign(defaults, user);
    } catch (e) {
      console.error('[config] Failed to parse config.json:', e.message);
    }
  }

  // 本地覆盖（控制台保存的 API Key 等）。该文件不入库、不进镜像，
  // 避免 API Key 被误提交或误打进容器镜像。
  const localPath = resolve(__dirname, 'config.local.json');
  if (existsSync(localPath)) {
    try {
      const local = JSON.parse(readFileSync(localPath, 'utf-8'));
      Object.assign(defaults, local);
    } catch (e) {
      console.error('[config] Failed to parse config.local.json:', e.message);
    }
  }

  // 环境变量覆写
  if (process.env.PORT) defaults.port = parseInt(process.env.PORT);
  if (process.env.HOST) defaults.host = process.env.HOST;
  if (process.env.CC_API_BASE) defaults.apiBase = process.env.CC_API_BASE;
  if (process.env.PROJECT_SLUG) defaults.projectSlug = process.env.PROJECT_SLUG;
  if (process.env.LOG_FILE) defaults.logFile = process.env.LOG_FILE;
  if (process.env.CC_USE_PROVIDER_MODELS) defaults.useProviderModels = process.env.CC_USE_PROVIDER_MODELS !== 'false';

  return defaults;
}

const CFG = loadConfig();

// 在途上游请求登记表。退出前要等它们收尾：在 undici 异步 handle 关闭途中
// 调用 process.exit()，Windows 上会撞 libuv 断言（0xC0000409）直接崩。
const inflightOps = new Set();
function track(op) {
  const p = Promise.resolve(op);
  inflightOps.add(p);
  const done = () => inflightOps.delete(p);
  p.then(done, done);
  return p;
}

// ── 指纹生成（首次运行自动生成，写回 config.json） ──────
// CPU 型号与核心数对应表（仅 Windows x64）
const FINGERPRINT_CPUS = [
  { model: '12th Gen Intel(R) Core(TM) i7-12650H', cores: 10 },
  { model: '12th Gen Intel(R) Core(TM) i5-12400F', cores: 6 },
  { model: '12th Gen Intel(R) Core(TM) i9-12900K', cores: 16 },
  { model: '13th Gen Intel(R) Core(TM) i7-13700K', cores: 16 },
  { model: '13th Gen Intel(R) Core(TM) i5-13600K', cores: 14 },
  { model: '13th Gen Intel(R) Core(TM) i9-13900K', cores: 24 },
  { model: 'Intel(R) Core(TM) Ultra 7 155H', cores: 16 },
  { model: 'Intel(R) Core(TM) Ultra 9 285H', cores: 16 },
  { model: 'Intel(R) Core(TM) i9-14900K', cores: 24 },
  { model: 'Intel(R) Core(TM) i7-14700K', cores: 20 },
  { model: 'AMD Ryzen 7 7800X3D', cores: 8 },
  { model: 'AMD Ryzen 9 7950X', cores: 16 },
  { model: 'AMD Ryzen 5 7600', cores: 6 },
  { model: 'AMD Ryzen 9 7900X', cores: 12 },
  { model: 'AMD Ryzen 7 5800X3D', cores: 8 },
];
const FINGERPRINT_MEMS = [8, 16, 24, 32, 48, 64];
const FINGERPRINT_TZS = [
  'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Toronto',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Moscow',
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Seoul', 'Asia/Hong_Kong',
  'Australia/Sydney', 'Pacific/Auckland',
];
const FINGERPRINT_MAC_COUNT_RANGE = [2, 3, 4, 5]; // 随机 2~5 个 MAC

function generateFingerprint() {
  const cpuEntry = FINGERPRINT_CPUS[Math.floor(Math.random() * FINGERPRINT_CPUS.length)];
  const memGiB = FINGERPRINT_MEMS[Math.floor(Math.random() * FINGERPRINT_MEMS.length)];
  const tz = FINGERPRINT_TZS[Math.floor(Math.random() * FINGERPRINT_TZS.length)];
  const macCount = FINGERPRINT_MAC_COUNT_RANGE[Math.floor(Math.random() * FINGERPRINT_MAC_COUNT_RANGE.length)];

  function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
  function randHex(n) { return crypto.randomBytes(n).toString('hex'); }

  const macHashes = [];
  for (let i = 0; i < macCount; i++) macHashes.push(sha256(randHex(32)));

  const machineIdHash = sha256(randHex(32));
  const osUserHash = sha256(randHex(16));
  const hostnameHash = sha256(randHex(16));
  const gitEmailHash = sha256(randHex(16));

  // thumbmark = 所有组件的联合哈希
  const thumbData = [machineIdHash, ...macHashes, osUserHash, hostnameHash, gitEmailHash, 'win32', '10.0.22631', cpuEntry.model, String(cpuEntry.cores), String(memGiB)].join('|');
  const thumbmark = sha256(thumbData);

  return {
    thumbmark,
    components: {
      machineIdHash,
      macHashes,
      osUserHash,
      hostnameHash,
      gitEmailHash,
      platform: 'win32',
      arch: 'x64',
      osRelease: '10.0.22631',
      cpuModel: cpuEntry.model,
      cpuCount: cpuEntry.cores,
      memGiB,
      isContainer: false,
      timezone: tz,
      runtime: 'cli',
      collectorVersion: 1,
    },
  };
}

let CC_VERSION = '0.32.3';
const CC_VERSION_FALLBACK = '0.32.3';
const CC_VERSION_REFRESH_MS = 24 * 60 * 60 * 1000; // 24h — npm registry 刷新间隔

// ── 动态 CC 版本号（从 npm registry 拉取） ─────────────
function refreshCCVersion() {
  return track(doRefreshCCVersion());
}

async function doRefreshCCVersion() {
  try {
    const url = 'https://registry.npmjs.org/command-code/latest';
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`npm responded with ${res.status}`);
    const pkg = await res.json();
    if (pkg.version && typeof pkg.version === 'string') {
      CC_VERSION = pkg.version;
      log('info', 'CC Version refreshed from npm', { version: CC_VERSION });
    }
  } catch (e) {
    log('warn', 'CC Version fetch failed, using current', { version: CC_VERSION, error: e.message });
  }
}
refreshCCVersion(); // 启动时立即拉取
const ccVersionTimer = setInterval(refreshCCVersion, CC_VERSION_REFRESH_MS);

// 请求体上限。多模态请求（图片/视频 base64）天然很大，10MB 太紧：
// 一个几十秒的视频 base64 后轻松超过，会被服务端拒收。
// 默认 64MB，可用 config.json 的 maxBodySize 或环境变量 CC_MAX_BODY_SIZE 调整（单位字节）。
const MAX_BODY_SIZE = parseInt(process.env.CC_MAX_BODY_SIZE || '', 10) || CFG.maxBodySize || 64 * 1024 * 1024;
const STREAM_IDLE_TIMEOUT_MS = 90000;   // 90s — 流式无新数据中断（thinking/排队期上游常静默超过 30s，30s 会掐断还活着的流）
const NONSTREAM_IDLE_TIMEOUT_MS = 90000; // 90s — 非流式超时更宽容
const SSE_KEEPALIVE_INTERVAL_MS = parseInt(process.env.SSE_KEEPALIVE_INTERVAL_MS || '') || 15000; // 15s — 上游静默期向客户端发 SSE 注释行保活（测试可用环境变量覆盖）

// 连续超时计数：连续 3 次超时才提醒压缩上下文，任意成功请求后重置
let consecutiveTimeouts = 0;
const TIMEOUT_REDUCE_CONTEXT_THRESHOLD = 3;

// ── 日志 ─────────────────────────────────────────────
const LOG_RING_SIZE = 300;
const logRing = []; // 最近日志（内存环形缓冲，控制台 [5] 可查看；不落盘）

// 控制台状态对象。提前声明，log() 才能安全引用；
// 具体实现见文件末尾「交互式控制台（cmd TUI）」章节。
const TUI = {
  active: false,        // 是否已进入交互模式
  startedAt: Date.now(),
  rl: null,             // readline 实例
  queue: Promise.resolve(), // 命令串行队列（保证输出顺序）
  pending: null,        // 正在等待的一次输入
  maskInput: false,     // 隐藏回显（输入 API Key 时）
  closing: false,
  apiKey: '',
  apiKeySource: '',
};

const stats = { requests: 0, errors: 0 };

function log(level, msg, data) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
  logRing.push(line);
  if (logRing.length > LOG_RING_SIZE) logRing.shift();
  if (TUI.active) tuiWriteAbovePrompt(formatLogLine(line, level));
  else console.log(line);
  if (CFG.logFile) {
    try { appendFileSync(CFG.logFile, line + '\n', 'utf-8'); } catch {}
  }
}

// ── 会话管理 ───────────────────────────────────────
// 每个 API Key 独立一个 session，12h 过期 + 1h 随机抖动
// 同一 Key 在同一周期内复用，到期自动换新
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;    // 12h
const SESSION_JITTER_MS  = 60 * 60 * 1000;           // 1h 抖动范围

const sessionStore = new Map(); // apiKey → { sessionId, expiresAt }

function ensureSession(apiKey) {
  const now = Date.now();
  const entry = sessionStore.get(apiKey);

  if (entry && now < entry.expiresAt) {
    return entry.sessionId;
  }

  // 过期或第一次：生成新 session
  const jitter = Math.floor(Math.random() * SESSION_JITTER_MS);
  const sessionId = randomUUID();
  sessionStore.set(apiKey, { sessionId, expiresAt: now + SESSION_DURATION_MS + jitter });
      log('info', 'Session created', { sessionId: sessionId.slice(0, 8), storeSize: sessionStore.size });
  return sessionId;
}

// 定期清理过期 session 和 key 状态，防止 Map 无限增长
const sessionCleanupTimer = setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of sessionStore) {
    if (now >= entry.expiresAt) {
      sessionStore.delete(key);
      keyStateStore.delete(key); // 同时清理该 key 的指纹状态
      cleaned++;
    }
  }
  if (cleaned > 0) log('info', 'Session cleanup', { cleaned, remaining: sessionStore.size });
}, 60 * 60 * 1000); // 每小时

function getSessionId(incomingHeaders, apiKey) {
  // 优先从客户端传来的 session 类 header 获取
  const candidates = [
    incomingHeaders['x-session-id'],
    incomingHeaders['x-claude-code-session-id'],
  ];
  for (const id of candidates) {
    if (id && typeof id === 'string' && id.length >= 8) return id;
  }
  // 按 API Key 分 session
  return ensureSession(apiKey);
}

// 每个请求独立 thread ID
function newThreadId() { return randomUUID(); }

// ── 每 Key 独立状态（fingerprint + 初始化节流） ──
// 每个 API Key 拥有自己的设备指纹和初始化定时器
const keyStateStore = new Map(); // apiKey → { fingerprint, nextInitAt }

function getOrCreateKeyState(apiKey) {
  let state = keyStateStore.get(apiKey);
  if (!state) {
    state = {
      fingerprint: generateFingerprint(),
      nextInitAt: 0,
    };
    keyStateStore.set(apiKey, state);
    log('info', 'Fingerprint generated for key', { keyPrefix: apiKey.slice(0, 8) });
  }
  return state;
}

// ── 初始化预请求（fingerprint + lifecycle，首次 + 每 8h+2h 抖动） ────
const INIT_REFRESH_MS = 8 * 60 * 60 * 1000;    // 8h
const INIT_JITTER_MS  = 2 * 60 * 60 * 1000;    // 2h 抖动

async function ensureInitialized(apiKey, signal) {
  return track(doEnsureInitialized(apiKey, signal));
}

async function doEnsureInitialized(apiKey, signal) {
  const state = getOrCreateKeyState(apiKey);
  const now = Date.now();
  if (now < state.nextInitAt) return;

  try {
    // 并行发两个预请求
    const headers = {
      'Content-Type': 'application/json',
      'x-cli-environment': 'production',
      'Authorization': `Bearer ${apiKey}`,
      'x-command-code-version': CC_VERSION,
    };
    const fingerprint = state.fingerprint || {};

    await Promise.all([
      fetch(`${CFG.apiBase}/alpha/fingerprint/record`, {
        method: 'POST', headers, signal,
        body: JSON.stringify(fingerprint),
      }).then(r => {
        if (!r.ok) log('warn', 'Fingerprint record failed', { status: r.status });
        else log('info', 'Fingerprint recorded');
      }).catch(e => {
        if (e.name !== 'AbortError') log('warn', 'Fingerprint record error', { error: e.message });
      }),

      fetch(`${CFG.apiBase}/alpha/lifecycle-events`, {
        method: 'POST', headers, signal,
        body: JSON.stringify({
          eventType: 'cli_session_exists',
          metadata: {
            sessionId: `sess_${crypto.randomBytes(8).toString('hex')}`,
            cliVersion: CC_VERSION,
            mode: 'interactive',
            os: `${fingerprint.components.platform}-${fingerprint.components.arch}`,
          },
        }),
      }).then(r => {
        if (!r.ok) log('warn', 'Lifecycle event failed', { status: r.status });
        else log('info', 'Lifecycle event sent');
      }).catch(e => {
        if (e.name !== 'AbortError') log('warn', 'Lifecycle event error', { error: e.message });
      }),
    ]);

    // 成功：8h + 2h 随机抖动
    const jitter = Math.floor(Math.random() * INIT_JITTER_MS);
    state.nextInitAt = Date.now() + INIT_REFRESH_MS + jitter;
    log('info', 'Fingerprint/lifecycle next refresh', { nextIn: `${(INIT_REFRESH_MS + jitter) / 3600000}h` });
  } catch (e) {
    if (e.name !== 'AbortError') log('warn', 'Fingerprint/lifecycle refresh error, will retry next request', { error: e.message });
  }
}

// ── 模型列表 ───────────────────────────────────────
const MODELS = [
  // Anthropic
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
  // OpenAI
  { id: 'gpt-5.5', name: 'GPT-5.5' },
  { id: 'gpt-5.4', name: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
  // DeepSeek
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  // Kimi
  { id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6' },
  { id: 'moonshotai/Kimi-K2.5', name: 'Kimi K2.5' },
  // GLM
  { id: 'zai-org/GLM-5.1', name: 'GLM 5.1' },
  { id: 'zai-org/GLM-5', name: 'GLM 5' },
  // MiniMax
  { id: 'MiniMaxAI/MiniMax-M3', name: 'MiniMax M3' },
  { id: 'MiniMaxAI/MiniMax-M2.7', name: 'MiniMax M2.7' },
  { id: 'MiniMaxAI/MiniMax-M2.5', name: 'MiniMax M2.5' },
  // Qwen
  { id: 'Qwen/Qwen3.6-Max-Preview', name: 'Qwen 3.6 Max Preview' },
  { id: 'Qwen/Qwen3.6-Plus', name: 'Qwen 3.6 Plus' },
  { id: 'Qwen/Qwen3.7-Max', name: 'Qwen 3.7 Max' },
  // Step
  { id: 'stepfun/Step-3.7-Flash', name: 'Step 3.7 Flash' },
  { id: 'stepfun/Step-3.5-Flash', name: 'Step 3.5 Flash' },
  // Xiaomi
  { id: 'xiaomi/mimo-v2.5-pro', name: 'MiMo V2.5 Pro' },
  { id: 'xiaomi/mimo-v2.5', name: 'MiMo V2.5' },
  // Gemini
  { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
  { id: 'google/gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite' },
];

// ── 工具函数 ───────────────────────────────────────

// 从 sessionId 构造一个假的工作目录路径，再按真实 CLI 规则生成 slug
// 结果形如 "d-users-dev-projects-web-app-a3f2" (和真实 CLI 的 slug 格式一致)
function fakeProjectSlug(sessionId) {
  const names = ['app', 'api', 'backend', 'bot', 'cli', 'core', 'data', 'frontend',
    'lib', 'plugin', 'proxy', 'server', 'service', 'tool', 'web', 'worker'];
  const name = names[parseInt(sessionId.slice(0, 4), 16) % names.length];
  const suffix = sessionId.slice(0, 4);
  // 模拟一个类似 C:\Users\dev\projects\{name}-{suffix} 的路径
  const path = `C:\\Users\\dev\\projects\\${name}-${suffix}`;
  return path
    .toLowerCase()
    .replace(/^[a-z]:/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function generateTraceparent() {
  const traceId = crypto.randomBytes(16).toString('hex');
  const parentId = crypto.randomBytes(8).toString('hex');
  return `00-${traceId}-${parentId}-01`;
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function getDateStr() {
  return new Date().toISOString().slice(0, 10);
}

function getEnvironment() {
  return `${process.platform}-${process.arch}, Node.js ${process.version.slice(1)}`;
}

// ── CC 请求体构建 ─────────────────────────────────

// 从 data URI 判断媒体类型：'video' | 'image' | 'audio' | null
function mediaKindOfUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/^data:([a-z]+\/[\w.+-]+)/i);
  if (!m) return null;
  const top = m[1].toLowerCase().split('/')[0];
  return ['video', 'image', 'audio'].includes(top) ? top : null;
}

// 转换 messages 为 CC 格式（OpenAI chat 消息 → CC messages）
function buildCcMessages(chatMessages, toolNameMap) {
  return chatMessages.map(msg => {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        return { role: 'user', content: [{ type: 'text', text: msg.content }] };
      }
      if (Array.isArray(msg.content)) {
        const parts = msg.content.map(part => {
          if (part.type === 'image_url') {
            const url = part.image_url?.url || '';
            // 按 data URI 的真实 MIME 决定 part 类型：
            // 以前不管内容是什么都塞成 image，视频会被伪装成图片发给上游
            // （实测 data:video/mp4 → {type:"image"}），模型自然处理不了。
            const kind = mediaKindOfUrl(url);
            if (kind === 'video') return { type: 'video_url', video_url: { url } };
            if (kind === 'audio') return { type: 'audio_url', audio_url: { url } };
            return { type: 'image', image: url };   // CC CLI 真实格式
          }
          return part;                               // video_url / audio_url 等原样透传
        }).filter(Boolean);
        return { role: 'user', content: parts };
      }
      return { role: 'user', content: [{ type: 'text', text: String(msg.content) }] };
    }
    if (msg.role === 'assistant') {
      const parts = [];
      if (msg.content && typeof msg.content === 'string') {
        parts.push({ type: 'text', text: msg.content });
      } else if (msg.content && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') parts.push(part);
        }
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.function?.name || '',
            input: (typeof tc.function?.arguments === 'string' ? tryParseJSON(tc.function.arguments) : (tc.function?.arguments || {})),
          });
        }
      }
      return { role: 'assistant', content: parts };
    }
    if (msg.role === 'tool') {
      // tool 内容可能是字符串，也可能是多模态数组（工具返回图片/视频）。
      // 以前一律 JSON.stringify 成一段文本，媒体就退化成了 base64 字符串文本，
      // 模型无法把它当媒体看。这里拆成 tool-result（文本）+ 同一消息内的媒体 part。
      let textValue;
      const mediaParts = [];
      if (typeof msg.content === 'string') {
        textValue = msg.content;
      } else if (Array.isArray(msg.content)) {
        textValue = msg.content
          .filter(c => c && (c.type === 'text' || c.type === 'input_text'))
          .map(c => c.text || '')
          .join('');
        for (const c of msg.content) {
          if (c && (c.type === 'image_url' || c.type === 'video_url' || c.type === 'audio_url')) mediaParts.push(c);
          else if (c && (c.type === 'image' || c.type === 'video' || c.type === 'audio' || c.type === 'document')) {
            mediaParts.push(anthropicMediaToOpenAI(c));
          }
        }
      } else {
        textValue = JSON.stringify(msg.content ?? '');
      }

      const toolResult = {
        type: 'tool-result',
        toolCallId: msg.tool_call_id,
        toolName: toolNameMap[msg.tool_call_id] || msg.name || '',
        output: { type: 'text', value: textValue },
      };
      if (mediaParts.length === 0) {
        return { role: 'tool', content: [toolResult] };
      }
      // 媒体随结果一起交给上游；文本为空时补占位说明
      const parts = [];
      if (!textValue) toolResult.output.value = `[tool result attached ${mediaParts.length} media file(s)]`;
      parts.push(toolResult);
      parts.push(...mediaParts);
      return { role: 'tool', content: parts };
    }
    return msg;
  });
}

function buildCcRequest(openaiReq) {
  const { model, messages, max_tokens, temperature, tools, stream, reasoning_effort, tool_choice, parallel_tool_calls } = openaiReq;

  // 从 messages 中提取 system prompt
  const systemMsgs = messages.filter(m => m.role === 'system');
  const systemPrompt = systemMsgs.map(m => m.content).join('\n');
  const chatMessages = messages.filter(m => m.role !== 'system');

  // Build tool_call_id → tool_name reverse lookup
  const toolNameMap = {};
  for (const msg of chatMessages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) {
          toolNameMap[tc.id] = tc.function?.name || '';
        }
      }
    }
  }

  const ccMessages = buildCcMessages(chatMessages, toolNameMap);

  const threadId = newThreadId();

  const body = {
    config: {
      workingDir: process.cwd(),
      date: getDateStr(),
      environment: getEnvironment(),
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: '',
    permissionMode: 'standard',
    params: {
      model: model || 'deepseek/deepseek-v4-flash',
      messages: ccMessages,
      max_tokens: Math.min(max_tokens || 64000, 200000),
      stream: true,  // CC API 总是 stream
    },
  };

  // 条件字段
  if (systemPrompt) {
    body.params.system = systemPrompt;
  }
  if (temperature !== undefined) {
    body.params.temperature = temperature;
  }
  if (reasoning_effort !== undefined) {
    body.params.reasoning_effort = reasoning_effort;
  }
  if (tools && tools.length > 0) {
    body.params.tools = tools.map(t => ({
      type: t.type || 'function',
      name: t.function?.name || t.name || '',
      description: t.function?.description || t.description || '',
      input_schema: t.function?.parameters || t.input_schema || { type: 'object', properties: {} },
    }));
  }
  if (tool_choice !== undefined) {
    // OpenAI 格式 → CC (Anthropic 风格) 格式
    if (typeof tool_choice === 'string') {
      const map = { 'auto': 'auto', 'none': 'none', 'required': 'any' };
      body.params.tool_choice = { type: map[tool_choice] || 'auto' };
    } else if (tool_choice.type === 'function') {
      // OpenAI object → Anthropic object
      body.params.tool_choice = { type: 'tool', name: tool_choice.function?.name };
    } else {
      body.params.tool_choice = tool_choice;
    }
  }
  if (parallel_tool_calls !== undefined) {
    body.params.parallel_tool_calls = parallel_tool_calls;
  }

  return body;
}

function tryParseJSON(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

// ── CC NDJSON → OpenAI SSE 转换 ────────────────────

function createSseTranslator(model, completionId, created) {
  let chunkIndex = 0;
  let sentRole = false;
  let finishReason = null;
  let usage = null;
  let toolCallIndex = 0;

  return {
    lastCcEvent: '',
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    /** 解析一行 NDJSON，返回 OpenAI chunk 数组 */
    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) return null;

      let event;
      try { event = JSON.parse(trimmed); } catch { return null; }
      if (!event.type) return null;
      this.lastCcEvent = event.type;

      const out = [];

      switch (event.type) {
        case 'text-start':
        case 'reasoning-start':
        case 'start':
        case 'start-step':
          // 忽略，无用户可见内容
          break;

        case 'text-delta': {
          const text = event.text || event.delta || '';
          if (!text) break;
          const delta = chunkIndex === 0 ? { role: 'assistant', content: text } : { content: text };
          chunkIndex++;
          sentRole = true;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'reasoning-delta': {
          const text = event.text || '';
          if (!text) break;
          const delta = chunkIndex === 0
            ? { role: 'assistant', reasoning_content: text }
            : { reasoning_content: text };
          chunkIndex++;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'tool-call': {
          const id = event.toolCallId || `call_${Date.now()}_${toolCallIndex}`;
          const name = event.toolName || '';
          const args = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});
          const tcEntry = { index: toolCallIndex, id, type: 'function', function: { name, arguments: args } };
          const delta = chunkIndex === 0
            ? { role: 'assistant', content: null, tool_calls: [tcEntry] }
            : { tool_calls: [tcEntry] };
          chunkIndex++;
          toolCallIndex++;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'finish-step': {
          if (event.finishReason) finishReason = mapFinishReason(event.finishReason);
          if (event.usage) {
            usage = event.usage;
            this.inputTokens = event.usage.inputTokens ?? 0;
            this.outputTokens = event.usage.outputTokens ?? 0;
            this.cachedInputTokens = event.usage.cachedInputTokens ?? 0;
          }
          break;
        }

        case 'finish': {
          const fr = finishReason || mapFinishReason(event.finishReason || 'stop');
          const u = event.totalUsage || usage || {};
          normalizeUsage(u);
          this.inputTokens = u.inputTokens ?? 0;
          this.outputTokens = u.outputTokens ?? 0;
          this.cachedInputTokens = u.cachedInputTokens ?? 0;
          const openaiUsage = u ? {
            prompt_tokens: u.inputTokens ?? 0,
            completion_tokens: u.outputTokens ?? 0,
            total_tokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
            prompt_tokens_details: { cached_tokens: u.cachedInputTokens ?? 0 },
          } : undefined;
          out.push(makeChunk(completionId, created, model, {}, fr, openaiUsage));
          break;
        }

        case 'error': {
          const msg = event.error?.message || event.message || 'Unknown error';
          log('warn', 'CC stream error', { message: msg });
          // Don't emit a finish_reason chunk — let the natural stream termination
          // handle it. Otherwise a subsequent finish(tool_calls) would be ignored
          // by downstream agent loops that stop at the first finish_reason.
          break;
        }

        case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
          // Silent - no user-visible content
          break;
        default:
          log('warn', 'Unknown CC event type', { type: event.type });
          break;
      }

      return out.length > 0 ? out : null;
    },

    /** 获取 SSE 结束标记 */
    getDoneEvent() {
      return 'data: [DONE]\n\n';
    },
  };
}

function makeChunk(id, created, model, delta, finishReason, usage) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason || null }],
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// normalize CC usage stats:
// - outputTokens=0 → zero everything (anti false billing)
function normalizeUsage(u) {
  if (!u) return;
  const ot = Number(u.outputTokens);
  if (!ot) {  // 0, null, undefined, NaN → zero input + cached (anti false billing)
    u.inputTokens = 0;
    u.cachedInputTokens = 0;
  }
}

function mapFinishReason(reason) {
  switch (reason) {
    case 'tool-calls': return 'tool_calls';
    case 'length': return 'length';
    case 'stop': return 'stop';
    default: return reason || 'stop';
  }
}

// ── 错误映射 ───────────────────────────────────────
const CC_STATUS_MAP = {
  400: { status: 400, type: 'invalid_request_error' },
  401: { status: 401, type: 'authentication_error' },
  402: { status: 429, type: 'rate_limit_error' },       // payment required → rate limit
  403: { status: 401, type: 'authentication_error' },
  404: { status: 404, type: 'not_found' },
  422: { status: 400, type: 'invalid_request_error' },
  429: { status: 429, type: 'rate_limit_error' },
  500: { status: 502, type: 'upstream_error' },
  502: { status: 502, type: 'upstream_error' },
  503: { status: 503, type: 'temporarily_unavailable' },
};

function mapCcError(ccStatus, ccBody) {
  const mapped = CC_STATUS_MAP[ccStatus] || { status: 502, type: 'upstream_error' };
  let message = `CC API error (${ccStatus})`;

  if (ccBody) {
    try {
      const parsed = JSON.parse(ccBody);
      message = parsed.error?.message || parsed.message || message;
    } catch {
      message = ccBody.slice(0, 200) || message;
    }
  }

  // CC 429 响应可能带 retry-after
  if (ccStatus === 429) {
    return {
      status: 429,
      body: {
        error: { message, type: 'rate_limit_error' },
        retry_after: 30,
      },
    };
  }

  return { status: mapped.status, body: { error: { message, type: mapped.type } } };
}

// ── HTTP 请求处理 ──────────────────────────────────

// 请求体超限错误：带上状态码与提示，供上层回一个规范的 HTTP 错误
class BodyTooLargeError extends Error {
  constructor(size) {
    super(`Request body too large: ${(size / 1048576).toFixed(1)}MB exceeds limit of ${(MAX_BODY_SIZE / 1048576).toFixed(0)}MB`);
    this.name = 'BodyTooLargeError';
    this.status = 413;
    this.size = size;
  }
}

// 读请求体。超限时**不能**调用 req.destroy() 就完事 —— 那会把连接直接掐断，
// 客户端只收到裸 ECONNRESET，没有任何状态码和错误体，只能不停重连
// （实测：Z Code 发视频就是这么卡在"正在重连中"的）。
// 正确做法：停止累积、把剩余数据读完丢弃，然后让上层回一个规范的 413。
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;
    let overflowed = false;

    req.on('data', c => {
      totalSize += c.length;
      if (overflowed) return;                    // 已超限：继续消费但不保留
      if (totalSize > MAX_BODY_SIZE) {
        overflowed = true;
        chunks.length = 0;                       // 释放已缓冲的内存
        reject(new BodyTooLargeError(totalSize));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (overflowed) return;                    // 已 reject，等连接自然收尾
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
    req.on('aborted', () => { if (!overflowed) reject(new Error('Request aborted')); });
  });
}

function sendJSON(res, status, data) {
  const headers = { 'Content-Type': 'application/json' };
  if (data && data.retry_after !== undefined) {
    headers['Retry-After'] = String(data.retry_after);
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function getApiKey(headers) {
  // Try Authorization: Bearer header (OpenAI SDK style)
  const auth = headers['authorization'] || headers['Authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const match = auth.slice(7).match(/user_[a-zA-Z0-9_-]+/);
    if (match) return match[0];
  }
  // Fall back to x-api-key header (Anthropic SDK style)
  const xKey = headers['x-api-key'] || headers['X-Api-Key'] || '';
  if (xKey) {
    const match = xKey.match(/user_[a-zA-Z0-9_-]+/);
    if (match) return match[0];
  }
  return null;
}

// ── 流式转发 ────────────────────────────────────────

async function forwardToCC(body, apiKey, incomingHeaders = {}, signal) {
  return track(doForwardToCC(body, apiKey, incomingHeaders, signal));
}

async function doForwardToCC(body, apiKey, incomingHeaders = {}, signal) {
  const url = `${CFG.apiBase}/alpha/generate`;
  const traceparent = generateTraceparent();
  const sessionId = getSessionId(incomingHeaders, apiKey);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'x-cli-environment': 'production',
      'x-command-code-version': CC_VERSION,
      'x-session-id': sessionId,
      'x-co-flag': 'false',
      'x-taste-learning': 'false',
      'x-project-slug': fakeProjectSlug(sessionId),
      'traceparent': traceparent,
    },
    body: JSON.stringify(body),
    signal,
  });

  return response;
}

// ── 路由 ────────────────────────────────────────────

async function handleChatCompletions(req, res) {
  let openaiReq;
  try {
    openaiReq = await readBody(req);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      log('warn', 'Request body too large', { sizeMB: +(e.size / 1048576).toFixed(1), limitMB: MAX_BODY_SIZE / 1048576 });
      sendJSON(res, 413, {
        error: {
          message: `Request body too large (${(e.size / 1048576).toFixed(1)}MB > ${(MAX_BODY_SIZE / 1048576).toFixed(0)}MB limit). `
            + 'Large media (video/image base64) is usually the cause; raise maxBodySize in config.json if you need more.',
          type: 'invalid_request_error',
        },
        retry_after: 0,
      });
      return;
    }
    sendJSON(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
    return;
  }

  const apiKey = getApiKey(req.headers);
  if (!apiKey) {
    sendJSON(res, 401, { error: { message: 'Missing API key. Send in Authorization: Bearer <key> or x-api-key header', type: 'auth_error' } });
    return;
  }

  const stream = openaiReq.stream === true;
  const model = openaiReq.model || 'deepseek/deepseek-v4-flash';
  const completionId = `chatcmpl-${randomUUID().slice(0, 12)}`;
  const created = nowUnix();

  // 构建 CC 请求体
  const ccBody = buildCcRequest(openaiReq);

  // AbortController 用于客户端断连时真正打断 CC 上游（pi-commandcode-provider 模式）
  const abortController = new AbortController();
  let aborted = false;
  // 提前初始化，断连回调/超时 catch 安全引用（避免块级作用域 ReferenceError）
  const startTime = Date.now();
  let bytesReceived = 0; let lastCcEvent = ''; let keepaliveCount = 0; let fullText = '';
  let reader = null;
  let translator = null;

  try {
    // 首次初始化（fingerprint + lifecycle）
    await ensureInitialized(apiKey, abortController.signal);
    // 转发到 CC API（传入客户端 headers，用于提取 session ID）
    const ccResponse = await forwardToCC(ccBody, apiKey, req.headers, abortController.signal);

    if (!ccResponse.ok) {
      const errorText = await ccResponse.text().catch(() => '');
      log('error', 'CC API error', { status: ccResponse.status });
      const mapped = mapCcError(ccResponse.status, errorText);
      sendJSON(res, mapped.status, mapped.body);
      return;
    }

    // 下游断连检测：打断 CC 上游 + 记录日志
    res.on('close', () => {
      if (res.writableEnded) return; // Normal completion, not a disconnect
      aborted = true;
      const reason = lastCcEvent?.startsWith('tool-input') ? 'tool-input-silent-timeout'
        : lastCcEvent?.includes('delta') ? 'streaming-active-disconnect'
        : 'client-hangup';
      abortController.signal.aborted || log('warn', 'Client disconnected', {
        path: '/v1/chat/completions',
        model, completionId, reason,
        streaming: stream,
        elapsedMs: Date.now() - startTime,
        bytesSent: bytesReceived,
        lastCcEvent: lastCcEvent || '(none)',
        keepaliveCount,
        inputTokens: translator?.inputTokens ?? 0,
        outputTokens: translator?.outputTokens ?? 0,
        cachedInputTokens: translator?.cachedInputTokens ?? 0,
      });
      if (!abortController.signal.aborted) {
        // 断连前抢发 usage=0 终止 chunk，避免下游自行估算 token
        try {
          res.write(`data: ${JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
          })}\n\n`);
          res.write('data: [DONE]\n\n');
        } catch {}
        try { abortController.abort(); } catch {}
      }
    });

    if (stream) {
      // ── 流式响应 ──
      translator = createSseTranslator(model, completionId, created);
      let buffer = '';
      let started = false; // 延迟写 200 header，超时/output=0 时返回 JSON 429/502 让 SDK 自动重试
      const decoder = new TextDecoder();
      reader = ccResponse.body.getReader();

      try {
        while (true) {
          const result = await Promise.race([
            reader.read(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('STREAM_IDLE_TIMEOUT')), STREAM_IDLE_TIMEOUT_MS)
            ),
          ]);
          const { done, value } = result;
          if (done) break;
          if (aborted) break;
          bytesReceived += value.length;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          let hadOutput = false;
          for (const line of lines) {
            const events = translator.parseLine(line);
            if (events) {
              if (!started) {
                res.writeHead(200, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Connection': 'keep-alive',
                  'X-Accel-Buffering': 'no',
                });
                started = true;
              }
              for (const evt of events) res.write(evt);
              hadOutput = true;
            }
            if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent;
          }
          // silent events 期间发 keepalive，防止客户端超时断开
          if (started && !hadOutput) { try { res.write(': keepalive\n\n'); keepaliveCount++; } catch {} }
        }

        if (!aborted) {
          // 成功完成一次请求，重置连续超时计数
          consecutiveTimeouts = 0;
          // 处理剩余 buffer
          if (buffer.trim()) {
            const events = translator.parseLine(buffer);
            if (events) {
              if (!started) started = true;
              for (const evt of events) res.write(evt);
            }
          }
          // 输出 token 为 0 时记为错误，避免下游异常计费
          if (translator.outputTokens === 0) {
            try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
            if (!started) {
              sendJSON(res, 429, { error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 });
              return;
            }
            try { res.write(`data: ${JSON.stringify({ error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 })}\n\n`); } catch {}
          } else {
            if (!started) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
              });
              started = true;
            }
            res.write(translator.getDoneEvent());
          }
        }
      } catch (e) {
        if (aborted) {
          // 客户端已断连，只清理（close handler 已调用 abortController.abort()）
          try { reader.cancel(); } catch {}
        } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
          log('warn', 'Stream idle timeout', {
            path: '/v1/chat/completions',
            model,
            streaming: true,
            timeoutMs: STREAM_IDLE_TIMEOUT_MS,
            elapsedMs: Date.now() - startTime,
            id: completionId,
            bytesReceived,
            lastCcEvent: lastCcEvent || '(none)',
            inputTokens: translator.inputTokens,
            outputTokens: translator.outputTokens,
            cachedInputTokens: translator.cachedInputTokens,
          });
          try { reader.cancel(); } catch {}
          try { abortController.abort(); } catch {} // 打断 CC 上游，避免浪费 token
          consecutiveTimeouts++;
          const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
            ? 'Response timeout - try reducing context length (summarize earlier messages)'
            : 'Response timeout - request timed out';
          if (!started) {
            sendJSON(res, 429, { error: { message: timeoutMsg, type: 'rate_limit_error', input_tokens: 0 }, retry_after: 5 });
            return;
          }
          if (!res.writableEnded) {
            try { res.write(`data: ${JSON.stringify({ error: { message: timeoutMsg, type: 'rate_limit_error' }, retry_after: 5 })}\n\n`); } catch {}
            try { res.destroy(); } catch {}
          }
        } else {
          log('error', 'Stream error', { message: e.message });
          try { abortController.abort(); } catch {} // 打断 CC 上游
          if (!started) {
            sendJSON(res, 502, { error: { message: `Upstream error: ${e.message}`, type: 'proxy_error', input_tokens: 0 }, retry_after: 10 });
            return;
          }
          if (!res.writableEnded) {
            try { res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'proxy_error' } })}\n\n`); } catch {}
          }
        }
      }

      if (!res.writableEnded) res.end();
    } else {
      // ── 非流式响应（缓冲完整 NDJSON）──
      let reasoningContent = '';
      let finishReason = 'stop';
      let usage = null;
      let toolCalls = null;

      reader = ccResponse.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      const processLines = () => {
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) continue;
          try {
            const event = JSON.parse(trimmed);
            switch (event.type) {
              case 'text-delta': lastCcEvent = event.type; fullText += event.text || ''; break;
              case 'reasoning-delta': lastCcEvent = event.type; reasoningContent += event.text || ''; break;
              case 'tool-call':
                lastCcEvent = event.type;
                toolCalls = toolCalls || [];
                toolCalls.push({
                  id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                  type: 'function',
                  function: {
                    name: event.toolName || '',
                    arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}),
                  },
                });
                break;
              case 'finish':
                lastCcEvent = event.type;
                finishReason = mapFinishReason(event.finishReason || 'stop');
                if (event.totalUsage) usage = event.totalUsage;
                break;
              case 'error':
                lastCcEvent = event.type;
                log('warn', 'CC stream error (non-stream)', { message: event.error?.message || event.message });
                break;
              case 'start': case 'start-step': case 'text-start': case 'reasoning-start': case 'finish-step':
                // Signal / bookkeeping events, no user-visible content
                break;
              case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-end': case 'tool-error': case 'text-end':
                // Silent - no user-visible content
                break;
              default:
                log('warn', 'Unknown CC event type', { type: event.type });
                break;
            }
          } catch {}
        }
      };

      while (true) {
        const result = await Promise.race([
          reader.read(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('STREAM_IDLE_TIMEOUT')), NONSTREAM_IDLE_TIMEOUT_MS)
          ),
        ]);
        const { done, value } = result;
        if (done) break;
        bytesReceived += value.length;
        buf += decoder.decode(value, { stream: true });
        processLines();
      }
      processLines();

      // 输出 token 为 0 时记为错误，避免下游异常计费
      if ((usage?.outputTokens ?? 0) === 0) {
        try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
        sendJSON(res, 429, { error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 });
        return;
      }

      consecutiveTimeouts = 0;
      sendJSON(res, 200, {
        id: completionId,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message: Object.assign(
            { role: 'assistant', content: fullText || null },
            toolCalls ? { tool_calls: toolCalls } : {},
            reasoningContent ? { reasoning_content: reasoningContent } : {},
          ),
          finish_reason: finishReason,
        }],
    usage: (() => {
      if (!usage) usage = {};
      normalizeUsage(usage);
      return {
        prompt_tokens: usage.inputTokens ?? 0,
        completion_tokens: usage.outputTokens ?? 0,
        total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        prompt_tokens_details: { cached_tokens: usage.cachedInputTokens ?? 0 },
      };
    })(),
      });
    }
  } catch (e) {
    if (abortController.signal.aborted) {
      log('warn', 'Request cancelled (client disconnected before CC response)', {
        path: '/v1/chat/completions',
        model,
        completionId,
      });
    } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
      log('warn', 'Stream idle timeout', {
        path: '/v1/chat/completions',
        model,
        streaming: false,
        timeoutMs: NONSTREAM_IDLE_TIMEOUT_MS,
        elapsedMs: Date.now() - startTime,
        id: completionId,
        bytesReceived,
        lastCcEvent: lastCcEvent || '(none)',
        partialLen: fullText ? fullText.length : 0,
      });
      try { reader?.cancel(); } catch {}
      try { abortController.abort(); } catch {} // 打断 CC 上游
      consecutiveTimeouts++;
      const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
        ? 'Response timeout - try reducing context length (summarize earlier messages)'
        : 'Response timeout - request timed out';
      res.setHeader('Retry-After', '5');
      sendJSON(res, 429, { error: { message: timeoutMsg, type: 'rate_limit_error', input_tokens: 0 }, retry_after: 5 });
    } else {
      log('error', 'Upstream error', { message: e.message });
      try { abortController.abort(); } catch {} // 打断 CC 上游
      sendJSON(res, 502, { error: { message: `Upstream error: ${e.message}`, type: 'proxy_error', input_tokens: 0 }, retry_after: 10 });
    }
  }
}

// ── Anthropic /v1/messages 协议转换 ─────────────────

function mapAnthropicStopReason(finishReason) {
  switch (finishReason) {
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'stop': return 'end_turn';
    default: return 'end_turn';
  }
}

// Generate a Claude-format fake signature for thinking blocks.
// Anthropic validates thinking signatures cryptographically; third-party
// proxies cannot mint valid ones. Claude Code's shallow check only requires
// base64 starting with 'E' (single-layer) / 'R' (double-layer) with payload
// first byte 0x12 — this satisfies that, letting CC display thinking.
// The payload is derived from the thinking text so each block's signature
// differs (closer to spec, avoids identical-signature quirks).
function fakeThinkingSignature(thinkingText) {
  const seed = crypto.createHash('sha256').update(thinkingText || 'dsh-proxy-thinking').digest().subarray(0, 64);
  const raw = Buffer.concat([Buffer.from([0x12, seed.length]), seed]);
  return raw.toString('base64');
}

function buildAnthropicResponse(model, fullText, toolCalls, finishReason, usage, thinkingText) {
  const content = [];
  if (thinkingText) content.push({ type: 'thinking', thinking: thinkingText, signature: fakeThinkingSignature(thinkingText) });
  if (fullText) content.push({ type: 'text', text: fullText });
  if (toolCalls) {
    for (const tc of toolCalls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
  }
  return {
    id: `msg_${randomUUID().slice(0, 12)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapAnthropicStopReason(finishReason || 'stop'),
    stop_sequence: null,
    usage: (() => {
      normalizeUsage(usage || {});
      return {
        input_tokens: usage?.inputTokens ?? 0,
        output_tokens: usage?.outputTokens ?? 0,
        cache_creation_input_tokens: usage?.inputTokenDetails?.cacheWriteTokens ?? null,
        cache_read_input_tokens: usage?.cachedInputTokens ?? 0,
      };
    })(),
  };
}

// Anthropic 媒体块 → OpenAI 风格 content part
//   { type:'image', source:{ type:'base64', media_type:'image/png', data:'...' } }
//   { type:'video', source:{ type:'base64', media_type:'video/mp4', data:'...' } }
//   { type:'image', source:{ type:'url', url:'https://...' } }
// 转成 data URI（base64）或直接 URL，并按 MIME 标成 image_url / video_url / audio_url。
function anthropicMediaToOpenAI(block) {
  const kind = block.type;                    // image | video | audio | document
  const src = block.source || {};
  let url = '';
  if (src.type === 'base64' && src.data) {
    url = `data:${src.media_type || `${kind}/octet-stream`};base64,${src.data}`;
  } else if (src.type === 'url' && src.url) {
    url = src.url;
  } else if (typeof block.data === 'string') {
    url = `data:${block.media_type || `${kind}/octet-stream`};base64,${block.data}`;
  }

  // block.type 与 data URI 的顶层类型都可能表明媒体种类，取更具体的那个
  const byMime = mediaKindOfUrl(url);
  const resolved = byMime || (kind === 'document' ? null : kind);

  if (resolved === 'video') return { type: 'video_url', video_url: { url } };
  if (resolved === 'audio') return { type: 'audio_url', audio_url: { url } };
  if (resolved === 'image') return { type: 'image_url', image_url: { url } };
  return { type: 'text', text: `[${kind} attachment omitted]` };
}

function convertAnthropicToOpenAI(anthropicReq) {
  // 1. Extract system prompt (top-level, not in messages array)
  let systemPrompt = '';
  if (anthropicReq.system) {
    if (typeof anthropicReq.system === 'string') {
      systemPrompt = anthropicReq.system;
    } else if (Array.isArray(anthropicReq.system)) {
      systemPrompt = anthropicReq.system
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    }
  }

  // 2. Build tool name map + convert messages
  const toolNameFromId = {};
  const openaiMessages = [];

  if (systemPrompt) {
    openaiMessages.push({ role: 'system', content: systemPrompt });
  }

  const messages = anthropicReq.messages || [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      let textContent = '';
      const toolCalls = [];
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content || '' }];
      for (const block of blocks) {
        if (block.type === 'text') {
          textContent += block.text || '';
        } else if (block.type === 'tool_use') {
          toolNameFromId[block.id] = block.name;
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          });
        }
      }
      const assistantMsg = { role: 'assistant', content: textContent || null };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      openaiMessages.push(assistantMsg);
    } else if (msg.role === 'user') {
      let textContent = '';
      const toolResults = [];
      const mediaBlocks = [];   // 图片/视频/音频等非文本块
      if (typeof msg.content === 'string') {
        textContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            textContent += block.text || '';
          } else if (block.type === 'tool_result') {
            toolResults.push(block);
          } else if (block.type === 'image' || block.type === 'video' || block.type === 'audio' || block.type === 'document') {
            // Anthropic 媒体块 → 之前既不认也没转，会被静默丢弃
            // （实测：video 块发进来后上游只收到 text，视频凭空消失）
            mediaBlocks.push(block);
          }
        }
      }
      // tool 消息必须紧跟 assistant(tool_calls)：同一条 user 消息里
      // tool_result 先转，用户文本排在后面
      for (const tr of toolResults) {
        const media = [];   // tool_result 里可能夹带媒体块（如 Read 读视频/图片）
        let text;
        if (typeof tr.content === 'string') {
          text = tr.content;
        } else if (Array.isArray(tr.content)) {
          // 以前用 c.text || '' 拼接，非文本块（image/video/document）被整块丢弃，
          // 若结果只有媒体则变成空字符串，模型收到一个空工具结果。
          text = tr.content
            .filter(c => c && c.type === 'text')
            .map(c => c.text || '')
            .join('');
          for (const c of tr.content) {
            if (c && (c.type === 'image' || c.type === 'video' || c.type === 'audio' || c.type === 'document')) {
              media.push(c);
            }
          }
        } else {
          text = String(tr.content || '');
        }

        if (media.length > 0) {
          // 有媒体：带上文本说明（没有就给个占位，避免模型只看到空内容）
          const parts = [{
            type: 'text',
            text: text || `[tool result attached ${media.length} media file(s)]`,
          }];
          for (const m of media) parts.push(anthropicMediaToOpenAI(m));
          openaiMessages.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            name: toolNameFromId[tr.tool_use_id] || '',
            content: parts,
          });
        } else {
          openaiMessages.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            name: toolNameFromId[tr.tool_use_id] || '',
            content: text,
          });
        }
      }
      // 有媒体块时用数组 content（OpenAI 多模态格式），供 buildCcMessages 转换
      if (mediaBlocks.length > 0) {
        const contentParts = [];
        if (textContent) contentParts.push({ type: 'text', text: textContent });
        for (const b of mediaBlocks) contentParts.push(anthropicMediaToOpenAI(b));
        openaiMessages.push({ role: 'user', content: contentParts });
      } else if (textContent) {
        openaiMessages.push({ role: 'user', content: textContent });
      }
    }
  }

  // 2.5 修补工具调用序列（turn 中断恢复的会话常带孤儿 tool_call，上游会整单拒绝）
  repairToolCallSequence(openaiMessages);

  // 3. Build OpenAI request
  const openaiReq = {
    model: anthropicReq.model || 'deepseek/deepseek-v4-flash',
    messages: openaiMessages,
    max_tokens: anthropicReq.max_tokens || 64000,
    stream: anthropicReq.stream === true,
  };

  // 4. Map tools
  if (anthropicReq.tools && anthropicReq.tools.length > 0) {
    openaiReq.tools = anthropicReq.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  }

  // 5. Map tool_choice
  if (anthropicReq.tool_choice) {
    const tc = anthropicReq.tool_choice;
    if (tc.type === 'auto' || tc.type === undefined) {
      openaiReq.tool_choice = 'auto';
    } else if (tc.type === 'any') {
      openaiReq.tool_choice = 'required';
    } else if (tc.type === 'tool') {
      openaiReq.tool_choice = { type: 'function', function: { name: tc.name } };
    } else if (tc.type === 'none') {
      openaiReq.tool_choice = 'none';
    }
  }

  // 6. Optional params
  if (anthropicReq.temperature !== undefined) openaiReq.temperature = anthropicReq.temperature;
  if (anthropicReq.top_p !== undefined) openaiReq.top_p = anthropicReq.top_p;
  if (anthropicReq.stop_sequences) openaiReq.stop = anthropicReq.stop_sequences;
  if (anthropicReq.metadata?.user_id) openaiReq.user = anthropicReq.metadata.user_id;

  // 7. Anthropic thinking → reasoning_effort（LiteLLM 标准映射）
  if (anthropicReq.thinking) {
    const t = anthropicReq.thinking;
    if (t.type === 'disabled' || t.type === 'none') {
      // 不发送 reasoning_effort
    } else if (t.type === 'adaptive') {
      openaiReq.reasoning_effort = t.effort ?? 'medium';
    } else if (t.budget_tokens !== undefined) {
      if (t.budget_tokens >= 10000) openaiReq.reasoning_effort = 'high';
      else if (t.budget_tokens >= 5000) openaiReq.reasoning_effort = 'medium';
      else if (t.budget_tokens >= 2000) openaiReq.reasoning_effort = 'low';
      else openaiReq.reasoning_effort = 'low'; // <2000 → low
    }
  }

  return openaiReq;
}

// OpenAI/CC 消息序列的不变量：assistant.tool_calls 的每个 id 必须由一条 role='tool'
// 消息回复，且紧跟在该 assistant 之后。turn 中断后恢复的会话常带「孤儿 tool_call」
// （客户端没存下 tool_result），上游会整单拒绝：'Tool result is missing for tool call ...'。
// 此处统一修补：孤儿 tool_call 就地合成一条 tool 消息；引用未知 call id 的孤儿
// tool_result 丢弃；所有 tool 消息强制排到对应 assistant 之后。
function repairToolCallSequence(messages) {
  const toolMsgById = new Map(); // call id → 已有的 tool 消息（去重）
  const hasAssistantCalls = [];
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      hasAssistantCalls.push(msg);
    } else if (msg.role === 'tool' && msg.tool_call_id && !toolMsgById.has(msg.tool_call_id)) {
      toolMsgById.set(msg.tool_call_id, msg);
    }
  }
  if (hasAssistantCalls.length === 0 && toolMsgById.size === 0) return;

  const knownCallIds = new Set();
  for (const msg of hasAssistantCalls) {
    for (const tc of msg.tool_calls) if (tc.id) knownCallIds.add(tc.id);
  }

  const syntheticContent = '[Tool execution was interrupted before a result was recorded. Continue without assuming the tool\'s outcome.]';
  const out = [];
  let synthesized = 0;
  let dropped = 0;
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      out.push(msg);
      for (const tc of msg.tool_calls) {
        if (!tc.id) continue;
        const real = toolMsgById.get(tc.id);
        if (real) {
          out.push(real);
        } else {
          out.push({ role: 'tool', tool_call_id: tc.id, name: tc.function?.name || '', content: syntheticContent });
          synthesized++;
        }
      }
    } else if (msg.role === 'tool') {
      // 已排到对应 assistant 之后；引用未知 call id 的重复/孤儿结果在此丢弃
      if (!knownCallIds.has(msg.tool_call_id)) dropped++;
    } else {
      out.push(msg);
    }
  }
  if (synthesized > 0 || dropped > 0) {
    log('warn', 'Repaired tool call sequence (likely an interrupted turn replayed)', {
      synthesized,
      dropped,
      synthesizedFor: [...knownCallIds].filter((id) => !toolMsgById.has(id)),
    });
    messages.length = 0;
    messages.push(...out);
  }
}

/**
 * Async generator that reads CC NDJSON response body and yields
 * Anthropic SSE events for streaming.
 */
async function* createAnthropicSseTranslator(response, model, messageId, ctx) {
  let nextBlockIndex = 0;
  let currentBlockIndex = -1;
  let currentBlockType = null;
  let blockStarted = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteTokens = 0;
  let stopReason = null;
  let hasError = false;
  let currentThinkingText = ''; // accumulated thinking text for the open block
  const startedAt = Date.now();

  // Close the current block (text or thinking) if one is active.
  // For thinking blocks, emit a signature_delta (Anthropic standard) before stop.
  function closeBlock() {
    if (blockStarted) {
      const idx = currentBlockIndex;
      const type = currentBlockType;
      let out = '';
      if (type === 'thinking') {
        out += `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: fakeThinkingSignature(currentThinkingText) } })}\n\n`;
        currentThinkingText = '';
      }
      blockStarted = false;
      currentBlockType = null;
      return out + `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`;
    }
    return '';
  }
  const closeTextBlock = closeBlock;

  // Open a new block of the given type (closing any previous block first)
  function startBlock(type, contentBlock) {
    if (!blockStarted || currentBlockType !== type) {
      const close = closeBlock();
      currentBlockIndex = nextBlockIndex++;
      currentBlockType = type;
      blockStarted = true;
      return close + `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: currentBlockIndex, content_block: contentBlock })}\n\n`;
    }
    return '';
  }

  // Open a new text block (closing any previous block first)
  function startTextBlock() {
    return startBlock('text', { type: 'text', text: '' });
  }

  // Open a new thinking block (closing any previous block first)
  function startThinkingBlock() {
    return startBlock('thinking', { type: 'thinking', thinking: '' });
  }

  // Emit message_start (always the first event；透明重试的第二跳复用同一 message，跳过重复的 message_start)
  if (!ctx?.skipMessageStart) {
    yield `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    })}\n\n`;
  }

  // 上游静默时周期性 resolve 的信号：消费端借此向客户端发 keepalive，
  // 防止 thinking/排队期客户端读超时重连（OpenAI 路径的 : keepalive 同理）。
  // 注意：readPromise 必须跨轮复用 —— 若每轮 race 重新调 reader.read()，
  // tick 胜出后旧 read promise 被遗弃，上游数据会推给旧 promise 而丢失。
  let keepaliveTick = null;
  let keepaliveTimer = null;
  const armKeepalive = () => {
    if (keepaliveTimer) clearTimeout(keepaliveTimer);
    keepaliveTick = new Promise((resolveTick) => {
      keepaliveTimer = setTimeout(resolveTick, SSE_KEEPALIVE_INTERVAL_MS);
    });
  };
  armKeepalive();

  // 单行 CC NDJSON → 若干 Anthropic SSE 事件字符串。生成器里不能把 yield 包进
  // 普通函数，故返回数组由调用方逐个 yield；主循环与上游关流时的末行 flush 共用，
  // 保证最后一行（无尾换行的 finish/usage）不丢。
  const processCcLine = (line, eventsOut) => {
    let hadOutput = false;
    const trimmed = line.trim();
    if (!trimmed || trimmed === '[DONE]') return hadOutput;
    let event;
    try { event = JSON.parse(trimmed); } catch { return hadOutput; }
    if (!event.type) return hadOutput;
    const prevCcEvent = ctx.lastCcEvent;
    ctx.lastCcEvent = event.type;
    switch (event.type) {
      case 'start': case 'start-step': case 'text-start': case 'reasoning-start':
        // Signal events, no user-visible data
        break;

      case 'reasoning-delta': {
        // CC reasoning → Anthropic thinking block (Claude Code shows this as thinking)
        const text = event.text || '';
        if (!text) break;
        ctx.contentYielded = true;
        const startBlock = startThinkingBlock();
        currentThinkingText += text;
        eventsOut.push(startBlock + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'thinking_delta', thinking: text } })}\n\n`);
        hadOutput = true;
        break;
      }

      case 'text-delta': {
        const text = event.text || '';
        ctx.contentYielded = true;
        const startBlock = startTextBlock();
        eventsOut.push(startBlock + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'text_delta', text } })}\n\n`);
        outputTokens += 1;
        hadOutput = true;
        break;
      }

      case 'tool-call': {
        // Close any pending text block
        ctx.contentYielded = true;
        const closeBlock = closeTextBlock();
        if (closeBlock) eventsOut.push(closeBlock);

        const id = event.toolCallId || `toolu_${randomUUID().slice(0, 12)}`;
        const name = event.toolName || '';
        const input = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});

        const tcIndex = nextBlockIndex++;
        eventsOut.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: tcIndex, content_block: { type: 'tool_use', id, name, input: {} } })}\n\n`);
        eventsOut.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: tcIndex, delta: { type: 'input_json_delta', partial_json: input } })}\n\n`);
        eventsOut.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: tcIndex })}\n\n`);
        outputTokens += 20;
        break;
      }

      case 'finish-step':
      case 'finish': {
        if (event.finishReason) stopReason = mapAnthropicStopReason(event.finishReason);
        const u = event.totalUsage || event.usage;
        if (u) {
          normalizeUsage(u);
          inputTokens = u.inputTokens ?? inputTokens;
          // 上游中间 step 可能上报 0（如未计 reasoning），不能让它抹掉按 delta
          // 累计的真实输出 —— 那会把有内容的响应误判为空响应
          if (u.outputTokens > 0) outputTokens = u.outputTokens;
          cachedInputTokens = u.cachedInputTokens ?? cachedInputTokens;
          cacheWriteTokens = u.inputTokenDetails?.cacheWriteTokens ?? cacheWriteTokens;
        } else {
          // 无 usage 上报时以上游累计的可见输出兜底，避免把真实输出误判为空响应
          inputTokens = 0;
          cachedInputTokens = 0;
          cacheWriteTokens = 0;
        }
        ctx.inputTokens = inputTokens;
        ctx.outputTokens = outputTokens;
        ctx.cachedInputTokens = cachedInputTokens;
        break;
      }

      case 'error': {
        // 只记录、不立即转发：错误事件立刻转发会让客户端 fail 整个 turn，
        // 也断绝了「尚未发内容就透明重试」的机会；统一推迟到 finalize 处理。
        hasError = true;
        ctx.hasError = true;
        ctx.lastError = event.error?.message || event.message || 'Unknown CC error';
        log('error', 'CC stream error event', {
          messageId,
          message: ctx.lastError,
          prevCcEvent: prevCcEvent || '(none)',
          bytesReceived: ctx.bytesReceived,
          elapsedMs: Date.now() - startedAt,
        });
        break;
      }

      case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
        // Silent - no user-visible content
        break;
      default:
        log('warn', 'Unknown CC event type', { type: event.type });
        break;
    }
    return hadOutput;
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let readPromise = reader.read();

  try {
    while (true) {
      let idleTimer = null;
      const winner = await Promise.race([
        readPromise.then((v) => ({ kind: 'read', v })),
        keepaliveTick.then(() => ({ kind: 'keepalive' })),
        new Promise((_, reject) => {
          idleTimer = setTimeout(() => reject(new Error('STREAM_IDLE_TIMEOUT')), STREAM_IDLE_TIMEOUT_MS);
        }),
      ]).finally(() => { if (idleTimer) clearTimeout(idleTimer); }); // 每轮清理，避免定时器堆积拖慢进程退出
      if (winner.kind === 'keepalive') {
        // 直接向客户端发 SSE 注释行：SDK 忽略注释但连接保持活跃，
        // 防止 thinking/排队期客户端读超时而「重连中」
        armKeepalive();
        yield ': keepalive\n\n';
        continue; // readPromise 仍挂在 race 里，数据不会丢
      }
      const { done, value } = winner.v;
      if (done) {
        // 上游关流：flush 解码器残留 + 处理最后一行（无尾换行的 finish/usage 不再被丢弃）
        buffer += decoder.decode();
        const finalEvents = [];
        processCcLine(buffer, finalEvents);
        for (const ev of finalEvents) yield ev;
        break;
      }
      readPromise = reader.read(); // 本轮 read 已 settle，为下一轮取新 promise
      armKeepalive();
      ctx.bytesReceived += value.length;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let hadOutput = false;
      const events = [];
      for (const line of lines) {
        if (processCcLine(line, events)) hadOutput = true;
      }
      for (const ev of events) yield ev;
      ctx.hadOutput = hadOutput; // 供消费端判断本批是否发 keepalive
    }

    // Finalize — 正常收尾，或（不可透明重试时的）错误/空响应终止
    if ((hasError || outputTokens === 0) && ctx.decideFinalize?.() === 'retry') {
      // 尚未向客户端发过任何内容且还有重试额度：不收尾、不发事件，
      // 由消费端换新上游连接重试（message_start 已发出，第二跳跳过）
      ctx.retryRequested = true;
      return;
    }
    if (!hasError && outputTokens > 0) {
      const closeBlock = closeTextBlock();
      if (closeBlock) yield closeBlock;

      yield `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: stopReason || 'end_turn' },
        usage: { output_tokens: outputTokens, cache_read_input_tokens: cachedInputTokens, cache_creation_input_tokens: cacheWriteTokens ?? 0, input_tokens: inputTokens },
      })}\n\n`;

      yield `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
      ctx.sentStop = true;
    } else {
      if (hasError) {
        yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'internal_error', message: ctx.lastError || 'Unknown CC error' } })}\n\n`;
      } else {
        // 输出 token 为 0 时记为错误，避免下游异常计费
        log('warn', 'CC zero output tokens', {
          messageId,
          bytesReceived: ctx.bytesReceived,
          lastCcEvent: ctx.lastCcEvent || '(none)',
          elapsedMs: Date.now() - startedAt,
        });
        yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Empty response from upstream (zero output tokens)' }, retry_after: 10 })}\n\n`;
      }
      // 上游 error / 空响应后也要给客户端一个合法终止序列，否则 SDK 认为流被截断而重连。
      // 注意 usage 清零（对齐正常收尾时的防假计费策略）。
      const closeBlock = closeTextBlock();
      if (closeBlock) yield closeBlock;
      yield `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, input_tokens: 0 },
      })}\n\n`;
      yield `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
      ctx.sentStop = true; // 消费端据此跳过重复补发
    }
  } finally {
    // 确保流中断时通知上游；清理遗留 keepalive 定时器，避免拖慢进程退出
    try { reader.cancel(); } catch {}
    try { if (keepaliveTimer) clearTimeout(keepaliveTimer); } catch {}
  }
}

function sendAnthropicError(res, status, type, message, retryAfter) {
  const body = { type: 'error', error: { type, message } };
  const headers = { 'Content-Type': 'application/json' };
  if (retryAfter !== undefined) {
    body.retry_after = retryAfter;
    headers['Retry-After'] = String(retryAfter);
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

async function handleMessages(req, res) {
  let anthropicReq;
  try {
    anthropicReq = await readBody(req);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      log('warn', 'Request body too large', { sizeMB: +(e.size / 1048576).toFixed(1), limitMB: MAX_BODY_SIZE / 1048576 });
      sendAnthropicError(res, 413, 'invalid_request_error',
        `Request body too large (${(e.size / 1048576).toFixed(1)}MB > ${(MAX_BODY_SIZE / 1048576).toFixed(0)}MB limit). `
        + 'Large media (video/image base64) is usually the cause; raise maxBodySize in config.json if you need more.');
      return;
    }
    sendAnthropicError(res, 400, 'invalid_request_error', 'Invalid JSON body');
    return;
  }

  const apiKey = getApiKey(req.headers);
  if (!apiKey) {
    sendJSON(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'Missing API key. Send in Authorization: Bearer <key> or x-api-key header' } });
    return;
  }

  const stream = anthropicReq.stream === true;
  const model = anthropicReq.model || 'claude-sonnet-4-6';

  // Convert Anthropic → OpenAI → CC
  const openaiReq = convertAnthropicToOpenAI(anthropicReq);
  const ccBody = buildCcRequest(openaiReq);

  let abortController = new AbortController();
  let aborted = false;
  // 提前初始化，断连回调/超时 catch 安全引用（避免块级作用域 ReferenceError）
  const startTime = Date.now();
  let messageId = '';
  let reader = null;
  let bytesReceived = 0; let lastCcEvent = ''; let fullText = '';
  let ctx = null; // 流式路径共享状态（生成器 ↔ 断连回调/消费端）

  // 下游断连检测：打断 CC 上游 + 记录日志。
  // 必须注册在建连之前 —— 原先放在 forwardToCC 之后，建连窗口（约 1s）内的断连不可见。
  res.on('close', () => {
    if (res.writableEnded) return; // Normal completion, not a disconnect
    aborted = true;
    if (!abortController.signal.aborted) {
      // 断连前抢发 usage=0 终止事件，避免下游自行估算 token
      try {
        res.write(`event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 0, input_tokens: 0, cache_read_input_tokens: 0 },
        })}\n\n`);
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      } catch {}
      try { abortController.abort(); } catch {}
    }
    log('warn', 'Client disconnected', {
      path: '/v1/messages',
      model,
      messageId,
      streaming: stream,
      phase: ctx ? 'streaming' : 'connecting',
      elapsedMs: Date.now() - startTime,
      bytesReceived: ctx ? ctx.bytesReceived : bytesReceived,
      lastCcEvent: ctx?.lastCcEvent || '(none)',
      upstreamError: ctx?.lastError || undefined,
      contentSent: !!ctx?.contentYielded,
      inputTokens: ctx?.inputTokens ?? 0,
      outputTokens: ctx?.outputTokens ?? 0,
    });
  });

  try {
    // 首次初始化（fingerprint + lifecycle）
    await ensureInitialized(apiKey, abortController.signal);
    let ccResponse = await forwardToCC(ccBody, apiKey, req.headers, abortController.signal);

    if (!ccResponse.ok) {
      const errorText = await ccResponse.text().catch(() => '');
      log('error', 'CC API error (Anthropic)', { status: ccResponse.status });
      const mapped = mapCcError(ccResponse.status, errorText);
      sendAnthropicError(res, mapped.status, mapped.body.error.type, mapped.body.error.message, mapped.body?.retry_after);
      return;
    }

    if (stream) {
      // ── 流式 Anthropic SSE ──
      let started = false; // message_start 一到就发 200 header（此前扣住不发会导致 thinking 期客户端零字节读超时重连）
      const flushHeaders = () => {
        if (started) return;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        started = true;
      };

      // 提前赋值：建连/首字节窗口内断连时，close 回调也能记录 messageId 与阶段
      messageId = 'msg_' + randomUUID().slice(0, 12);
      ctx = { bytesReceived: 0, lastCcEvent: '', lastError: '', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, hadOutput: false, contentYielded: false, sentStop: false, hasError: false, retryRequested: false, skipMessageStart: false };

      try {
        // 上游失败（流内 error / 零输出）且尚未向客户端发过任何内容时，
        // 生成器收尾前询问 decideFinalize；返回 retry 则不收尾，由这里换新上游连接透明重试
        const MAX_ATTEMPTS = 2;
        let attemptsUsed = 0;
        ctx.decideFinalize = () => ((ctx.hasError || ctx.outputTokens === 0) && attemptsUsed < MAX_ATTEMPTS && !ctx.contentYielded && !ctx.sentStop && !aborted) ? 'retry' : 'emit';

        const consume = async () => {
          const generator = createAnthropicSseTranslator(ccResponse, model, messageId, ctx);
          for await (const event of generator) {
            if (aborted) break;
            // message_start（生成器首个 yield）立即发头写出，thinking_delta、
            // 静默期 ': keepalive' 注释行等也直接透传
            flushHeaders();
            res.write(event);
          }
        };

        attemptsUsed++;
        await consume();

        if (!aborted && ctx.retryRequested) {
          log('warn', 'Retrying CC request (nothing sent to client yet)', {
            attempt: attemptsUsed + 1,
            messageId,
            model,
            reason: ctx.lastError || 'zero output tokens',
            lastCcEvent: ctx.lastCcEvent || '(none)',
            bytesReceived: ctx.bytesReceived,
          });
          try { abortController.abort(); } catch {}
          abortController = new AbortController();
          ccResponse = await forwardToCC(ccBody, apiKey, req.headers, abortController.signal);
          if (!ccResponse.ok) {
            const errorText = await ccResponse.text().catch(() => '');
            log('error', 'CC API error (Anthropic retry)', { status: ccResponse.status });
            const mapped = mapCcError(ccResponse.status, errorText);
            if (!started) {
              sendAnthropicError(res, mapped.status, mapped.body.error.type, mapped.body.error.message, mapped.body?.retry_after);
            } else {
              // message_start 已发出，只能以 SSE 事件收尾
              try { res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: mapped.body.error.type, message: mapped.body.error.message } })}\n\n`); } catch {}
              try { res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0, input_tokens: 0, cache_read_input_tokens: 0 } })}\n\n`); } catch {}
              try { res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`); } catch {}
            }
            return;
          }
          ctx.hasError = false; ctx.lastError = ''; ctx.retryRequested = false;
          ctx.skipMessageStart = true; // message_start 已随第一次尝试发出
          attemptsUsed++;
          await consume();
        }

        if (!aborted) {
          consecutiveTimeouts = 0;
          // 兜底：生成器未发终止单的异常收尾（正常/错误路径生成器已统一补发）
          if (!ctx.sentStop && started && !res.writableEnded) {
            try { res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0, input_tokens: 0, cache_read_input_tokens: 0 } })}\n\n`); } catch {}
            try { res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`); } catch {}
          }
        }
      } catch (e) {
        if (aborted) {
          // 客户端已断连，只清理（close handler 已调用 abortController.abort()）
        } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
          log('warn', 'Stream idle timeout', {
            path: '/v1/messages',
            model,
            streaming: true,
            timeoutMs: STREAM_IDLE_TIMEOUT_MS,
            elapsedMs: Date.now() - startTime,
            id: messageId,
            bytesReceived: ctx.bytesReceived,
            lastCcEvent: ctx.lastCcEvent || '(none)',
            inputTokens: ctx.inputTokens,
            outputTokens: ctx.outputTokens,
            cachedInputTokens: ctx.cachedInputTokens,
          });
          try { abortController.abort(); } catch {} // 打断 CC 上游
          if (!started) {
            consecutiveTimeouts++;
            const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
              ? 'Response timeout - try reducing context length (summarize earlier messages)'
              : 'Response timeout - request timed out';
            sendAnthropicError(res, 429, 'rate_limit_error', timeoutMsg);
            return;
          }
          if (!res.writableEnded) {
            consecutiveTimeouts++;
            const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
              ? 'Response timeout - try reducing context length (summarize earlier messages)'
              : 'Response timeout - request timed out';
            try { res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: timeoutMsg }, retry_after: 5 })}\n\n`); } catch {}
            // 补发合法终止序列再正常结束，避免 SDK 把流视为截断而无限重连
            try { res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0, input_tokens: 0, cache_read_input_tokens: 0 } })}\n\n`); } catch {}
            try { res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`); } catch {}
            try { res.end(); } catch {}
          }
        } else {
          log('error', 'Anthropic stream error', { message: e.message });
          try { abortController.abort(); } catch {} // 打断 CC 上游
          if (!started) {
            sendAnthropicError(res, 502, 'proxy_error', `Upstream error: ${e.message}`, 10);
            return;
          }
          if (!res.writableEnded) {
            try {
              res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'internal_error', message: e.message } })}\n\n`);
            } catch {}
            // 补发合法终止序列再正常结束，避免 SDK 把流视为截断而重连
            try { res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0, input_tokens: 0, cache_read_input_tokens: 0 } })}\n\n`); } catch {}
            try { res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`); } catch {}
          }
        }
      }

      if (!res.writableEnded) res.end();
    } else {
      // ── 非流式 Anthropic JSON ──
      messageId = 'msg_' + randomUUID().slice(0, 12);

      const consumeNonStream = async () => {
        let finishReason = 'stop';
        let usage = null;
        let toolCalls = null;
        let thinkingText = ''; // CC reasoning → Anthropic thinking block
        let hadError = false;
        fullText = ''; // 函数级变量：外层超时日志的 partialLen 依赖它

        reader = ccResponse.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        const processLines = () => {
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === '[DONE]') continue;
            try {
              const event = JSON.parse(trimmed);
              switch (event.type) {
                case 'text-delta': lastCcEvent = event.type; fullText += event.text || ''; break;
                case 'reasoning-delta': lastCcEvent = event.type; thinkingText += event.text || ''; break;
                case 'tool-call':
                  lastCcEvent = event.type;
                  (toolCalls = toolCalls || []).push({
                    id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                    type: 'function',
                    function: {
                      name: event.toolName || '',
                      arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}),
                    },
                  });
                  break;
                case 'finish-step':
                  // 与流式路径对齐：finish-step 也可能携带 totalUsage
                  lastCcEvent = event.type;
                  if (event.totalUsage) usage = event.totalUsage;
                  break;
                case 'finish':
                  lastCcEvent = event.type;
                  finishReason = mapFinishReason(event.finishReason || 'stop');
                  if (event.totalUsage) usage = event.totalUsage;
                  break;
                case 'error':
                  lastCcEvent = event.type;
                  hadError = true;
                  log('warn', 'CC error (Anthropic non-stream)', { message: event.error?.message || event.message });
                  break;
                case 'start': case 'start-step': case 'text-start': case 'reasoning-start':
                  // Signal / bookkeeping events, no user-visible content
                  break;
                case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-end': case 'tool-error': case 'text-end':
                  // Silent - no user-visible content
                  break;
                default:
                  log('warn', 'Unknown CC event type', { type: event.type });
                  break;
              }
            } catch {}
          }
        };

        while (true) {
          let idleTimer;
          const result = await Promise.race([
            reader.read(),
            new Promise((_, reject) => {
              idleTimer = setTimeout(() => reject(new Error('STREAM_IDLE_TIMEOUT')), NONSTREAM_IDLE_TIMEOUT_MS);
            }),
          ]).finally(() => { if (idleTimer) clearTimeout(idleTimer); });
          const { done, value } = result;
          if (done) break;
          bytesReceived += value.length;
          buf += decoder.decode(value, { stream: true });
          processLines();
        }
        processLines(); // flush 末行（无尾换行的 finish/usage 不丢）

        return { finishReason, usage, toolCalls, thinkingText, hadError, text: fullText };
      };

      let r = await consumeNonStream();

      // 空响应或上游报错且无任何内容 → 透明重试一次（尚未向客户端写任何字节）
      if ((r.hadError || (r.usage?.outputTokens ?? 0) === 0) && !r.text && !r.thinkingText && !r.toolCalls) {
        log('warn', 'Retrying CC request (non-stream, nothing accumulated)', {
          attempt: 2,
          messageId,
          model,
          reason: r.hadError ? 'upstream error event' : 'zero output tokens',
          lastCcEvent: lastCcEvent || '(none)',
        });
        try { abortController.abort(); } catch {}
        abortController = new AbortController();
        ccResponse = await forwardToCC(ccBody, apiKey, req.headers, abortController.signal);
        if (!ccResponse.ok) {
          const errorText = await ccResponse.text().catch(() => '');
          log('error', 'CC API error (Anthropic retry)', { status: ccResponse.status });
          const mapped = mapCcError(ccResponse.status, errorText);
          sendAnthropicError(res, mapped.status, mapped.body.error.type, mapped.body.error.message, mapped.body?.retry_after);
          return;
        }
        r = await consumeNonStream();
      }

      // 输出 token 为 0 时记为错误，避免下游异常计费
      if ((r.usage?.outputTokens ?? 0) === 0) {
        try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
        sendAnthropicError(res, 429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', 10);
        return;
      }

      consecutiveTimeouts = 0;
      sendJSON(res, 200, buildAnthropicResponse(model, r.text, r.toolCalls, r.finishReason, r.usage, r.thinkingText));
    }
  } catch (e) {
    if (abortController.signal.aborted) {
      log('warn', 'Request cancelled (client disconnected before CC response)', {
        path: '/v1/messages',
        model,
        messageId,
      });
    } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
      log('warn', 'Stream idle timeout', {
        path: '/v1/messages',
        model,
        streaming: false,
        timeoutMs: NONSTREAM_IDLE_TIMEOUT_MS,
        elapsedMs: Date.now() - startTime,
        id: messageId,
        bytesReceived,
        lastCcEvent: lastCcEvent || '(none)',
        partialLen: fullText ? fullText.length : 0,
      });
      try { reader?.cancel(); } catch {}
      try { abortController.abort(); } catch {} // 打断 CC 上游
      consecutiveTimeouts++;
      const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
        ? 'Response timeout - try reducing context length (summarize earlier messages)'
        : 'Response timeout - request timed out';
      res.setHeader('Retry-After', '5');
      sendAnthropicError(res, 429, 'rate_limit_error', timeoutMsg);
    } else {
      log('error', 'Upstream error', { message: e.message });
      try { abortController.abort(); } catch {} // 打断 CC 上游
      sendAnthropicError(res, 502, 'proxy_error', `Upstream error: ${e.message}`, 10);
    }
  }
}

// ── 动态模型列表 ────────────────────────────────────

let dynamicModels = null;
let modelsLastFetch = 0;
let modelsSource = 'builtin';  // 'provider' = 当前套餐实时列表（Provider API）| 'builtin' = 内置回退列表
let modelsLastError = '';      // 回退原因（供控制台如实提示，避免把内置列表当成套餐列表）

// apiKey 对应「当前套餐」；force=true 跳过 5 分钟缓存强制重新拉取
async function fetchModels(apiKey, opts = {}) {
  return track(doFetchModels(apiKey, opts));
}

async function doFetchModels(apiKey, { force = false } = {}) {
  const now = Date.now();
  if (!force && dynamicModels && (now - modelsLastFetch) < CFG.modelRefreshIntervalMs) {
    modelsSource = 'provider';
    return dynamicModels;
  }

  try {
    if (!apiKey) throw new Error('未提供 API Key');
    if (!CFG.useProviderModels) throw new Error('已关闭 useProviderModels');

    const response = await fetch(`${CFG.apiBase}/provider/v1/models`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'x-cli-environment': 'production',
        'x-command-code-version': CC_VERSION,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.data)) {
        // 兼容两种返回：字符串数组 / { id, name } 对象数组
        dynamicModels = data.data
          .map(m => (typeof m === 'string' ? { id: m, name: m } : { id: m && m.id, name: (m && (m.name || m.id)) }))
          .filter(m => m.id);
        modelsLastFetch = now;
        modelsSource = 'provider';
        modelsLastError = '';
        log('info', 'Fetched models from Provider API', { count: dynamicModels.length });
        return dynamicModels;
      }
      modelsLastError = 'Provider API 返回格式异常';
    } else {
      modelsLastError = response.status === 401
        ? 'API Key 无效或已过期（HTTP 401）'
        : `Provider API 返回 HTTP ${response.status}`;
    }
    log('warn', 'Provider models fetch failed, using hardcoded list', { status: response.status });
  } catch (e) {
    modelsLastError = e.message;
    log('warn', 'Provider models fetch error, using hardcoded list', { error: e.message });
  }

  // Fallback to hardcoded MODELS
  modelsSource = 'builtin';
  return MODELS;
}

async function handleModels(req, res) {
  const apiKey = getApiKey(req.headers);
  const models = await fetchModels(apiKey);
  const now = nowUnix();
  sendJSON(res, 200, {
    object: 'list',
    data: models.map(m => ({
      id: m.id,
      object: 'model',
      created: now,
      owned_by: 'command-code',
    })),
  });
}

function handleHealth(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}

// ── 当前套餐额度 ────────────────────────────────────
// 端点与数据结构对齐官方 CLI（command-code dist/cli.mjs）：
//   GET /alpha/whoami                          → { user, org }
//   GET /alpha/billing/credits?orgId=          → { credits: { planId, monthlyCredits, purchasedCredits, freeCredits, windowLimits? } }
//   GET /alpha/billing/subscriptions?orgId=    → { data: { planId, status, currentPeriodStart, currentPeriodEnd } }
//   GET /alpha/usage/summary?orgId=&since=     → { totalCost, ... }
// 先用 whoami 拿 orgId，credits 与 subscriptions 并行，最后按本周期起点 currentPeriodStart
// 查已花费（totalCost）。credits 的单位是美元。

const PLAN_MONTHLY_CREDITS = {
  'individual-go': 10,
  'individual-goat': 70,
  'individual-pro': 30,
  'individual-pro-v1': 80,
  'individual-provider': 15,
  'individual-max': 150,
  'individual-ultra': 300,
  'teams-pro': 40,
};
const PLAN_DISPLAY_NAMES = {
  'individual-go': 'Go',
  'individual-goat': 'GOAT',
  'individual-pro': 'Pro',
  'individual-pro-v1': 'Pro',
  'individual-provider': 'Provider',
  'individual-max': 'Max',
  'individual-ultra': 'Ultra',
  'teams-pro': 'Teams Pro',
};
// 长前缀优先匹配（与 CLI 一致），避免 individual-pro 抢走 individual-pro-v1
const PLAN_KEYS_BY_LENGTH = Object.keys(PLAN_MONTHLY_CREDITS).sort((a, b) => b.length - a.length);
// 订阅处于这些状态时，额度才按"有效套餐"计算（与 CLI 的 Vr 集合一致）
const PLAN_ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

function getPlanInfo(planId) {
  if (!planId) return null;
  const normalized = String(planId).toLowerCase().replace(/_/g, '-');
  const key = PLAN_KEYS_BY_LENGTH.find((k) => normalized.startsWith(k));
  if (!key) return null;
  return { name: PLAN_DISPLAY_NAMES[key] ?? key, monthlyCredits: PLAN_MONTHLY_CREDITS[key] };
}

let quotaCache = null;              // { at, view, raw }
const QUOTA_CACHE_MS = 30 * 1000;   // 连按 [3] 不必等两遍；[8] 可强制刷新
// 实测 CC 账单接口很慢：whoami 7~17s、subscriptions 最高 20s+、summary ~8s（DNS 仅 2ms，
// 慢在服务端）。超时给足，否则必然误报"读取失败"。
const QUOTA_TIMEOUT_MS = parseInt(process.env.CC_QUOTA_TIMEOUT_MS || '') || CFG.quotaTimeoutMs || 45000;
const quotaOrgIds = new Map();      // apiKey → orgId|null（避免每次都先等 whoami 才知道 orgId）

function quotaHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'x-cli-environment': 'production',
    'x-command-code-version': CC_VERSION,
    'traceparent': generateTraceparent(),
  };
}

async function quotaGet(apiKey, endpoint) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${CFG.apiBase}${endpoint}`, {
      headers: quotaHeaders(apiKey),
      signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
    });
  } catch (e) {
    // AbortSignal.timeout 抛的是 TimeoutError，原文是英文的 "operation was aborted..."，
    // 这里换成看得懂的说明（并带上端点与耗时，便于判断是服务端慢还是网络不通）
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      const err = new Error(`账单接口超时（${Math.round((Date.now() - started) / 1000)}s 无响应）：${endpoint.split('?')[0]}`);
      err.timeout = true;
      throw err;
    }
    const err = new Error(`无法连接 CC 服务端：${e.message}`);
    err.network = true;
    throw err;
  }
  if (!response.ok) {
    const err = new Error(response.status === 401
      ? 'API Key 无效或已过期（HTTP 401）'
      : `账单接口返回 HTTP ${response.status}：${endpoint.split('?')[0]}`);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

// 把几个接口的原始数据摊平成视图（算法与官方 CLI 的 projectUsageView 一致）
function projectQuota({ whoami, credits, subscription, summary }, fetchedAt = Date.now()) {
  // 注意：windowLimits 是 credits 响应的「顶层」字段，和 credits.credits 平级。
  // 官方 CLI 也是这么读的（projectUsageView 里 e.credits?.windowLimits，
  // 其中 e.credits 指向整个响应体）。
  const sub = subscription?.data ?? null;
  const c = credits?.credits ?? null;
  const plan = getPlanInfo(sub?.planId ?? c?.planId ?? '');

  const monthlyRemaining = Math.max(0, c?.monthlyCredits ?? 0);
  const purchasedRemaining = Math.max(0, c?.purchasedCredits ?? 0);
  const freeRemaining = Math.max(0, c?.freeCredits ?? 0);
  const totalRemaining = monthlyRemaining + purchasedRemaining + freeRemaining;

  const totalSpent = Math.max(0, summary?.totalCost ?? 0);
  // 订阅有效时用套餐标称额度当分母（额度可能被补发/叠加，取较大者）
  const monthlyPool = sub && PLAN_ACTIVE_STATUSES.has(sub.status) ? (plan?.monthlyCredits ?? null) : null;
  const totalPool = monthlyPool !== null
    ? Math.max(monthlyPool, monthlyRemaining) + purchasedRemaining + freeRemaining
    : totalSpent + totalRemaining;

  const hasCreditsInfo = totalRemaining > 0 || totalSpent > 0;
  const usagePercent = hasCreditsInfo && totalPool > 0
    ? Math.min(((totalPool - totalRemaining) / totalPool) * 100, 100)
    : 0;

  let daysLeft = null;
  if (sub?.currentPeriodEnd) {
    const end = new Date(sub.currentPeriodEnd);
    if (!Number.isNaN(end.getTime())) daysLeft = Math.max(0, Math.ceil((end.getTime() - Date.now()) / 86400000));
  }

  return {
    user: whoami?.user ?? null,
    org: whoami?.org ?? null,
    subscription: sub,
    plan,
    credits: {
      monthlyRemaining, purchasedRemaining, freeRemaining, totalRemaining,
      totalSpent, totalPool, usagePercent, hasCreditsInfo,
      creditThreshold: c?.creditThreshold ?? null,
      belowThreshold: c?.belowThreshold ?? false,
    },
    windowLimits: credits?.windowLimits ?? null,
    summary: summary ?? null,
    // 累计用量：服务端只按计费周期聚合（periodBasis 恒为 billing-period，
    // 传 since=1970 也不会变），所以口径是「本计费周期累计」而非全部历史
    tokens: {
      total: Math.max(0, summary?.totalTokens ?? 0),
      input: Math.max(0, summary?.totalTokensIn ?? 0),
      output: Math.max(0, summary?.totalTokensOut ?? 0),
    },
    requests: Number.isFinite(summary?.totalCount) ? summary.totalCount : null,
    avgCost: Number.isFinite(summary?.averageCost) ? summary.averageCost : null,
    periodBasis: summary?.periodBasis ?? null,
    daysLeft,
    cycleEnd: sub?.currentPeriodEnd ?? null,
    fetchedAt,
  };
}

// force=true 跳过 1 分钟缓存。失败时如实返回错误；手里有旧数据则一并带出（界面会标注是旧数据）。
async function fetchQuota(apiKey, opts = {}) {
  return track(doFetchQuota(apiKey, opts));
}

async function doFetchQuota(apiKey, { force = false } = {}) {
  const now = Date.now();
  if (!force && quotaCache && (now - quotaCache.at) < QUOTA_CACHE_MS) {
    return { ok: true, view: quotaCache.view, raw: quotaCache.raw, at: quotaCache.at, cached: true, warnings: [] };
  }

  try {
    if (!apiKey) throw new Error('未提供 API Key');

    const warnings = [];
    let creditsError = null;
    const settle = (r, label) => {
      if (r.status === 'fulfilled') return r.value;
      if (label === 'billing/credits') creditsError = r.reason;
      warnings.push(`${label}：${r.reason?.message ?? '获取失败'}`);
      return null;
    };

    // orgId 已知（含"确认没有组织"）就直接带上，省掉一轮等待
    let orgId = quotaOrgIds.has(apiKey) ? quotaOrgIds.get(apiKey) : null;
    const withOrg = (endpoint, id) => `${endpoint}${id ? `?orgId=${encodeURIComponent(id)}` : ''}`;

    // 三个接口并行。以前是串行（whoami → 其余 → summary），实测串行要 47s；
    // 并行后总耗时只取决于最慢的那个（~20s）。
    let [whoami, credits, subscription] = (await Promise.allSettled([
      quotaGet(apiKey, '/alpha/whoami'),
      quotaGet(apiKey, withOrg('/alpha/billing/credits', orgId)),
      quotaGet(apiKey, withOrg('/alpha/billing/subscriptions', orgId)),
    ])).map((r, i) => settle(r, ['whoami', 'billing/credits', 'billing/subscriptions'][i]));

    // 额度数据是面板的核心：拿不到才算失败。服务端偶发慢/抖动时重试一次；
    // 明确是 401 之类的错误则不重试，直接如实抛出。
    if (!credits) {
      if (!creditsError || !creditsError.status) {
        const retry = await Promise.allSettled([quotaGet(apiKey, withOrg('/alpha/billing/credits', orgId))]);
        if (retry[0].status === 'fulfilled') credits = retry[0].value;
        else throw retry[0].reason;
      } else {
        throw creditsError;
      }
      const idx = warnings.findIndex((w) => w.startsWith('billing/credits'));
      if (idx >= 0) warnings.splice(idx, 1); // 重试成功，撤掉这条告警
    }

    // whoami 只影响 orgId 与账号显示；首次发现组织时，用 orgId 再取一次账单
    const realOrgId = whoami?.org?.id ?? null;
    if (!quotaOrgIds.has(apiKey)) {
      quotaOrgIds.set(apiKey, realOrgId);
      if (realOrgId && realOrgId !== orgId) {
        orgId = realOrgId;
        const refetched = await Promise.allSettled([
          quotaGet(apiKey, withOrg('/alpha/billing/credits', orgId)),
          quotaGet(apiKey, withOrg('/alpha/billing/subscriptions', orgId)),
        ]);
        credits = settle(refetched[0], 'billing/credits(org)') ?? credits;
        subscription = settle(refetched[1], 'billing/subscriptions(org)') ?? subscription;
      }
    }

    // 本期已花费：依赖 subscriptions 的周期起点，所以放在并行组之后
    let summary = null;
    try {
      const summaryParams = new URLSearchParams();
      if (orgId) summaryParams.set('orgId', orgId);
      if (subscription?.data?.currentPeriodStart) summaryParams.set('since', subscription.data.currentPeriodStart);
      const qs = summaryParams.toString();
      summary = await quotaGet(apiKey, `/alpha/usage/summary${qs ? `?${qs}` : ''}`);
    } catch (e) {
      warnings.push(`usage/summary：${e.message}`);
    }

    const raw = { whoami, credits, subscription, summary };
    const view = projectQuota(raw, now);
    quotaCache = { at: now, view, raw };
    log('info', 'Fetched plan quota', {
      plan: view.plan?.name ?? subscription?.data?.planId ?? 'unknown',
      remaining: view.credits.totalRemaining,
      spent: view.credits.totalSpent,
      elapsedMs: Date.now() - now,
      warnings: warnings.length,
    });
    return { ok: true, view, raw, at: now, cached: false, warnings };
  } catch (e) {
    log('warn', 'Quota fetch failed', { error: e.message, elapsedMs: Date.now() - now });
    return {
      ok: false,
      error: e.message,
      timeout: !!e.timeout,
      view: quotaCache?.view ?? null,
      raw: quotaCache?.raw ?? null,
      at: quotaCache?.at ?? null,
    };
  }
}

// ══ 交互式控制台（cmd TUI） ═══════════════════════════
// 设计约束：
//  1. 纯 Node 内置模块（readline），零外部依赖，保持单文件分发；
//  2. 所有持久化只写项目目录内的 config.json —— 绝不写 %APPDATA% / %TEMP% /
//     家目录 / 注册表等任何 C 盘位置（TUI 自身不落任何文件）；
//  3. stdout 不是 TTY（Docker / CI / 重定向）时自动关闭，行为与旧版完全一致，
//     可用 CC_TUI=1 或 --tui 强制开启（测试用），CC_TUI=0 / --no-tui 强制关闭。

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const TUI_MAIN_PROMPT = '请输入序号 > ';
const TUI_KEY_PROMPT = '粘贴 API Key（user_ 开头，直接回车取消）> ';

function resolveTuiMode() {
  const argv = process.argv.slice(2);
  if (argv.includes('--no-tui')) return false;
  if (argv.includes('--tui')) return true;
  const env = (process.env.CC_TUI || '').trim().toLowerCase();
  if (['0', 'off', 'no', 'false'].includes(env)) return false;
  if (['1', 'on', 'yes', 'true', 'force'].includes(env)) return true;
  return !!process.stdout.isTTY;
}

// 仅在 TTY 下上色；非交互（管道 / 日志重定向）保持纯文本，避免污染日志
function useColor() {
  return !process.env.NO_COLOR && (!!process.stdout.isTTY || process.env.CC_TUI_COLOR === '1');
}

function paint(text, ...codes) {
  return useColor() ? codes.join('') + text + ANSI.reset : text;
}

// 计算终端显示宽度（CJK 全角字符算 2 列）
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return w;
}

function padEndW(s, width) {
  return String(s) + ' '.repeat(Math.max(0, width - dispWidth(s)));
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h ? h + 'h' : ''}${h || m ? m + 'm' : ''}${s}s`;
}

function formatLogLine(line, level) {
  if (level === 'error') return paint(line, ANSI.red);
  if (level === 'warn') return paint(line, ANSI.yellow);
  return paint(line, ANSI.dim);
}

function maskKey(key) {
  if (!key) return '(未设置)';
  return key.length <= 12 ? `${key.slice(0, 5)}****` : `${key.slice(0, 5)}****${key.slice(-4)}`;
}

// 从任意文本里取出 API Key。
// 注意：`user_[a-zA-Z0-9_-]+` 是贪婪的，终端里连续粘贴同一把 Key 会粘成
// "user_Auser_Auser_A…"，被整体当成一把 Key（实测踩过）。这里检测"各段完全相同"
// 时折叠成一份；只在完全相同时才折叠，避免误伤本身含 "user_" 字样的合法 Key。
function sanitizeApiKey(raw) {
  const m = String(raw || '').match(/user_[a-zA-Z0-9_-]+/);
  if (!m) return '';
  const parts = m[0].split('user_').filter(Boolean);
  if (parts.length > 1 && parts.every((p) => p === parts[0])) return `user_${parts[0]}`;
  return m[0];
}

// 判断这次输入是否属于"重复粘贴"，用于给用户一句明确提示
function isRepeatedPaste(raw) {
  const m = String(raw || '').match(/user_[a-zA-Z0-9_-]+/);
  if (!m) return false;
  const parts = m[0].split('user_').filter(Boolean);
  return parts.length > 1 && parts.every((p) => p === parts[0]);
}

// 日志 / 异步输出都经过这里：先清掉当前输入行，再打印，最后重绘提示符。
// 这样上游日志、模型列表、keepalive 提示都不会把用户正在输入的那行撕碎。
function tuiWriteAbovePrompt(text) {
  if (!TUI.active || !TUI.rl) { process.stdout.write(text + '\n'); return; }
  process.stdout.write('\r\x1b[2K' + text + '\n');
  try { TUI.rl.prompt(true); } catch {}
}

// ── API Key 解析 / 持久化（只写项目目录） ──────────────
function loadApiKeyFromSources() {
  const envKey = sanitizeApiKey(process.env.CC_API_KEY || process.env.COMMANDCODE_API_KEY || '');
  if (envKey) return { key: envKey, source: '环境变量 CC_API_KEY' };

  // config.local.json 优先于 config.json（loadConfig 已合并，这里只为标注来源）
  let localKey = '';
  try {
    const localPath = resolve(__dirname, 'config.local.json');
    if (existsSync(localPath)) localKey = sanitizeApiKey(JSON.parse(readFileSync(localPath, 'utf-8')).apiKey);
  } catch {}
  if (localKey) return { key: localKey, source: 'config.local.json' };

  const fileKey = sanitizeApiKey(CFG.apiKey);
  if (fileKey) return { key: fileKey, source: 'config.json' };
  return { key: '', source: '' };
}

// 只写项目目录内的 config.local.json —— 该文件已在 .gitignore / .dockerignore 中排除，
// 避免 API Key 被误提交到 git 或被误打进镜像。
function saveApiKeyLocally(key) {
  const localPath = resolve(__dirname, 'config.local.json');
  let obj = {};
  try {
    if (existsSync(localPath)) obj = JSON.parse(readFileSync(localPath, 'utf-8'));
  } catch {}
  obj.apiKey = key;
  writeFileSync(localPath, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  CFG.apiKey = key;
  return localPath;
}

function resetModelCache() {
  dynamicModels = null;
  modelsLastFetch = 0;
  modelsSource = 'builtin';
  modelsLastError = '';
}

function tuiHeader() {
  const rule = paint('─'.repeat(60), ANSI.dim);
  return [
    rule,
    paint(' Command Code → OpenAI / Anthropic 代理 · 控制台', ANSI.bold, ANSI.cyan),
    ` 服务 ${`http://${CFG.host}:${CFG.port}`} │ 运行 ${formatDuration(Date.now() - TUI.startedAt)} │ 已处理请求 ${stats.requests}`,
    ` API Key ${maskKey(TUI.apiKey)} （来源: ${TUI.apiKeySource || '未设置'}）`,
    rule,
  ].join('\n');
}

function tuiMenu() {
  const n = (s) => paint(`[${s}]`, ANSI.cyan);
  return [
    ` ${n(1)} 查看当前套餐可用模型`,
    ` ${n(2)} 强制刷新模型列表（跳过 5 分钟缓存）`,
    ` ${n(3)} 查看当前套餐额度`,
    ` ${n(4)} 服务状态与配置`,
    ` ${n(5)} 设置 / 更换 API Key`,
    ` ${n(6)} 查看最近日志`,
    ` ${n(7)} 清屏`,
    ` ${n(8)} 强制刷新额度（跳过缓存）`,
    ` ${n(0)} 退出（停止代理）`,
  ].join('\n');
}

const TUI_MENU_HINT = '请输入 0-8';

function tuiAsk(promptText) {
  return new Promise((resolve) => {
    TUI.pending = { resolve };
    TUI.rl.setPrompt(promptText);
    TUI.rl.prompt();
  });
}

// ── 菜单动作 ────────────────────────────────────────
// [1] / [2] 当前套餐可用模型
async function tuiShowModels(force = false) {
  if (!TUI.apiKey) {
    tuiWriteAbovePrompt(paint('⚠️  还没有 API Key —— 请先按 [5] 设置（Key 必须以 user_ 开头）', ANSI.yellow));
    return;
  }
  tuiWriteAbovePrompt(paint(force ? '正在重新拉取当前套餐可用模型…' : '正在读取当前套餐可用模型…', ANSI.dim));

  const models = await fetchModels(TUI.apiKey, { force });
  const fromProvider = modelsSource === 'provider';
  const width = Math.max(4, ...models.map((m) => dispWidth(m.id)));

  const out = ['', paint(`当前套餐可用模型（共 ${models.length} 个）`, ANSI.bold, ANSI.cyan)];
  if (fromProvider) {
    out.push(paint(
      ` 数据来源: Provider API · ${new Date(modelsLastFetch).toLocaleTimeString()} 拉取 · 缓存 ${Math.round(CFG.modelRefreshIntervalMs / 60000)} 分钟`,
      ANSI.dim,
    ));
  } else {
    out.push(paint(` ⚠️  未能获取套餐模型（${modelsLastError || '未知原因'}）`, ANSI.yellow));
    out.push(paint('     以下为内置参考列表，可能包含当前套餐不可用的模型；请按 [5] 设置有效 API Key 后重试。', ANSI.yellow));
  }
  out.push('');
  out.push(paint(`  ${padEndW('#', 5)}${padEndW('模型 ID', width + 2)}备注`, ANSI.dim));
  models.forEach((m, i) => {
    const idx = padEndW(`${i + 1}.`, 5);
    const name = m.name && m.name !== m.id ? m.name : '';
    out.push(`  ${paint(idx, ANSI.green)}${padEndW(m.id, width + 2)}${name ? paint(name, ANSI.dim) : ''}`);
  });
  out.push('');
  out.push(paint(' 提示：这些 ID 可直接填到客户端（Cursor / OpenCode / SDK）的 model 字段。', ANSI.dim));
  out.push('');
  tuiWriteAbovePrompt(out.join('\n'));
}

// [3] 当前套餐额度
function formatCredits(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

// Token 数量按官方口径显示成 M（百万）：233370995 → 233.4M
function formatTokens(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

// 单次均价常常小于 1 分钱，固定两位会显示成 $0.00，这里按量级提高精度
function formatSmallCredits(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

function progressBar(percent, width = 20) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((width * clamped) / 100);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
}

function formatDateTime(v) {
  if (!v) return '-';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

// 紧凑时长（对齐官方 CLI 的 formatDuration）：2d 3h / 3h 12m / 45m
function formatShortDuration(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return h > 0 ? `${d}天${h}小时` : `${d}天`;
  if (h > 0) return m > 0 ? `${h}小时${m}分` : `${h}小时`;
  return `${m}分`;
}

// 重置时刻：今天只显示时间，别的日子带上日期（对齐官方 formatResetClock）
function formatResetClock(tsMs) {
  const d = new Date(tsMs);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return new Date().toDateString() === d.toDateString() ? time : `${d.toLocaleDateString()} ${time}`;
}

// windowLimits.resetAt 是 epoch 毫秒；也兼容 ISO 字符串与秒级时间戳
function toEpochMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

function usageColor(percent) {
  if (percent >= 90) return ANSI.red;
  if (percent >= 70) return ANSI.yellow;
  return ANSI.green;
}

// 一条用量窗口：5小时 / 每周 / 每月
// 形如：` 5小时   [██░░░░░░]   2%  剩余 $2.93 · 3小时12分后重置 (21:04)`
function renderUsageMeter(label, used, cap, resetAtMs) {
  const percent = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  const color = usageColor(percent);
  const remaining = Math.max(0, cap - used);

  let tail = `剩余 ${formatCredits(remaining)}`;
  if (resetAtMs && resetAtMs > Date.now()) {
    tail += ` · ${formatShortDuration(resetAtMs - Date.now())}后重置（${formatResetClock(resetAtMs)}）`;
  }
  return ` ${padEndW(label, 7)}${paint(progressBar(percent, 20), color)} ${paint(`${Math.round(percent)}%`.padStart(4), ANSI.bold, color)}  ${tail}`;
}

// 从 windowLimits 里挑出已知窗口（5小时 / 每周），未知窗口也如实列出
function renderWindowLimits(limits) {
  if (!limits || limits.limited === false) return [];

  const known = [
    ['5小时', limits.fiveHour ?? limits.five_hour ?? null],
    ['每周', limits.weekly ?? null],
    ['每月', limits.monthly ?? null],
  ].filter(([, w]) => w && typeof w === 'object');

  const knownKeys = new Set(['limited', 'exceeded', 'fiveHour', 'five_hour', 'weekly', 'monthly']);
  const extras = Object.entries(limits)
    .filter(([k, v]) => !knownKeys.has(k) && v && typeof v === 'object')
    .map(([k, v]) => [k, v]);

  const rows = [];
  for (const [label, w] of [...known, ...extras]) {
    const cap = w.cap ?? w.limit ?? w.total ?? 0;
    const used = w.used ?? w.consumed ?? w.current ?? 0;
    rows.push(renderUsageMeter(label, used, cap, toEpochMs(w.resetAt ?? w.resetsAt ?? w.resetTime)));
    if (w.exceeded) rows.push(paint(`         ⚠️  该窗口已超限`, ANSI.red));
  }
  return rows;
}

// 每月窗口：服务端 windowLimits 里通常没有 monthly，用套餐周期额度自己算一条
function renderCycleMeter(v) {
  const c = v.credits;
  if (!c.hasCreditsInfo || c.totalPool <= 0) return null;
  const percent = Math.min(100, ((c.totalPool - c.totalRemaining) / c.totalPool) * 100);
  const resetAt = toEpochMs(v.cycleEnd);
  const tail = `剩余 ${formatCredits(c.totalRemaining)} / ${formatCredits(c.totalPool)}`
    + (v.daysLeft !== null ? ` · ${v.daysLeft}天后续期（${formatResetClock(resetAt ?? Date.now())}）` : '');
  return ` ${padEndW('每月', 7)}${paint(progressBar(percent, 20), usageColor(percent))} ${paint(`${Math.round(percent)}%`.padStart(4), ANSI.bold, usageColor(percent))}  ${tail}`;
}

async function tuiShowQuota(force = false) {
  if (!TUI.apiKey) {
    tuiWriteAbovePrompt(paint('⚠️  还没有 API Key —— 请先按 [5] 设置（Key 必须以 user_ 开头）', ANSI.yellow));
    return;
  }

  // CC 账单接口很慢（实测 8~20 秒），等待期间每 5 秒报一次进度，免得看起来像卡死
  const startedAt = Date.now();
  tuiWriteAbovePrompt(paint(force ? '正在重新读取当前套餐额度…（账单接口较慢，通常 10~30 秒）' : '正在读取当前套餐额度…（账单接口较慢，通常 10~30 秒）', ANSI.dim));
  const ticker = setInterval(() => {
    const s = Math.round((Date.now() - startedAt) / 1000);
    tuiWriteAbovePrompt(paint(`…仍在读取套餐额度（已等待 ${s}s）`, ANSI.dim));
  }, 5000);
  ticker.unref?.();

  let r;
  try {
    r = await fetchQuota(TUI.apiKey, { force });
  } finally {
    clearInterval(ticker);
  }
  const elapsedS = Math.round((Date.now() - startedAt) / 1000);

  const out = ['', paint('当前套餐额度', ANSI.bold, ANSI.cyan)];

  if (!r.ok && !r.view) {
    out.push(paint(` ❌ 读取失败：${r.error}`, ANSI.red));
    if (r.timeout) {
      out.push(paint(`    CC 账单接口 ${elapsedS}s 内没有响应。实测这几个接口本身就要 8~20 秒，`, ANSI.dim));
      out.push(paint('    若经常超时可在 config.json 调大 quotaTimeoutMs（默认 45000），或换个网络再试。', ANSI.dim));
    } else {
      out.push(paint('    额度由 CC 服务端提供，需要有效 API Key；若提示 401 请到 CC 重新复制一把。', ANSI.dim));
    }
    out.push('');
    tuiWriteAbovePrompt(out.join('\n'));
    return;
  }

  const v = r.view;
  const c = v.credits;
  const planName = v.plan?.name ?? (v.subscription?.planId ? String(v.subscription.planId) : '未知套餐');

  const statusTag = v.subscription?.status
    ? paint(`（${v.subscription.status}）`, PLAN_ACTIVE_STATUSES.has(v.subscription.status) ? ANSI.green : ANSI.yellow)
    : '';
  out.push(` 套餐：${paint(planName, ANSI.bold)}${statusTag}${v.plan ? paint(`   ${formatCredits(v.plan.monthlyCredits)}/月`, ANSI.dim) : ''}`);

  if (v.user?.userName || v.user?.name) {
    out.push(` 账号：${v.user.userName || v.user.name}${v.org?.login ? `  ·  组织 ${v.org.login}` : ''}`);
  }

  // 用量窗口（对齐官方 CLI 的 Usage limits 区块）：5小时 / 每周来自 windowLimits，
  // 每月由套餐周期额度自己算一条
  const windowRows = renderWindowLimits(v.windowLimits);
  const cycleRow = renderCycleMeter(v);
  if (windowRows.length || cycleRow) {
    out.push('');
    out.push(paint(' 用量窗口', ANSI.bold));
    out.push(...windowRows);
    if (cycleRow) out.push(cycleRow);
    if (!windowRows.length) {
      out.push(paint('   （服务端未返回 5 小时 / 每周窗口，仅显示按周期的月度额度）', ANSI.dim));
    }
  } else {
    out.push(paint(' ⚠️  服务端没有返回额度数字（可能是新套餐，或该套餐不按额度计费）', ANSI.yellow));
  }

  if (c.hasCreditsInfo) {
    out.push('');
    out.push(` 额度池：剩余 ${paint(formatCredits(c.totalRemaining), ANSI.bold, ANSI.green)} / ${formatCredits(c.totalPool)}`
      + `   已用 ${formatCredits(c.totalSpent)}`);
    out.push(paint(
      `         其中 月度 ${formatCredits(c.monthlyRemaining)} · 加油包 ${formatCredits(c.purchasedRemaining)} · 赠送 ${formatCredits(c.freeRemaining)}`,
      ANSI.dim,
    ));
    if (c.belowThreshold) out.push(paint(` ⚠️  额度已低于告警阈值 ${formatCredits(c.creditThreshold)}`, ANSI.yellow));
  }

  // 累计用量（与官方 CLI 的 /usage 面板同源，取自 usage/summary）
  if (v.tokens && v.tokens.total > 0) {
    const extras = [];
    if (v.requests) extras.push(`${v.requests.toLocaleString()} 次请求`);
    const avg = formatSmallCredits(v.avgCost);
    if (avg) extras.push(`均次 ${avg}`);
    out.push(` 累计用量：${paint(formatTokens(v.tokens.total), ANSI.bold)} tokens`
      + paint(`（输入 ${formatTokens(v.tokens.input)} · 输出 ${formatTokens(v.tokens.output)}）`, ANSI.dim)
      + (extras.length ? paint(` · ${extras.join(' · ')}`, ANSI.dim) : ''));
    out.push(paint(`           ${v.periodBasis === 'billing-period' || !v.periodBasis ? '统计自本计费周期起点' : `统计口径 ${v.periodBasis}`}`, ANSI.dim));
  }

  if (v.subscription?.currentPeriodEnd) {
    const days = v.daysLeft;
    const daysTag = days === null ? '' : (days < 3 ? paint(` · 仅剩 ${days} 天`, ANSI.red) : ` · 还剩 ${days} 天`);
    out.push(` 周期：${formatDateTime(v.subscription.currentPeriodStart)} → ${formatDateTime(v.subscription.currentPeriodEnd)}${daysTag}`);
  }

  // 部分接口没拿到时如实列出，不假装数据齐全
  if (r.warnings?.length) {
    out.push('');
    out.push(paint(' ⚠️  部分数据未取到：', ANSI.yellow));
    for (const w of r.warnings) out.push(paint(`    · ${w}`, ANSI.yellow));
  }

  const age = r.at ? Math.round((Date.now() - r.at) / 1000) : null;
  out.push('');
  if (r.ok) {
    out.push(paint(r.cached
      ? ` 刷新时间：${formatDateTime(r.at)}（${age}s 前的缓存 · 按 [8] 强制刷新）`
      : ` 刷新时间：${formatDateTime(r.at)}（耗时 ${elapsedS}s · 数据来源 CC 账单接口）`, ANSI.dim));
  } else {
    out.push(paint(` ⚠️  本次刷新失败（${r.error}），以上为 ${formatDateTime(r.at)} 的旧数据（${age}s 前）`, ANSI.yellow));
  }
  out.push('');
  tuiWriteAbovePrompt(out.join('\n'));
}

// [8] 强制刷新额度（跳过 30 秒缓存）
async function tuiRefreshQuota() {
  await tuiShowQuota(true);
}

// [4] 服务状态与配置
function tuiShowStatus() {
  const cacheLeft = dynamicModels
    ? `${dynamicModels.length} 个 · ${Math.max(0, Math.round((CFG.modelRefreshIntervalMs - (Date.now() - modelsLastFetch)) / 1000))}s 后过期`
    : '未缓存';
  const rows = [
    ['监听地址', `http://${CFG.host}:${CFG.port}`],
    ['运行时长', formatDuration(Date.now() - TUI.startedAt)],
    ['上游 API', CFG.apiBase],
    ['项目 Slug', CFG.projectSlug],
    ['API Key', TUI.apiKey ? `${maskKey(TUI.apiKey)}（${TUI.apiKeySource}）` : '未设置'],
    ['模型来源', modelsSource === 'provider' ? 'Provider API（当前套餐）' : '内置列表（回退）'],
    ['模型缓存', cacheLeft],
    ['已处理请求', `${stats.requests}（错误 ${stats.errors}）`],
    ['日志文件', CFG.logFile || '仅控制台'],
    ['日志级别', CFG.logLevel],
    ['CLI 版本号', CC_VERSION],
    ['持久化位置', '仅项目目录 config.local.json（已排除出 git / 镜像，不写 C 盘用户目录）'],
  ];
  const w = Math.max(...rows.map((r) => dispWidth(r[0])));
  tuiWriteAbovePrompt([
    '',
    paint('服务状态与配置', ANSI.bold, ANSI.cyan),
    ...rows.map(([k, v]) => `  ${padEndW(k, w + 2)}${v}`),
    '',
  ].join('\n'));
}

// [5] 设置 / 更换 API Key
async function tuiSetApiKey() {
  TUI.maskInput = true; // 输入期间不回显
  let typed = '';
  try {
    typed = await tuiAsk(TUI_KEY_PROMPT);
  } finally {
    TUI.maskInput = false;
  }
  process.stdout.write('\x1b[1A\x1b[2K'); // 抹掉上一行（Key 不留在命令行/回滚缓冲里）

  if (!typed) { tuiWriteAbovePrompt(paint('已取消', ANSI.dim)); return; }

  const repeated = isRepeatedPaste(typed);
  const key = sanitizeApiKey(typed);
  if (!key) {
    tuiWriteAbovePrompt(paint('❌ 格式不对：Key 必须以 user_ 开头，例如 user_xxxxxxxxx', ANSI.red));
    return;
  }
  TUI.apiKey = key;
  TUI.apiKeySource = '手动输入（本次运行）';
  resetModelCache(); // 换 Key = 换套餐，旧列表作废
  tuiWriteAbovePrompt(paint(`✅ 已启用 API Key ${maskKey(key)}`, ANSI.green));
  if (repeated) {
    tuiWriteAbovePrompt(paint(`ℹ️  检测到连续粘贴了多份相同的 Key，已自动合并为一份（${key.length} 字符）`, ANSI.yellow));
  }

  const answer = (await tuiAsk('是否写入 config.local.json（项目目录内，不入库/不进镜像）供下次自动使用？(y/N) > ')).toLowerCase();
  if (answer === 'y' || answer === 'yes') {
    try {
      const p = saveApiKeyLocally(key);
      TUI.apiKeySource = 'config.local.json';
      tuiWriteAbovePrompt(paint(`✅ 已写入 ${p}（已在 .gitignore / .dockerignore 中排除）`, ANSI.green));
    } catch (e) {
      tuiWriteAbovePrompt(paint(`❌ 写入失败: ${e.message}`, ANSI.red));
    }
  } else {
    tuiWriteAbovePrompt(paint('未写入文件，仅本次运行有效。', ANSI.dim));
  }
}

// [6] 最近日志
function tuiShowLogs() {
  const lines = logRing.slice(-40);
  tuiWriteAbovePrompt([
    '',
    paint(`最近日志（缓存 ${logRing.length} 条，显示最后 ${lines.length} 条）`, ANSI.bold, ANSI.cyan),
    ...(lines.length ? lines.map((l) => '  ' + l) : [paint('  （暂无日志）', ANSI.dim)]),
    '',
  ].join('\n'));
}

// [7] 清屏
function tuiClearScreen() {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  tuiWriteAbovePrompt(`${tuiHeader()}\n${tuiMenu()}`); // 已自带提示符重绘
}

// 一次操作结束后重新摆出菜单 + 提示符。
// 命令的输出是往终端里"滚动追加"的，滚过几屏之后菜单就看不见了，
// 所以每次输出完都把菜单再打一遍，用户不用往上翻。
function tuiReprompt({ menu = true } = {}) {
  if (TUI.closing || !TUI.rl) return;
  TUI.rl.setPrompt(TUI_MAIN_PROMPT);
  if (menu) {
    tuiWriteAbovePrompt('\n' + tuiMenu()); // 内部会重绘提示符
    return;
  }
  TUI.rl.prompt();
}

// 等 stdout 写缓冲排空（管道重定向下 stdout 是异步的）
async function drainStdout(timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while ((process.stdout.writableLength || 0) > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 50)); // 让最后一次 uv_write 落地
}

// [0] 退出
async function tuiShutdown(reason) {
  if (TUI.closing) return;
  TUI.closing = true;
  TUI.active = false;
  process.stdout.write('\n' + paint(`正在停止代理（${reason}）…`, ANSI.dim) + '\n');

  // 依次收摊：定时器 → 控制台 → 服务器（含空闲 keep-alive 连接）
  clearInterval(ccVersionTimer);
  clearInterval(sessionCleanupTimer);
  try { TUI.rl && TUI.rl.close(); } catch {}
  await new Promise((r) => { try { server.close(() => r()); } catch { r(); } });
  try { server.closeIdleConnections && server.closeIdleConnections(); } catch {}

  // 等在途的上游请求收尾（最多 1.2s）
  await Promise.race([
    Promise.allSettled([...inflightOps]),
    new Promise((r) => setTimeout(r, 1200)),
  ]);

  // 让事件循环自然结束：不用 process.exit() 硬切 —— Windows 上在途的
  // 线程池写入（stdout 管道）会撞 libuv 断言 0xC0000409，退出码变成 0xC0000409。
  // stdin 是唯一还会吊住事件循环的 handle，主动 unref 释放。
  try { process.stdin.pause(); process.stdin.unref && process.stdin.unref(); } catch {}
  await drainStdout();

  const forceExit = setTimeout(() => process.exit(0), 1500); // 兜底：还有别的 handle 吊着时才硬退
  forceExit.unref();
}

async function tuiHandleLine(raw) {
  const line = String(raw).trim();
  if (!line) return;

  switch (line) {
    case '1': await tuiShowModels(false); break;
    case '2': await tuiShowModels(true); break;
    case '3': await tuiShowQuota(false); break;
    case '4': tuiShowStatus(); break;
    case '5': await tuiSetApiKey(); break;
    case '6': tuiShowLogs(); break;
    case '7': tuiClearScreen(); return; // 已重绘菜单 + 提示符，不再重复
    case '8': await tuiRefreshQuota(); break;
    case '0':
    case 'q':
    case 'Q':
    case 'exit':
      await tuiShutdown('用户退出');
      return;
    default:
      tuiWriteAbovePrompt(paint(`未知序号「${line}」—— ${TUI_MENU_HINT}`, ANSI.yellow));
  }

  tuiReprompt(); // 输出完再摆一次菜单
}

function startTui() {
  const { key, source } = loadApiKeyFromSources();
  TUI.apiKey = key;
  TUI.apiKeySource = source;
  TUI.active = true;
  TUI.startedAt = Date.now();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 100,           // 仅内存，不写 .node_repl_history 等任何文件
    removeHistoryDuplicates: true,
  });
  TUI.rl = rl;

  // 输入 API Key 时屏蔽回显（只放行提示语本身；私有 API 缺失时退化为可见输入）
  if (typeof rl._writeToOutput === 'function') {
    const origWrite = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (str) => {
      if (!TUI.maskInput) return origWrite(str);
      if (str.includes(TUI_KEY_PROMPT)) return origWrite(str);
    };
  }

  // 命令串行执行：await 中的命令（如拉取模型）不会被后续按键插队。
  // 例外：正在等待一次输入（API Key / y-N 确认）时必须就地结算，
  // 否则「等待输入」的命令会堵住队列、输入行永远进不来（死锁）。
  rl.on('line', (l) => {
    if (TUI.pending) {
      const { resolve } = TUI.pending;
      TUI.pending = null;
      resolve(String(l).trim());
      return;
    }
    TUI.queue = TUI.queue
      .then(() => tuiHandleLine(l))
      .catch((e) => tuiWriteAbovePrompt(paint(`❌ ${e.message}`, ANSI.red)));
  });

  // Ctrl+C：3 秒内连按两次才退出，避免手滑把代理停掉
  let lastSigint = 0;
  rl.on('SIGINT', () => {
    const now = Date.now();
    if (now - lastSigint < 3000) { tuiShutdown('Ctrl+C'); return; }
    lastSigint = now;
    tuiWriteAbovePrompt(paint('再按一次 Ctrl+C 退出；输入 0 也可退出（代理会继续在后台运行）', ANSI.yellow));
  });

  // stdin 关闭（Ctrl+Z / 管道结束）→ 队列跑完后收摊
  rl.on('close', () => {
    if (TUI.closing) return;
    TUI.queue = TUI.queue.then(() => tuiShutdown('stdin 已关闭'));
  });

  process.stdout.write(`${tuiHeader()}\n${tuiMenu()}\n`);
  if (!TUI.apiKey) {
    process.stdout.write(paint('提示：尚未设置 API Key，按 [5] 设置后才能看到当前套餐的模型列表与额度。\n', ANSI.yellow));
  }
  rl.setPrompt(TUI_MAIN_PROMPT);
  rl.prompt();

  // 启动只摆菜单，不自动拉取模型列表（避免每次启动刷一屏，需要时按 [1]）
}

// ── 服务器 ──────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const host = req.headers.host || 'localhost';
  const url = new URL(req.url, `http://${host}`);

  stats.requests++;
  try {
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      await handleChatCompletions(req, res);
    } else if (url.pathname === '/v1/messages' && req.method === 'POST') {
      await handleMessages(req, res);
    } else if (url.pathname === '/v1/models' && req.method === 'GET') {
      await handleModels(req, res);
    } else if (url.pathname === '/health' || url.pathname === '/') {
      handleHealth(req, res);
    } else {
      sendJSON(res, 404, { error: { message: 'Not found', type: 'not_found' } });
    }
  } catch (e) {
    stats.errors++;
    sendJSON(res, 500, { error: { message: e.message, type: 'internal_error' } });
  }
});

// 管道下游提前退出（`node proxy.mjs | more`、终端被关闭等）时不要因为 EPIPE 崩掉
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e) => { if (e && e.code !== 'EPIPE') throw e; });
}

// 全局兜底：abort 触发的异步 rejection 不会让进程崩溃
process.on('unhandledRejection', (reason) => {
  if (reason?.name === 'AbortError' || reason?.code === 'ABORT_ERR') {
    // 客户端断连触发的 abort — 预期行为，静默处理
    log('info', 'Aborted request cleaned up');
  } else {
    log('error', 'Unhandled rejection', { message: reason?.message || String(reason), stack: reason?.stack?.split('\n')[0] });
  }
});

server.listen(CFG.port, CFG.host, () => {
  const tuiOn = resolveTuiMode();
  log('info', 'CC Proxy started', {
    url: `http://${CFG.host}:${CFG.port}`,
    api: CFG.apiBase,
    models: MODELS.length,
    session: '12h + 1h jitter, per API key',
    logFile: CFG.logFile || '(console only)',
    tui: tuiOn ? 'on' : 'off',
  });
  if (!CFG.apiKey && !process.env.CC_API_KEY) {
    log('info', 'No API key in config. API key must be sent in Authorization: Bearer <key> header per request.');
  }

  // 交互式控制台：仅 TTY 下启用；Docker / CI / 重定向时保持纯日志输出（与旧版一致）
  if (tuiOn) startTui();
  else if (process.stdout.isTTY) log('info', 'Interactive console disabled (--no-tui / CC_TUI=0)');
});
