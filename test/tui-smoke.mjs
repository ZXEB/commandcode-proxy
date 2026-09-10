// cmd TUI 冒烟测试（不依赖外网、不依赖真实 API Key、不写任何 C 盘文件）
// 用法：node test/tui-smoke.mjs
//
// 覆盖：
//   A. 有 Key：启动即展示「当前套餐可用模型」（Provider API 真实来源）
//   B. Key 无效（401）：回退内置列表，并如实提示原因（不假装是套餐列表）
//   C. 菜单 [4] 手输 Key：回显屏蔽、可选不落盘、config.json 保持原样
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MOCK_PORT = 4180;
const PROXY_PORT = 3160;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const LOCAL_CONFIG_PATH = path.join(ROOT, 'config.local.json');

const PLAN_MODELS = [
  { id: 'claude-sonnet-4-6' },
  { id: 'deepseek/deepseek-v4-flash' },
  { id: 'xiaomi/mimo-v2.5', name: 'MiMo V2.5' },
];
const BAD_KEY = 'user_badkey999';
const MENU_MARK = '[0] 退出（停止代理）';

// ── Mock 上游 ─────────────────────────────────────────
const mockRequests = { provider: 0, badKey: 0 };
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const auth = req.headers.authorization || '';
    if (req.url === '/provider/v1/models') {
      mockRequests.provider++;
      if (auth.includes(BAD_KEY)) {
        mockRequests.badKey++;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: PLAN_MODELS }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}'); // fingerprint / lifecycle-events / 其他
  });
});

// ── 断言工具 ──────────────────────────────────────────
let failures = 0;
function check(ok, label, extra = '') {
  if (ok) { console.log(`  ✓ ${label}`); return; }
  failures++;
  console.log(`  ✗ ${label}${extra ? `\n      ${extra}` : ''}`);
}

function tail(s, n = 1500) {
  const t = s.length > n ? '…' + s.slice(-n) : s;
  return t.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n').map((l) => '      | ' + l).join('\n');
}

function runProxy({ apiKey, steps, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'proxy.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PROXY_PORT),
        CC_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
        CC_TUI: 'force',        // 管道下强制启用 TUI（真实 cmd 里靠 isTTY 自动启用）
        CC_TUI_COLOR: '0',
        CC_API_KEY: apiKey || '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let step = 0;
    let searchFrom = 0;
    // 按步骤喂输入：等上一屏出来再发下一行，模拟真人按键（也才能验证 Key 输入不被回显）
    const pump = () => {
      while (step < steps.length && out.indexOf(steps[step].waitFor, searchFrom) !== -1) {
        const s = steps[step++];
        searchFrom = out.length;
        child.stdin.write(s.send);
      }
    };
    const onData = (buf) => { out += buf.toString(); pump(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`proxy 超时未退出（已发 ${step}/${steps.length} 步）\n---- 输出 ----\n${out}`));
    }, timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.on('error', reject);
  });
}

// ── 场景 ─────────────────────────────────────────────
const configBefore = fs.readFileSync(CONFIG_PATH, 'utf8');
// config.local.json 可能存着用户真实的 Key —— 测试只做"快照 + 还原"，绝不破坏它
const localBefore = fs.existsSync(LOCAL_CONFIG_PATH) ? fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8') : null;
function restoreLocalConfig() {
  if (localBefore === null) fs.rmSync(LOCAL_CONFIG_PATH, { force: true });
  else fs.writeFileSync(LOCAL_CONFIG_PATH, localBefore, 'utf8');
}

