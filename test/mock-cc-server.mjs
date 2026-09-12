// Mock CC 上游 + proxy.mjs 端到端场景测试（不依赖外网与真实 API key）
// 用法：node test/mock-cc-server.mjs
// 场景通过 model 名注入：body.params.model = 'scn-xxx'，mock 按 scenario 返回不同 NDJSON 流。
import { spawn } from 'node:child_process';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MOCK_PORT = 4170;
const PROXY_PORT = 3150;
const PROXY_KEY = 'user_testmock123';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ── 场景定义 ──────────────────────────────────────────
const ndjson = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const okEvents = () => [
  { type: 'start' },
  { type: 'start-step' },
  { type: 'text-delta', text: 'hello' },
  { type: 'text-delta', text: ' world' },
  { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 10, outputTokens: 5 } },
];

const reqCounts = {}; // model → 已收到的请求数

async function sendScenario(res, model, parsed) {
  const n = (reqCounts[model] = (reqCounts[model] || 0) + 1);
  const writeChunk = async (text, sep = '\n') => { res.write(text + sep); await delay(10); };

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

  if (model === 'scn-ok') {
    await writeChunk(ndjson(okEvents()));
  } else if (model === 'scn-error-once') {
    // 第 1 次：流内 error；第 2 次起：正常 → 验证透明重试
    if (n === 1) await writeChunk(JSON.stringify({ type: 'start' }) + '\n' + JSON.stringify({ type: 'error', error: { message: 'mock upstream boom' } }) + '\n');
    else await writeChunk(ndjson(okEvents()));
  } else if (model === 'scn-error-always') {
    // 永远流内 error → 重试后仍失败 → 客户端应收到 error + 完整终止序列
    await writeChunk(JSON.stringify({ type: 'start' }) + '\n' + JSON.stringify({ type: 'error', error: { message: 'mock upstream boom' } }) + '\n');
  } else if (model === 'scn-zero-once' || model === 'scn-zero-once-ns') {
    // 第 1 次：正常关流但零输出；第 2 次起：正常
    if (n === 1) await writeChunk(JSON.stringify({ type: 'start' }) + '\n' + JSON.stringify({ type: 'finish', finishReason: 'stop' }) + '\n');
    else await writeChunk(ndjson(okEvents()));
  } else if (model === 'scn-zero-always') {
    await writeChunk(JSON.stringify({ type: 'start' }) + '\n' + JSON.stringify({ type: 'finish', finishReason: 'stop' }) + '\n');
  } else if (model === 'scn-nonl') {
    // 最后一行 finish 无尾换行 → 验证 buffer flush 修复
    const lines = okEvents().map((e) => JSON.stringify(e));
    await writeChunk(lines.slice(0, -1).join('\n') + '\n');
    res.write(lines[lines.length - 1]); // 无 \n
    res.end();
    return;
  } else if (model === 'scn-zerousage') {
    // usage 报 outputTokens:0，但真实 delta 已输出 → 验证覆盖防护（不得误判空响应）
    await writeChunk(JSON.stringify({ type: 'start' }) + '\n' + JSON.stringify({ type: 'text-delta', text: 'hi' }) + '\n' + JSON.stringify({ type: 'text-delta', text: '!' }) + '\n' + JSON.stringify({ type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 8, outputTokens: 0 } }) + '\n');
  } else if (model === 'scn-late') {
    // 静默 1.5s（≫ keepalive 间隔 300ms）后再输出 → 验证 readPromise 复用不丢数据
    await writeChunk(JSON.stringify({ type: 'start' }) + '\n');
    await delay(1500);
    await writeChunk(ndjson([{ type: 'text-delta', text: 'late-hello' }, ...okEvents().slice(2)]));
  } else if (model === 'scn-strict-tools') {
    // 模拟真实 CC 的严格校验：assistant 的每个 tool-call 必须有对应 tool-result
    const calls = [];
    const results = new Set();
    for (const m of parsed?.params?.messages || []) {
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const p of m.content) if (p.type === 'tool-call' && p.toolCallId) calls.push(p.toolCallId);
      }
      if (m.role === 'tool' && Array.isArray(m.content)) {
        for (const p of m.content) if (p.type === 'tool-result' && p.toolCallId) results.add(p.toolCallId);
      }
    }
    const missing = calls.filter((id) => !results.has(id));
    if (missing.length > 0) {
      await writeChunk(JSON.stringify({ type: 'start' }) + '\n' + JSON.stringify({ type: 'error', error: { message: `Tool result is missing for tool call ${missing[0]}.` } }) + '\n');
    } else {
      await writeChunk(ndjson(okEvents()));
    }
  } else {
    await writeChunk(ndjson(okEvents()));
    model; // noop
  }
  res.end();
}

