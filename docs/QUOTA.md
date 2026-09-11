# 套餐额度显示：实现说明

> 讲清楚控制台 `[3] 查看当前套餐额度` 是怎么做出来的：数据从哪来、怎么算、怎么画，以及为什么这么设计。
>
> 相关代码集中在 `proxy.mjs`：
> - **取数与计算**：约 2200–2420 行
> - **渲染**：约 2645–2760 行

---

## 0. 最终效果

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

---

## 1. 数据来源：从官方 CLI 里挖出来的协议

这部分没有靠猜。官方 CLI 装在 `%APPDATA%\npm\node_modules\command-code`，它的 `dist/cli.mjs` 虽然被压缩混淆，但字符串常量和内部函数名还在，从中可以定位到 `/usage` 面板所用的端点。

### 四个只读端点

| 端点 | 用途 | 关键字段 |
|------|------|----------|
| `GET /alpha/whoami` | 账号与组织 | `user`, `org.id`（`orgId` 的来源） |
| `GET /alpha/billing/credits` | 额度与限流窗口 | `credits.*`、**顶层** `windowLimits.*` |
| `GET /alpha/billing/subscriptions` | 套餐与计费周期 | `data.planId`、`data.status`、`data.currentPeriodStart/End` |
| `GET /alpha/usage/summary` | 本周期消耗 | `totalCost`、`totalCount`、`totalTokens*` |

四个都是 **只读 GET，不消耗额度**。请求头照抄 CLI：

```js
{
  'Authorization': `Bearer ${apiKey}`,
  'x-cli-environment': 'production',
  'x-command-code-version': CC_VERSION,   // 动态从 npm registry 拉取
  'traceparent': generateTraceparent(),   // W3C Trace Context
}
```

### 真实返回长什么样

```json
// GET /alpha/billing/credits
{
  "credits": {
    "belowThreshold": false,
    "creditThreshold": 0,
    "monthlyCredits": 4.9590200369,
    "purchasedCredits": 0,
    "freeCredits": 0
  },
  "windowLimits": {
    "limited": true,
    "exceeded": null,
    "fiveHour": { "used": 0.07209606, "cap": 3, "exceeded": false, "resetAt": 1789139069459 },
    "weekly":   { "used": 1.833011698, "cap": 6, "exceeded": false, "resetAt": 1789199133465 }
  }
}
```

### 两个必须知道的坑

1. **`windowLimits` 是顶层字段**，和 `credits` 平级，**不在** `credits` 里面。
   一开始按 `credits.windowLimits` 读，结果 5 小时 / 每周窗口一直不显示。
   官方 CLI 的 `projectUsageView` 里写的是 `e.credits?.windowLimits`，其中 `e.credits` 指的是**整个响应体**，不是 `body.credits` —— 名字有歧义，容易读错。

2. **字段名是 `cap` 不是 `limit`；`resetAt` 是 epoch 毫秒**，不是 ISO 字符串。
   如果按常识猜成 `limit` / ISO，画出来就是空的或 `Invalid Date`。

> 这类细节靠猜必然出错。做法是先把原始返回完整 dump 出来核对，再写解析。

---

## 2. 计算：`projectQuota()`

把四个响应拍平成一个视图，算法与 CLI 内部 `projectUsageView` 对齐：

```js
const monthlyRemaining   = credits.credits.monthlyCredits;
const purchasedRemaining = credits.credits.purchasedCredits;   // 加油包
const freeRemaining      = credits.credits.freeCredits;        // 赠送
const totalRemaining     = monthlyRemaining + purchasedRemaining + freeRemaining;

const totalSpent = usage.summary.totalCost;   // 本周期起点以来的花费

// 订阅有效时才用套餐标称额度当分母
const active = ['active', 'trialing', 'past_due'].includes(subscription.status);
const totalPool = active
  ? Math.max(plan.monthlyCredits, monthlyRemaining) + purchasedRemaining + freeRemaining
  : totalSpent + totalRemaining;

const usagePercent = (totalPool - totalRemaining) / totalPool * 100;
```

### 为什么用 `Math.max()`

额度可能被补发、叠加或有促销，`monthlyCredits` 有时**高于**套餐标称值。
若直接用标称值当分母，会出现「剩余 > 总额」，进度条算成负数。
取两者较大值即可避免。

### 套餐标称额度表

服务端不直接给「套餐总额」，只用 `planId` 标识套餐，所以标称额度需内置（数值取自 CLI）：

| planId | 显示名 | 标称额度/月 |
|--------|--------|-------------|
| `individual-go` | Go | $10 |
| `individual-provider` | Provider | $15 |
| `individual-pro` | Pro | $30 |
| `individual-pro-v1` | Pro | $80 |
| `individual-goat` | GOAT | $70 |
| `individual-max` | Max | $150 |
| `individual-ultra` | Ultra | $300 |
| `teams-pro` | Teams Pro | $40 |