async function main() {
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  console.log(`mock 上游: http://127.0.0.1:${MOCK_PORT}\n`);

  // A. 有效 Key —— 启动即显示当前套餐模型，菜单各项可用，退出干净
  console.log('场景 A：有效 Key · 启动展示当前套餐可用模型');
  const a = await runProxy({
    apiKey: 'user_tuitest123',
    steps: [
      { waitFor: '当前套餐可用模型（共 3 个）', send: '3\n' },
      { waitFor: '服务状态与配置', send: '5\n' },
      { waitFor: '最近日志', send: '0\n' },
    ],
  });
  check(a.code === 0, '退出码 0', `实际 ${a.code}\n${tail(a.out)}`);
  check(a.out.includes('当前套餐可用模型（共 3 个）'), '展示套餐模型数量');
  for (const m of PLAN_MODELS) check(a.out.includes(m.id), `模型 ${m.id} 在列表中`);
  check(a.out.includes('数据来源: Provider API'), '标注数据来源为 Provider API');
  check(a.out.includes('服务状态与配置') && a.out.includes('已处理请求'), '菜单 [3] 服务状态');
  check(a.out.includes('最近日志'), '菜单 [5] 最近日志');
  check(a.out.includes('请输入序号 >'), '主菜单提示符');
  // 输出会滚动追加，菜单必须每次输出完再摆一遍，否则用户得往上翻
  const menuCount = a.out.split(MENU_MARK).length - 1;
  check(menuCount >= 4, `每次输出后重印菜单（全文 ${menuCount} 次：初始 + 模型列表 + 状态 + 日志）`);
  check(a.out.lastIndexOf(MENU_MARK) > a.out.lastIndexOf('最近日志（缓存'), '最后一次菜单在日志输出之后');
  check(a.out.lastIndexOf(MENU_MARK) > a.out.lastIndexOf('当前套餐可用模型（共 3 个）'), '菜单在模型列表之后');
  check(!a.out.includes('user_tuitest123'), '❌ 日志/界面未泄露完整 API Key');
  check(mockRequests.provider >= 1, '已向 Provider API 拉取模型');

  // B. 无效 Key —— 401 → 内置列表 + 如实警告
  console.log('\n场景 B：无效 Key（401）· 回退内置列表并给出原因');
  const b = await runProxy({
    apiKey: BAD_KEY,
    steps: [
      { waitFor: '以下为内置参考列表', send: '2\n' },
      { waitFor: '请按 [4] 设置有效 API Key 后重试。', send: '0\n' },
    ],
  });
  check(b.code === 0, '退出码 0', `实际 ${b.code}\n${tail(b.out)}`);
  check(b.out.includes('未能获取套餐模型'), '提示未能获取套餐模型');
  check(b.out.includes('API Key 无效或已过期'), '指出 401 原因');
  check(b.out.includes('以下为内置参考列表'), '明确标注是内置回退列表');
  check(b.out.includes('claude-opus-4-8'), '回退列表包含内置模型');
  check(!b.out.includes('数据来源: Provider API'), '未伪称数据来自 Provider API');
  check(!b.out.includes(BAD_KEY), '❌ 未泄露无效 Key');
  check(mockRequests.badKey >= 1, 'mock 已收到无效 Key 请求');

  // C. 菜单 [4] 手动输入 Key —— 不回显、不落盘
  console.log('\n场景 C：菜单 [4] 手输 Key · 回显屏蔽 + 选择不写盘');
  const typedKey = 'user_typedkey777';
  const c = await runProxy({
    apiKey: '',
    steps: [
      { waitFor: '请输入序号', send: '4\n' },
      { waitFor: '粘贴 API Key', send: `${typedKey}\n` },
      { waitFor: '是否写入 config.local.json', send: 'n\n' },
      { waitFor: '未写入文件，仅本次运行有效', send: '1\n' },
      { waitFor: '当前套餐可用模型（共 3 个）', send: '0\n' },
    ],
  });
  check(c.code === 0, '退出码 0', `实际 ${c.code}\n${tail(c.out)}`);
  check(!c.out.includes(typedKey), '❌ 手输的 Key 未回显到终端');
  check(c.out.includes('已启用 API Key user_****'), '显示脱敏后的 Key');
  check(c.out.includes('未写入文件，仅本次运行有效'), '选择 n 后不落盘');
  check(c.out.includes('当前套餐可用模型（共 3 个）'), '换 Key 后能拉取套餐模型');

  const configAfter = fs.readFileSync(CONFIG_PATH, 'utf8');
  check(configBefore === configAfter, 'config.json 未被改动（本次测试全程不落盘）');
  const localNow = fs.existsSync(LOCAL_CONFIG_PATH) ? fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8') : null;
  check(localNow === localBefore, '选择 n 时不新建/不改动 config.local.json');

  // D. 菜单 [4] 输入 Key 并选择写入 → 落到 config.local.json（git/镜像已排除），结束还原
  console.log('\n场景 D：菜单 [4] 手输 Key · 重复粘贴自动合并 + 选择 y 持久化');
  const typedKey2 = 'user_typedkey888';
  const d = await runProxy({
    apiKey: '',
    steps: [
      { waitFor: '请输入序号', send: '4\n' },
      // 模拟终端里连续粘贴 3 次同一把 Key（真实踩过的坑：贪婪正则会把它们粘成一把超长 Key）
      { waitFor: '粘贴 API Key', send: `${typedKey2}${typedKey2}${typedKey2}\n` },
      { waitFor: '是否写入 config.local.json', send: 'y\n' },
      { waitFor: '已在 .gitignore / .dockerignore 中排除', send: '0\n' },
    ],
  });
  check(d.code === 0, '退出码 0', `实际 ${d.code}\n${tail(d.out)}`);
  check(d.out.includes('检测到连续粘贴了多份相同的 Key'), '提示了重复粘贴并自动合并');
  check(fs.existsSync(LOCAL_CONFIG_PATH), '已写入 config.local.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8')); } catch {}
  check(saved.apiKey === typedKey2, '存下去的是合并后的单份 Key', `实际 ${String(saved.apiKey).slice(0, 40)}…`);
  check(fs.readFileSync(CONFIG_PATH, 'utf8') === configBefore, 'config.json 依然未被改动');
  check(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').includes('config.local.json'), '.gitignore 已排除 config.local.json');
  check(fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8').includes('config.local.json'), '.dockerignore 已排除 config.local.json');

  restoreLocalConfig();
  const restored = fs.existsSync(LOCAL_CONFIG_PATH) ? fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8') : null;
  check(restored === localBefore, localBefore === null ? '测试已清理 config.local.json' : '已还原用户原有的 config.local.json');

  await new Promise((r) => mock.close(r));
  console.log(failures === 0 ? '\n全部通过 ✅' : `\n失败 ${failures} 项 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('测试异常:', e.message);
  try { await new Promise((r) => mock.close(r)); } catch {}
  process.exit(1);
});