const mock = http.createServer(async (req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    try {
      if (req.url === '/alpha/generate' && req.method === 'POST') {
        const parsed = JSON.parse(body || '{}');
        upstreamBodies.push(parsed);
        const model = parsed?.params?.model || 'scn-ok';
        await sendScenario(res, model, parsed);
      } else {
        // fingerprint / lifecycle-events / 其他 → 空成功
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
    } catch (e) {
      try { res.writeHead(500); res.end(String(e)); } catch {}
    }
  });
});

// ── 启动 proxy ────────────────────────────────────────
const proxyLogs = [];
const upstreamBodies = [];   // 上游实际收到的 CC 请求体（校验媒体 part 转换）
function startProxy() {
  const child = spawn(process.execPath, [path.join(ROOT, 'proxy.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PROXY_PORT),
      CC_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
      SSE_KEEPALIVE_INTERVAL_MS: '300',
      CC_MAX_BODY_SIZE: String(2 * 1024 * 1024),  // 收紧到 2MB，便于测超限
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => proxyLogs.push(d.toString()));
  child.stderr.on('data', (d) => proxyLogs.push(d.toString()));
  return child;
}

// ── 请求工具 ──────────────────────────────────────────
function anthropicBody(model, stream) {
  return JSON.stringify({
    model,
    max_tokens: 100,
    stream,
    messages: [{ role: 'user', content: 'hi' }],
  });
}

async function callProxy(model, stream = true, messages) {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PROXY_KEY}`, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: 100,
      stream,
      messages: messages || [{ role: 'user', content: 'hi' }],
    }),
    signal: AbortSignal.timeout(20000), // 单请求超时：挂起时让用例失败而不是卡死整个套件
  });
  const text = await res.text();
  return { status: res.status, text };
}

// OpenAI Chat Completions 路由（多模态 part 走的是这条）
async function callOpenAI(model, messages) {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PROXY_KEY}` },
    body: JSON.stringify({ model, messages, max_tokens: 100 }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  return { status: res.status, text };
}

const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

// ── 断言 ──────────────────────────────────────────────
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function test(name, fn) {
  console.log(`\n▶ ${name}`);
  try { await fn(); } catch (e) { failed++; console.log(`  ❌ 异常: ${e.message}`); }
}

// ── 主流程 ────────────────────────────────────────────
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
const proxy = startProxy();

// 等代理端口就绪
let proxyUp = false;
for (let i = 0; i < 50 && !proxyUp; i++) {
  await delay(200);
  try { const h = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`); if (h.ok) proxyUp = true; } catch {}
}
if (!proxyUp) {
  console.error('proxy 未启动，日志：\n' + proxyLogs.join(''));
  proxy.kill();
  process.exit(1);
}

await test('scn-ok：正常流式响应', async () => {
  const { status, text } = await callProxy('scn-ok');
  check('HTTP 200', status === 200, `got ${status}`);
  check('message_start 恰好 1 次', countOccurrences(text, 'event: message_start') === 1);
  check('含完整文本', text.includes('hello') && text.includes(' world'));
  check('无 error 事件', !text.includes('event: error'), text.slice(0, 500));
  check('usage output_tokens=5', text.includes('"output_tokens":5'), text.split('message_delta').pop());
  check('message_stop 收尾', text.includes('event: message_stop'));
  check('无重试日志', !proxyLogs.join('').includes('Retrying CC request'));
});

await test('scn-error-once：首次流内 error → 透明重试成功', async () => {
  const { status, text } = await callProxy('scn-error-once');
  check('HTTP 200', status === 200);
  check('message_start 恰好 1 次（第二跳跳过）', countOccurrences(text, 'event: message_start') === 1);
  check('无 error 事件', !text.includes('event: error'), text);
  check('含重试后的完整文本', text.includes('hello') && text.includes(' world'));
  check('usage output_tokens=5', text.includes('"output_tokens":5'));
  check('mock 收到 2 次上游请求', reqCounts['scn-error-once'] === 2, `got ${reqCounts['scn-error-once']}`);
  check('代理记录了重试日志', proxyLogs.join('').includes('Retrying CC request'));
  check('代理记录了上游错误原文', proxyLogs.join('').includes('mock upstream boom'));
});

await test('scn-error-always：两次都 error → error 事件 + 完整终止序列', async () => {
  const { status, text } = await callProxy('scn-error-always');
  check('HTTP 200（流式以事件收尾）', status === 200);
  check('message_start 恰好 1 次', countOccurrences(text, 'event: message_start') === 1);
  check('error 事件含上游原文', text.includes('event: error') && text.includes('mock upstream boom'));
  check('message_stop 收尾', text.includes('event: message_stop'));
  check('mock 收到 2 次上游请求', reqCounts['scn-error-always'] === 2, `got ${reqCounts['scn-error-always']}`);
});

await test('scn-zero-once：首次零输出 → 透明重试成功', async () => {
  const { text } = await callProxy('scn-zero-once');
  check('无 error 事件', !text.includes('event: error'), text);
  check('含完整文本', text.includes('hello') && text.includes(' world'));
  check('mock 收到 2 次上游请求', reqCounts['scn-zero-once'] === 2, `got ${reqCounts['scn-zero-once']}`);
});

await test('scn-zero-always：两次都零输出 → 空响应错误', async () => {
  const { text } = await callProxy('scn-zero-always');
  check('error 事件（零输出）', text.includes('Empty response from upstream'));
  check('message_stop 收尾', text.includes('event: message_stop'));
  check('mock 收到 2 次上游请求', reqCounts['scn-zero-always'] === 2, `got ${reqCounts['scn-zero-always']}`);
});

await test('scn-nonl：末行 finish 无尾换行 → flush 修复', async () => {
  const { text } = await callProxy('scn-nonl');
  check('无 error 事件', !text.includes('event: error'), text);
  check('usage output_tokens=5（finish 行被处理）', text.includes('"output_tokens":5'), text.split('message_delta').pop());
});

await test('scn-zerousage：usage 报 0 但有真实 delta → 不误判', async () => {
  const { text } = await callProxy('scn-zerousage');
  check('无 error 事件', !text.includes('event: error'), text);
  check('按 delta 计 output_tokens=2', text.includes('"output_tokens":2'), text.split('message_delta').pop());
  check('mock 只收到 1 次上游请求', reqCounts['scn-zerousage'] === 1, `got ${reqCounts['scn-zerousage']}`);
});

await test('scn-late：静默超 keepalive 间隔后再输出 → 数据不丢', async () => {
  const { text } = await callProxy('scn-late');
  check('发出 keepalive 注释行', text.includes(': keepalive'));
  check('静默后的文本未丢失', text.includes('late-hello'), text);
  check('无 error 事件', !text.includes('event: error'));
  check('usage output_tokens=5', text.includes('"output_tokens":5'), text.split('message_delta').pop());
});

await test('非流式：scn-ok 正常 JSON 响应', async () => {
  const { status, text } = await callProxy('scn-ok', false);
  check('HTTP 200', status === 200, `got ${status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  check('文本完整', (json.content?.[0]?.text || '').includes('hello world'), text.slice(0, 300));
});

await test('非流式：scn-zero-once-ns 空响应重试成功', async () => {
  const { status, text } = await callProxy('scn-zero-once-ns', false);
  check('HTTP 200', status === 200, `got ${status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  check('文本完整', (json.content?.[0]?.text || '').includes('hello'), text.slice(0, 300));
  check('mock 收到 2 次上游请求', reqCounts['scn-zero-once-ns'] === 2, `got ${reqCounts['scn-zero-once-ns']}`);
});

await test('scn-strict-tools：孤儿 tool_use 重放 → 代理合成 tool result 救场', async () => {
  // 复刻用户卡死的会话：assistant 发起过 tool call，但 tool result 不在历史里
  const { status, text } = await callProxy('scn-strict-tools', true, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_d90471da2a5e45a0b0e9d66c', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', content: 'continue' },
  ]);
  check('HTTP 200', status === 200);
  check('无 error 事件（修补后上游接受）', !text.includes('event: error'), text);
  check('含完整回复', text.includes('hello') && text.includes(' world'));
  check('mock 只收到 1 次上游请求（首次即合法）', reqCounts['scn-strict-tools'] === 1, `got ${reqCounts['scn-strict-tools']}`);
  check('代理记录了修补日志', proxyLogs.join('').includes('Repaired tool call sequence'));
});

await test('scn-strict-tools：正常 tool_use/tool_result 配对不受影响', async () => {
  const { status, text } = await callProxy('scn-strict-tools', true, [
    { role: 'user', content: 'run it' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_abc123', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_abc123', content: 'file1.txt' }] },
  ]);
  check('HTTP 200', status === 200);
  check('无 error 事件', !text.includes('event: error'), text);
  check('含完整回复', text.includes('hello') && text.includes(' world'));
});

await test('scn-strict-tools：孤儿 tool_result（引用未知 call）→ 丢弃后通过', async () => {
  const { status, text } = await callProxy('scn-strict-tools', true, [
    { role: 'user', content: 'run it' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_abc456', name: 'Bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_abc456', content: 'ok' }, { type: 'tool_result', tool_use_id: 'call_unknown999', content: 'stale' }] },
  ]);
  check('HTTP 200', status === 200);
  check('无 error 事件', !text.includes('event: error'), text);
});

await test('多模态：data:video/mp4 经 image_url 传入 → 不再伪造非法 part，降级为文本并说明', async () => {
  upstreamBodies.length = 0;
  const { status } = await callOpenAI('scn-ok', [
    { role: 'user', content: [
      { type: 'text', text: '看视频' },
      { type: 'image_url', image_url: { url: 'data:video/mp4;base64,AAAA' } },
    ] },
  ]);
  check('HTTP 200', status === 200);
  const parts = upstreamBodies.at(-1)?.params?.messages?.[0]?.content || [];
  check('未生成 video_url / image 等非法 part',
    parts.every((p) => p.type === 'text' || p.type === 'image'), JSON.stringify(parts));
  check('降级为文本并说明视频无法转发', /视频无法转发/.test(JSON.stringify(parts)), JSON.stringify(parts));
});

await test('多模态：data:image/png → CC 原生 image part（source.base64）', async () => {
  upstreamBodies.length = 0;
  await callOpenAI('scn-ok', [
    { role: 'user', content: [
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
    ] },
  ]);
  const parts = upstreamBodies.at(-1)?.params?.messages?.[0]?.content || [];
  const media = parts.find((p) => p.type !== 'text');
  check('part 类型是 image', media?.type === 'image', JSON.stringify(media));
  check('使用 source.base64 形态（上游只认这个）',
    media?.source?.type === 'base64' && media?.source?.data === 'BBBB' && media?.source?.media_type === 'image/png',
    JSON.stringify(media));
  check('不再出现自创的 image 字段 / image_url / video_url',
    !('image' in (media || {})) && media?.type !== 'image_url' && media?.type !== 'video_url', JSON.stringify(media));
});

await test('多模态：Anthropic image 块 → CC 原生 image part（source 透传）', async () => {
  upstreamBodies.length = 0;
  await callProxy('scn-ok', true, [
    { role: 'user', content: [
      { type: 'text', text: '看图' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'JPEGDATA' } },
    ] },
  ]);
  const parts = upstreamBodies.at(-1)?.params?.messages?.[0]?.content || [];
  const media = parts.find((p) => p.type !== 'text');
  check('转成 image part', media?.type === 'image', JSON.stringify(media));
  check('数据与 media_type 完整保留',
    media?.source?.data === 'JPEGDATA' && media?.source?.media_type === 'image/jpeg', JSON.stringify(media));
});

await test('多模态：视频无法转发时降级为文本说明（而不是伪造 part 或静默丢弃）', async () => {
  upstreamBodies.length = 0;
  const { status } = await callProxy('scn-ok', true, [
    { role: 'user', content: [
      { type: 'text', text: '看视频' },
      { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: 'CCCC' } },
    ] },
  ]);
  check('HTTP 200（不再因非法 part 被上游 400）', status === 200);
  const parts = upstreamBodies.at(-1)?.params?.messages?.[0]?.content || [];
  check('所有 part 都是合法类型（仅 text/image）',
    parts.every((p) => p.type === 'text' || p.type === 'image'), JSON.stringify(parts));
  check('没有出现 video_url / image_url 等非法 part',
    !parts.some((p) => p.type === 'video_url' || p.type === 'image_url'), JSON.stringify(parts));
  const note = parts.map((p) => p.text || '').join(' ');
  check('如实说明视频无法转发及原因', /视频无法转发/.test(note) && /只支持 text 与 image/.test(note), note);
});

await test('多模态：远程图片 URL 无法内联 → 降级为文本说明', async () => {
  upstreamBodies.length = 0;
  await callOpenAI('scn-ok', [
    { role: 'user', content: [
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    ] },
  ]);
  const parts = upstreamBodies.at(-1)?.params?.messages?.[0]?.content || [];
  check('未生成非法 image part', parts.every((p) => p.type === 'text' || p.type === 'image'), JSON.stringify(parts));
  check('说明远程 URL 未内联', /远程 URL/.test(JSON.stringify(parts)), JSON.stringify(parts));
});

await test('tool_result 夹带图片 → 转成合法 image part', async () => {
  upstreamBodies.length = 0;
  const { status } = await callProxy('scn-ok', true, [
    { role: 'user', content: '读一下这个图片' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_v1', name: 'Read', input: { file_path: 'x.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_v1', content: [
      { type: 'text', text: '读到了图片' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'IMGDATA' } },
    ] }] },
  ]);
  check('HTTP 200', status === 200);
  const msgs = upstreamBodies.at(-1)?.params?.messages || [];
  const toolMsg = msgs.find((m) => m.role === 'tool');
  const flat = JSON.stringify(toolMsg || {});
  check('图片数据没有丢失', flat.includes('IMGDATA'), flat.slice(0, 200));
  check('文本说明也保留', flat.includes('读到了图片'));
  check('图片 part 合法（image + source.base64）',
    toolMsg?.content?.some((p) => p.type === 'image' && p.source?.type === 'base64'), flat.slice(0, 200));
});

await test('tool_result 夹带视频 → 降级为文本说明且 part 合法', async () => {
  upstreamBodies.length = 0;
  const { status } = await callProxy('scn-ok', true, [
    { role: 'user', content: '读一下这个视频' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_v3', name: 'Read', input: { file_path: 'x.mp4' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_v3', content: [
      { type: 'image', source: { type: 'base64', media_type: 'video/mp4', data: 'VIDEODATA' } },
    ] }] },
  ]);
  check('HTTP 200', status === 200);
  const msgs = upstreamBodies.at(-1)?.params?.messages || [];
  const toolMsg = msgs.find((m) => m.role === 'tool');
  const flat = JSON.stringify(toolMsg || {});
  check('所有 part 合法（仅 text/image）',
    (toolMsg?.content || []).every((p) => p.type === 'text' || p.type === 'image' || p.type === 'tool-result'), flat.slice(0, 200));
  check('说明视频无法转发', /视频无法转发/.test(flat), flat.slice(0, 240));
});

await test('tool_result 只有图片、没有文本 → 不再变成空结果', async () => {
  upstreamBodies.length = 0;
  await callProxy('scn-ok', true, [
    { role: 'user', content: '读一下这张图' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_v2', name: 'Read', input: { file_path: 'x.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_v2', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ONLYMEDIA' } },
    ] }] },
  ]);
  const msgs = upstreamBodies.at(-1)?.params?.messages || [];
  const toolMsg = msgs.find((m) => m.role === 'tool');
  const flat = JSON.stringify(toolMsg || {});
  check('图片保留', flat.includes('ONLYMEDIA'), flat.slice(0, 160));
  check('文本位置给出占位说明（不是空字符串）', /attached 1 media/.test(flat), flat.slice(0, 200));
});

await test('tool_result 纯文本保持原样（回归）', async () => {
  upstreamBodies.length = 0;
  await callProxy('scn-ok', true, [
    { role: 'user', content: 'run it' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_t1', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_t1', content: [{ type: 'text', text: 'file1.txt' }] }] },
  ]);
  const msgs = upstreamBodies.at(-1)?.params?.messages || [];
  const toolMsg = msgs.find((m) => m.role === 'tool');
  check('文本结果完整保留', toolMsg?.content?.[0]?.output?.value === 'file1.txt', JSON.stringify(toolMsg));
  check('未额外塞入媒体 part', toolMsg?.content?.length === 1, JSON.stringify(toolMsg));
});

await test('超限请求：返回规范 413 而不是掐断连接（曾导致客户端卡在"重连中"）', async () => {
  // 限制已收紧到 2MB，这里发 5MB
  const bigBody = JSON.stringify({
    model: 'scn-ok', max_tokens: 10,
    messages: [{ role: 'user', content: [
      { type: 'text', text: '看视频' },
      { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: 'A'.repeat(5 * 1024 * 1024) } },
    ] }],
  });
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PROXY_KEY}`, 'anthropic-version': '2023-06-01' },
    body: bigBody,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  check('返回 HTTP 413（而不是连接被重置）', res.status === 413, `got ${res.status}`);
  check('错误体说明体积与上限', /too large/i.test(text) && /MB/.test(text), text.slice(0, 200));
  check('提示可调大 maxBodySize', text.includes('maxBodySize'), text.slice(0, 200));
});

await test('超限后代理仍存活，正常请求不受影响', async () => {
  const { status, text } = await callProxy('scn-ok');
  check('HTTP 200', status === 200);
  check('正常返回内容', text.includes('hello'), text.slice(0, 200));
});

console.log('\n──── proxy 日志（截选）────');
console.log(proxyLogs.join('').split('\n').filter((l) => /error|warn|Retry|disconn|zero/i.test(l)).join('\n'));

proxy.kill();
await delay(300);
console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