**必须按长度倒序做前缀匹配**：

```js
const PLAN_KEYS_BY_LENGTH = Object.keys(PLAN_MONTHLY_CREDITS).sort((a, b) => b.length - a.length);
const key = PLAN_KEYS_BY_LENGTH.find(k => normalizedPlanId.startsWith(k));
```

否则 `individual-pro` 会抢先命中 `individual-pro-v1`，把 $80 的套餐显示成 $30。
`planId` 还会先做 `toLowerCase().replace(/_/g, '-')` 归一化。

---

## 3. 三个窗口的数据来源不同

| 窗口 | 数据来源 | 计算方式 |
|------|----------|----------|
| **5 小时** | `windowLimits.fiveHour` | `used / cap`，重置时间取 `resetAt` |
| **每周** | `windowLimits.weekly` | 同上 |
| **每月** | 服务端**没有**这个窗口 | 用套餐周期额度自算：`(池 - 剩余) / 池`，重置时间取 `subscriptions.currentPeriodEnd` |

前两个是服务端维护的**滚动窗口限流**（防止短时间高频调用），第三个是**计费周期额度**，性质不同，服务端不给，只能自己算。

`renderWindowLimits()` 保留了向前兼容：

- 若服务端将来真的加了 `windowLimits.monthly`，会优先用服务端的；
- 出现未知窗口名（不在 `knownKeys` 白名单里）也会照样列出来，**不静默吞掉**；
- `limits.limited === false` 时整个区块不显示。

### 渲染样式

```
 5小时  [█░░░░░░░░░░░░░░░░░░░]   3%  剩余 $2.90 · 10分后重置（23:04）
 └标签  └进度条(20格)           └百分比 └剩余额度  └倒计时      └重置时刻
```

- **进度条颜色随占用率变化**：<70% 绿 / ≥70% 黄 / ≥90% 红；
- `w.exceeded === true` 时额外打一行红色「⚠️ 该窗口已超限」；
- **重置时刻的显示规则沿用 CLI**：当天只显示时间（`23:04`），跨天才带日期（`2026/9/12 15:45`），避免每行过长；
- 倒计时格式：`2天3小时` / `3小时12分` / `45分`（对齐 CLI 的 `formatDuration`）。

---

## 4. 累计用量（tokens）

面板里的「累计用量」取自 `usage/summary` 的 token 字段，按官方口径以 **M（百万）** 显示：

```js
totalTokens    → 199493661 → 199.5M
totalTokensIn  → 198045411 → 198.0M
totalTokensOut →  1448250 →   1.4M
```

> 官方 CLI 的 `/usage` 面板本身没有展示 token 数，只显示 `$X left · N requests · N days to renewal`；
> 这里补充 token 是把 `usage/summary` 里已有的字段一并呈现，格式化口径（M）与之保持一致。

### ⚠️ 口径说明：这是「本计费周期累计」，不是全部历史

实测 `usage/summary` 的 `since` 参数**被服务端忽略**：

| 请求 | 返回 `totalTokens` | `periodBasis` |
|------|-------------------|---------------|
| `?since=<周期起点>` | 233370995 | `billing-period` |
| 不带 `since` | 233370995 | `billing-period` |
| `?since=2020-01-01`（试图查全部历史） | 233370995 | `billing-period` |
| `?basis=all` / `?allTime=true` | 233370995 | `billing-period` |

四种请求返回**完全相同**的数字，且 `periodBasis` 恒为 `billing-period` —— 服务端只会按**当前计费周期**聚合，没有提供「全部历史累计」的口径。

因此界面上如实标注为「**统计自本计费周期起点**」，而不是含糊地写「累计」让人误以为是注册至今的总量。做法上仍然传 `since`（万一服务端以后支持，行为自动变正确），但文案按实测口径写。

### 附带字段

| 字段 | 显示 |
|------|------|
| `totalCount` | `3,012 次请求`（千分位） |
| `averageCost` | `均次 $0.0017` |

`averageCost` 常常小于 1 分钱，若沿用 `toFixed(2)` 会显示成 `$0.00`（看着像免费），所以小于 `$0.01` 时自动提高到 4 位小数（`formatSmallCredits()`）。

---

## 5. 慢接口的工程处理

实测这几个接口**本身极慢**（DNS 只要 2ms，慢在服务端）：

| 端点 | 实测延迟 |
|------|----------|
| `/alpha/whoami` | 7 ~ 17s |
| `/alpha/billing/credits` | 0.8 ~ 1.3s |
| `/alpha/billing/subscriptions` | 最高 20s+ |
| `/alpha/usage/summary` | ~8s |
| **串行总计** | **47s** |

> 最初实现是串行 + 每个请求 10 秒超时，结果必然误报 `The operation was aborted due to timeout`。
> 这是实测后才定位到的问题 —— **不要凭感觉设超时**。

对应措施：

