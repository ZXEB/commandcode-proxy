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
const NOW = Date.now(); // 窗口重置时间基于当前时刻，保证"还剩 N 小时"可断言
const BAD_KEY = 'user_badkey999';
const NO_QUOTA_KEY = 'user_noquota111';   // 模型能拉、额度接口 401
const SLOW_KEY = 'user_slowkey222';       // 账单接口挂起不响应 → 验证超时提示
const PARTIAL_KEY = 'user_partial333';    // subscriptions 500 → 验证部分失败告警
const MENU_MARK = '[0] 退出（停止代理）';

// ── Mock 上游 ─────────────────────────────────────────
const mockRequests = { provider: 0, badKey: 0, quota: 0, quotaPaths: [] };
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const auth = req.headers.authorization || '';
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.url === '/provider/v1/models') {
      mockRequests.provider++;
      if (auth.includes(BAD_KEY)) {
        mockRequests.badKey++;
        send(401, { error: { message: 'invalid api key' } });
        return;
      }
      send(200, { object: 'list', data: PLAN_MODELS });
      return;
    }

    // 套餐额度：与官方 CLI 一致的 4 个端点
    if (req.url.startsWith('/alpha/')) {
      mockRequests.quota++;
      mockRequests.quotaPaths.push(req.url);
      if (auth.includes(BAD_KEY) || auth.includes(NO_QUOTA_KEY)) {
        send(401, { error: { message: 'invalid api key' } });
        return;
      }
      const path = req.url.split('?')[0];
      if (path === '/alpha/whoami') {
        send(200, { user: { id: 'u_1', userName: 'tester' }, org: { id: 'org_9', login: 'tester-org' } });
        return;
      }
      // 模拟 CC 账单接口"很慢"：挂起不响应，直到客户端超时
      if (auth.includes(SLOW_KEY)) return;
      // 模拟部分接口故障：周期信息拿不到，但额度本身正常
      if (auth.includes(PARTIAL_KEY) && path === '/alpha/billing/subscriptions') {
        send(500, { error: { message: 'boom' } });
        return;
      }
      if (path === '/alpha/billing/credits') {
        // 与线上真实返回一致：windowLimits 是顶层字段，和 credits 平级；
        // 窗口字段是 used/cap，resetAt 是 epoch 毫秒。
        send(200, {
          credits: {
            belowThreshold: false,
            creditThreshold: 0,
            monthlyCredits: 54.5,   // 与下面 totalCost=25.5、套餐 $80 自洽：80 - 25.5
            purchasedCredits: 10,
            freeCredits: 1.5,
          },
          windowLimits: {
            limited: true,
            exceeded: null,
            fiveHour: { used: 1.5, cap: 3, exceeded: false, resetAt: NOW + 2 * 3600 * 1000 + 30 * 60 * 1000 },
            weekly: { used: 4.5, cap: 6, exceeded: false, resetAt: NOW + 26 * 3600 * 1000 },
          },
        });
        return;
      }
      if (path === '/alpha/billing/subscriptions') {
        send(200, {
          data: {
            planId: 'individual-pro-v1',
            status: 'active',
            currentPeriodStart: '2026-09-01T00:00:00Z',
            currentPeriodEnd: '2026-10-01T00:00:00Z',
          },
        });
        return;
      }
      if (path === '/alpha/usage/summary') {
        // 与线上真实返回一致的字段（含 token 累计）
        send(200, {
          totalCount: 2868,
          totalCost: 25.5,
          averageCost: 0.008892,
          successRate: 100,
          completedCount: 2868,
          failedCount: 0,
          totalTokensIn: 198045411,
          totalTokensOut: 1448250,
          totalTokens: 199493661,
          periodBasis: 'billing-period',
        });
        return;
      }
    }

    send(200, {}); // fingerprint / lifecycle-events / 其他
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

