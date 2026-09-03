# Design

## Modules

```
src/shared/usage/types.ts        跨进程传输类型（下）
src/shared/usage/pricing.ts      ModelPricing / PricingTable / costOf()
src/shared/usage/aggregate.ts    aggregateUsage(records, pricing, opts) → UsageSummary   [pure]
src/shared/usage/format.ts       formatTokens / formatCost / formatDurationMs / formatDelta [pure]
src/main/services/usage/parseSession.ts   parseSessionJsonl(text) → ParsedSession          [pure]
src/main/services/usage/usageService.ts   scan sessionDir + per-file cache + pricing → summary
src/main/ipc/usage.ts            ipcMain.handle(IPC_CHANNELS.USAGE_SUMMARY, ...)
src/preload/index.ts             electronAPI.usage.summary({ days })
src/renderer/components/settings/UsageSettings.tsx (+ usage/ 子组件)
```

## Contracts

```ts
// shared/usage/types.ts
export const USAGE_RANGE_DAYS = [1, 7, 30, 90] as const;
export type UsageRangeDays = (typeof USAGE_RANGE_DAYS)[number];

export interface UsageRecord {
  /** assistant 消息时间戳（ms） */
  ts: number;
  model: string;
  provider: string;
  project: string;       // cwd basename；缺失为 ''
  sessionId: string;
  input: number;         // 未命中输入
  output: number;        // 含 reasoning
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface UsageTotals {
  /** 有定价模型的费用之和；一条也定价不到时为 null */
  cost: number | null;
  input: number; output: number; cacheRead: number; cacheWrite: number;
  /** input + output + cacheRead + cacheWrite */
  tokens: number;
  sessions: number;
  messages: number;      // assistant 消息数（记录数）
  activeMs: number;
}

export interface UsageDailyPoint { day: string /* YYYY-MM-DD 本地 */; input: number; output: number; cache: number /* cacheRead+cacheWrite */; cost: number | null }
export interface UsageModelRow   { model: string; cost: number | null; tokens: number; messages: number; share: number /* tokens 占比 0..1 */ }
export interface UsageProjectRow { project: string; cost: number | null; tokens: number; sessions: number }

export interface UsageSummary {
  days: UsageRangeDays;
  rangeStart: number; rangeEnd: number;   // ms，[start, end)
  totals: UsageTotals;
  previous: UsageTotals;                  // 紧邻的上一个等长周期
  daily: UsageDailyPoint[];               // 恰好 days 个点，升序，无数据日补零
  /** 7×24，[weekday(0=周日)][hour]，值为 tokens */
  heatmap: number[][];
  byModel: UsageModelRow[];               // tokens 降序
  byProject: UsageProjectRow[];           // tokens 降序
  unpricedModels: string[];               // 出现过但无定价的模型 id
}

export interface UsageSummaryResult { ok: true; summary: UsageSummary } | { ok: false; error: string }
```

```ts
// shared/usage/pricing.ts —— $/M tokens，与 pi-ai ModelCostRates 同形
export interface ModelPricing { input: number; output: number; cacheRead: number; cacheWrite: number }
export type PricingTable = Record<string, ModelPricing>;     // key = model id
/** 无定价返回 null；四项按 tokens/1e6 × 单价求和 */
export function costOf(record: Pick<UsageRecord,'model'|'input'|'output'|'cacheRead'|'cacheWrite'>, table: PricingTable): number | null
```

```ts
// shared/usage/aggregate.ts
export interface AggregateOptions { days: UsageRangeDays; now: number /* ms */ }
/** 会话活跃时长按 sessionId 给出（由 parser 算好），聚合只做求和 */
export interface SessionActivity { sessionId: string; activeMs: number }
export function aggregateUsage(records: UsageRecord[], activity: SessionActivity[], pricing: PricingTable, opts: AggregateOptions): UsageSummary
```
规则：
- 周期：`rangeEnd = 本地今天 00:00 + 24h`，`rangeStart = rangeEnd − days×24h`；previous = 再往前一段。日边界按本地时区。
- `days === 1` 表示「今天」。
- 记录按 `ts` 落桶；ts 不在 [rangeStart, rangeEnd) 的忽略。
- `totals.cost`：所有能定价记录之和；若周期内**没有任何**可定价记录则 `null`（区别于 $0）。
- `sessions` = 周期内出现过的 distinct sessionId；activeMs 只加周期内出现过的 session。
- `byModel.share` = 该模型 tokens / totals.tokens（totals.tokens 为 0 时 share=0）。
- daily/heatmap/byModel/byProject 均只用当前周期。

```ts
// shared/usage/format.ts
formatTokens(3_100_000_000) → '3.1B'；1_500_000 → '1.5M'；240_000 → '240K'；999 → '999'；0 → '0'
formatCost(null) → '—'；1911.876 → '$1911.88'；0.004 → '$0.00'
formatDurationMs(0) → '0m'；35_460_000 → '9h 51m'；4_654_740_000 → '1292h 59m'；<60s → '0m'
formatDelta(prev, cur)：prev>0 → '+86.4%' / '-36.9%'（一位小数，带号）；prev===0 && cur>0 → 'new'；两者皆 0 或任一为 null → null
```

```ts
// main/services/usage/parseSession.ts
export interface ParsedSession { sessionId: string; project: string; records: UsageRecord[]; activeMs: number; userMessages: number }
export function parseSessionJsonl(text: string): ParsedSession | null   // 无 session 头 → null
```
规则：
- 逐行 `JSON.parse`，坏行跳过；`type:'session'` 取 `id`、`cwd`（project = basename，`/`与`\`都切）。
- `type:'message'`：`message.role==='assistant'` 且 `message.usage` 为对象 → 产出记录；
  非数值字段按 0；`ts` 优先 `message.timestamp`（数字 ms），否则 `Date.parse(entry.timestamp)`，都无则跳过。
  model = `message.model` 字串，否则 `'unknown'`；provider = `message.provider` 字串否则 `''`。
- 同一 `entry.id` 重复出现取最后一条（覆盖）。
- activeMs：按时间顺序，user 消息开启一轮（记 start），其后 assistant/toolResult 消息更新 end；
  下一条 user 或文件结束时 `activeMs += end − start`（end 存在时）。单轮跨度超过 6h 视为异常，按 6h 截断。

## Pricing source (main)

`getPricingTable()`：`getRuntime()`（`oauthProviders.ts` 已有）→ `runtime.getModels()` 全量 →
按 `model.id` 建表，同 id 多 provider 时取**四项单价均非零**者优先、否则第一条；
任一步失败返回 `{}`（UI 显示未定价，不阻塞）。结果进程内 memo。

## Caching (main)

`Map<filePath, { mtimeMs, size, parsed }>`；每次 summary 请求 `readdirSync` 一遍，
mtime/size 不变直接复用；文件消失则删缓存。59MB/252 文件全量解析 < 1s，可接受。

## UI

设置分类 `usage`（icon `BarChart3`，label `Usage`）。布局自上而下：
1. 标题行 + 周期 pills（Today / 7D / 30D / 90D），右侧刷新按钮。
2. 8 张统计卡（4 列 × 2 行）：数值 + 相对上期 delta 小字。费用绿色、活跃时长蓝色（参考图）。
3. 每日趋势卡：纵向堆叠柱（output 亮 / input 中 / cache 暗），右上 Token|Cost 切换，SVG 手绘。
4. 分时活跃卡：7×24 方块热力图，颜色阶按最大值分 5 档。
5. 按模型 / 按项目两表：名称、费用、Tokens、占比条。
6. 底部提示：未定价模型列表（有则显示）。