| 措施 | 说明 |
|------|------|
| **并行** | `whoami` + `credits` + `subscriptions` 同时发；总耗时变为「最慢的那个」而非求和 |
| **`summary` 后置** | 它依赖 `subscriptions` 的 `currentPeriodStart` 作为 `since`，必须等前面回来 |
| **超时 45s** | `quotaTimeoutMs`（config.json）或 `CC_QUOTA_TIMEOUT_MS` 可调 |
| **`orgId` 记忆化** | 首次从 `whoami` 拿到后存入 `quotaOrgIds`，后续刷新直接带上，省一轮往返；个人账号 `orgId` 为 `null`，属于「已知无组织」，不会反复重查 |
| **等待反馈** | 每 5 秒打印「…仍在读取套餐额度（已等待 Ns）」，避免看起来卡死 |
| **30 秒缓存** | `[3]` 命中缓存立即返回；`[8]` 强制刷新 |

### 按端点降级

不是任何一个端点挂掉就整个面板失败：

```
credits          → 核心数据。失败才判定整体失败；非 4xx 错误（超时/网络）自动重试一次；
                   401 等明确错误直接抛出，不浪费一次重试
whoami           → 只影响 orgId 与账号显示，失败仅记 warning
subscriptions    → 影响周期信息与 summary 的 since，失败仅记 warning
usage/summary    → 影响「已用」，失败仅记 warning
```

单个失败的端点会如实列在「部分数据未取到」里，其余数据照常显示。

---

## 6. 诚实性设计（重要）

额度显示错了比不显示更糟，所以：

- **绝不编造数字**：拿不到就是拿不到，不用 0 或旧值冒充；
- **错误分类可读**：401 说「API Key 无效或已过期（HTTP 401）」；超时说「账单接口超时（Ns 无响应）：/alpha/billing/credits」并提示可调大 `quotaTimeoutMs`；**不把 undici 的英文原文丢给用户**；
- **旧数据明确标注**：刷新失败但缓存里有数据时，打「⚠️ 本次刷新失败（原因），以上为 X 时刻的旧数据」；
- **显示刷新时间**：绝对时刻 + 本次耗时，便于判断新鲜度；
- **`null` 不当 0**：服务端未返回额度数字时提示「服务端没有返回额度数字（可能是新套餐，或该套餐不按额度计费）」，而不是显示 `$0.00`；
- **窗口超限显式提示**：`exceeded` 为真时标红。

---

## 7. 时序图

```
用户按 [3]
   │
   ├─ 有缓存且 <30s 且非强制刷新？ ──是──▶ 直接渲染（标注"Ns 前的缓存"）
   │
   └─否─▶ 并行发起：
            ├─ GET /alpha/whoami ─────────────────────┐
            ├─ GET /alpha/billing/credits?orgId=       │  Promise.allSettled
            └─ GET /alpha/billing/subscriptions?orgId= ┘
                        │
                        ├─ credits 失败？ ─▶ 重试一次（仅非 4xx）；仍失败则整体报错
                        │
                        ├─ 首次发现 orgId？ ─▶ 用 orgId 重新取 credits + subscriptions
                        │
                        └─ GET /alpha/usage/summary?orgId=&since=<周期起点>
                                    │
                                    ▼
                          projectQuota() 归一化计算
                                    │
                                    ▼
                          renderWindowLimits() + renderCycleMeter()
                                    │
                                    ▼
                              终端输出 + 写入 30s 缓存
```

---

## 8. 自己验证

```bash
# 看原始返回（只读，不消耗额度）
curl -H "Authorization: Bearer <你的key>" https://api.commandcode.ai/alpha/billing/credits

# 跑代理，按 3 看渲染结果
node proxy.mjs

# 相关回归测试（mock 覆盖四个端点、401、超时、部分失败）
npm run test:tui
```

测试覆盖的场景（`test/tui-smoke.mjs`）：

| 场景 | 断言要点 |
|------|----------|
| B2 正常 | 套餐解析、`windowLimits` 顶层取值、5小时/每周/每月进度条、倒计时、`orgId` 与 `since` 参数、刷新时间 |
| C 401 | 如实报错，**且输出中不出现任何编造的额度数字** |
| C2 超时 | 出现中文超时提示、指出端点、给出 `quotaTimeoutMs` 建议，不出现英文原文 |
| C3 部分失败 | 余额仍显示，`5小时/每周` 正常，缺失项列入「部分数据未取到」，不显示空周期行 |

---

## 9. 免责声明

- 额度数据全部来自 Command Code 官方接口，**只读 GET**，不消耗额度、不修改任何服务端状态；
- 协议结构来自对**本地已安装 CLI** 的静态分析（读取其打包产物中的字符串常量），未对服务端做任何未授权访问、破解或篡改；
- 接口与字段可能随官方更新而变化。代码对未知字段做了容错，并在拿不到数据时如实报错而非伪造数值。