function runProxy({ apiKey, steps, timeoutMs = 30000, env = {} }) {
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
        ...env,
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

  // A. 有效 Key —— 启动只摆菜单（不自动刷模型），各菜单项可用，退出干净
  console.log('场景 A：有效 Key · 启动不自动拉模型，按 [1] 才展示');
  const a = await runProxy({
    apiKey: 'user_tuitest123',
    steps: [
      { waitFor: '请输入序号', send: '1\n' },
      { waitFor: '当前套餐可用模型（共 3 个）', send: '4\n' },
      { waitFor: '服务状态与配置', send: '6\n' },
      { waitFor: '最近日志', send: '0\n' },
    ],
  });
  check(a.code === 0, '退出码 0', `实际 ${a.code}\n${tail(a.out)}`);
  check(a.out.includes('当前套餐可用模型（共 3 个）'), '展示套餐模型数量');
  for (const m of PLAN_MODELS) check(a.out.includes(m.id), `模型 ${m.id} 在列表中`);
  check(a.out.includes('数据来源: Provider API'), '标注数据来源为 Provider API');
  check(a.out.includes('服务状态与配置') && a.out.includes('已处理请求'), '菜单 [4] 服务状态');
  check(a.out.includes('最近日志'), '菜单 [6] 最近日志');
  check(a.out.includes('请输入序号 >'), '主菜单提示符');
  // 启动时不应自动拉取模型列表（用户明确要求别每次启动都刷屏）
  const firstModelAt = a.out.indexOf('当前套餐可用模型（共 3 个）');
  const firstPromptAt = a.out.indexOf('请输入序号 >');
  check(firstModelAt > firstPromptAt, '启动只摆菜单，模型列表要按 [1] 才出现（不自动刷屏）');
  check((a.out.match(/当前套餐可用模型（共 3 个）/g) || []).length === 1, '模型列表只打印了一次（没有启动时那次多余输出）');
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
      { waitFor: '请输入序号', send: '1\n' },
      { waitFor: '以下为内置参考列表', send: '2\n' },
      { waitFor: '请按 [5] 设置有效 API Key 后重试。', send: '0\n' },
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

  // B2. 套餐额度：[3] 展示套餐名 / 剩余 / 已用 / 周期 / 限流窗口
  console.log('\n场景 B2：菜单 [3] 查看当前套餐额度');
  const b2 = await runProxy({
    apiKey: 'user_tuitest123',
    steps: [
      { waitFor: '请输入序号', send: '3\n' },
      { waitFor: '刷新时间：', send: '8\n' },   // [8] 强制刷新（跳过 30s 缓存）
      { waitFor: '耗时', send: '0\n' },
    ],
  });
  check(b2.code === 0, '退出码 0', `实际 ${b2.code}\n${tail(b2.out)}`);
  check(b2.out.includes('当前套餐额度'), '显示额度面板标题');
  check(b2.out.includes('套餐：Pro') && b2.out.includes('（active）'), '解析出套餐名 Pro 与 active 状态');
  check(b2.out.includes('$80.00/月'), 'planId individual-pro-v1 → 标称额度 $80/月（长前缀优先）');
  // 用量窗口：windowLimits 在 credits 响应顶层（曾经读错路径导致窗口整个不显示）
  check(b2.out.includes('用量窗口'), '显示用量窗口区块');
  check(/5小时\s+\[\u2588+\u2591+\]\s+50%/.test(b2.out), '5小时窗口 1.5/3 → 50% 进度条');
  check(/每周\s+\[\u2588+\u2591+\]\s+75%/.test(b2.out), '每周窗口 4.5/6 → 75% 进度条');
  check(/每月\s+\[\u2588+\u2591+\]\s+28%/.test(b2.out), '每月窗口按套餐周期额度算 → 28%');
  check(b2.out.includes('2小时30分后重置'), '5小时窗口显示距重置的剩余时长');
  check(b2.out.includes('1天2小时后重置'), '每周窗口显示距重置的剩余时长');
  check((b2.out.match(/剩余 \$1\.50/g) || []).length >= 2, '两个窗口分别算出剩余额度 $1.50');
  check(b2.out.includes('额度池：剩余 $66.00 / $91.50'), '额度池与剩余计算正确（对齐 CLI projectUsageView）');
  check(b2.out.includes('已用 $25.50'), '本期已花费正确（usage/summary 的 totalCost）');
  check(b2.out.includes('其中 月度 $54.50 · 加油包 $10.00 · 赠送 $1.50'), '三类额度拆分正确');
  // 累计用量：199493661 → 199.5M（按官方口径以 M 显示）
  check(b2.out.includes('累计用量：199.5M tokens'), '累计用量按 M 显示（199493661 → 199.5M）');
  check(b2.out.includes('输入 198.0M · 输出 1.4M'), '输入/输出 tokens 分别折算');
  check(b2.out.includes('2,868 次请求'), '显示请求次数（带千分位）');
  check(b2.out.includes('均次 $0.0089'), '单次均价小于 1 分时提高精度（不显示成 $0.00）');
  check(b2.out.includes('统计自本计费周期起点'), '如实标注统计口径（服务端只按周期聚合）');
  check(b2.out.includes('账号：tester') && b2.out.includes('组织 tester-org'), '展示账号与组织');
  check(b2.out.includes('还剩'), '展示周期剩余天数');
  check(/刷新时间：\d{4}\/\d+\/\d+/.test(b2.out), '显示刷新时间（绝对时刻）');
  const quotaPaths = mockRequests.quotaPaths.map((u) => u.split('?')[0]);
  check(quotaPaths.includes('/alpha/whoami'), '先请求 whoami');
  check(quotaPaths.includes('/alpha/billing/credits'), '请求 billing/credits');
  check(quotaPaths.includes('/alpha/billing/subscriptions'), '请求 billing/subscriptions');
  check(quotaPaths.includes('/alpha/usage/summary'), '请求 usage/summary');
  check(mockRequests.quotaPaths.some((u) => u.includes('orgId=org_9')), '带上了 whoami 返回的 orgId');
  check(mockRequests.quotaPaths.some((u) => u.includes('since=2026-09-01')), 'usage/summary 带上了周期起点 since');
  // 首次发现组织后要把 orgId 记住，后续刷新直接带上（省掉一轮等待）
  const lastCredits = [...mockRequests.quotaPaths].reverse().find((u) => u.startsWith('/alpha/billing/credits'));
  check(lastCredits.includes('orgId=org_9'), '第二次刷新直接用上了缓存的 orgId（末次 credits 请求带 orgId）');
  check(b2.out.includes('耗时'), '展示本次拉取耗时');
  check(!b2.out.includes('user_tuitest123'), '❌ 额度面板未泄露完整 API Key');

  // C. 额度接口 401：如实报错，不编数字
  console.log('\n场景 C：额度接口 401 · 如实报错且不伪造额度');
  const c0 = await runProxy({
    apiKey: NO_QUOTA_KEY,
    steps: [
      { waitFor: '请输入序号', send: '3\n' },
      { waitFor: '❌ 读取失败', send: '0\n' },
    ],
  });
  check(c0.code === 0, '退出码 0', `实际 ${c0.code}\n${tail(c0.out)}`);
  check(c0.out.includes('❌ 读取失败') && c0.out.includes('401'), '提示读取失败并给出 401');
  check(!c0.out.includes('剩余：$'), '❌ 失败时没有编造额度数字');

  // C2. 账单接口挂起 → 超时；必须给出看得懂的提示，且不能永远卡住
  console.log('\n场景 C2：账单接口不响应 · 超时提示（CC_QUOTA_TIMEOUT_MS=1500）');
  const c2 = await runProxy({
    apiKey: SLOW_KEY,
    env: { CC_QUOTA_TIMEOUT_MS: '1500' },
    steps: [
      { waitFor: '请输入序号', send: '3\n' },
      { waitFor: '❌ 读取失败', send: '0\n' },
    ],
    timeoutMs: 60000,
  });
  check(c2.code === 0, '退出码 0', `实际 ${c2.code}\n${tail(c2.out)}`);
  check(c2.out.includes('账单接口超时'), '提示是「账单接口超时」而不是英文原文');
  check(c2.out.includes('/alpha/billing/credits'), '指出是哪个端点超时');
  check(c2.out.includes('quotaTimeoutMs'), '给出可调大超时的排查建议');
  check(!c2.out.includes('The operation was aborted'), '❌ 不再把 undici 英文原文丢给用户');

  // C3. 部分接口故障：额度照常显示，缺的那块如实告警
  console.log('\n场景 C3：subscriptions 故障 · 部分数据缺失如实告警');
  const c3 = await runProxy({
    apiKey: PARTIAL_KEY,
    steps: [
      { waitFor: '请输入序号', send: '3\n' },
      { waitFor: '部分数据未取到', send: '0\n' },
    ],
  });
  check(c3.code === 0, '退出码 0', `实际 ${c3.code}\n${tail(c3.out)}`);
  check(c3.out.includes('额度池：剩余 $66.00'), '余额仍正常展示（核心数据没被拖垮）');
  check(c3.out.includes('用量窗口') && c3.out.includes('5小时'), '5小时/每周窗口照常展示（来自 credits 接口）');
  check(c3.out.includes('部分数据未取到') && c3.out.includes('billing/subscriptions'), '如实列出缺失的接口');
  check(!c3.out.includes('周期：'), '缺周期信息时不显示空周期行');

  // D. 菜单 [5] 手动输入 Key —— 不回显、不落盘
  console.log('\n场景 D：菜单 [5] 手输 Key · 回显屏蔽 + 选择不写盘');
  const typedKey = 'user_typedkey777';
  const c = await runProxy({
    apiKey: '',
    steps: [
      { waitFor: '请输入序号', send: '5\n' },
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
  check(c.out.includes('当前套餐可用模型（共 3 个）'), '换 Key 后按 [1] 能拉取套餐模型');

  const configAfter = fs.readFileSync(CONFIG_PATH, 'utf8');
  check(configBefore === configAfter, 'config.json 未被改动（本次测试全程不落盘）');
  const localNow = fs.existsSync(LOCAL_CONFIG_PATH) ? fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8') : null;
  check(localNow === localBefore, '选择 n 时不新建/不改动 config.local.json');

  // E. 菜单 [5] 输入 Key 并选择写入 → 落到 config.local.json（git/镜像已排除），结束还原
  console.log('\n场景 E：菜单 [5] 手输 Key · 重复粘贴自动合并 + 选择 y 持久化');
  const typedKey2 = 'user_typedkey888';
  const d = await runProxy({
    apiKey: '',
    steps: [
      { waitFor: '请输入序号', send: '5\n' },
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

  await new Promise((r) => { try { mock.closeAllConnections?.(); } catch {} r(); });
  await new Promise((r) => mock.close(r));
  console.log(failures === 0 ? '\n全部通过 ✅' : `\n失败 ${failures} 项 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('测试异常:', e.message);
  try { await new Promise((r) => mock.close(r)); } catch {}
  process.exit(1);
});
