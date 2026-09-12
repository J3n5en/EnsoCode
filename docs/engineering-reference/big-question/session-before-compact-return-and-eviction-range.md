# session_before_compact 返回值语义与真实驱逐区间

## 症状

持续记忆（continuous-memory）压缩钩子单测全绿，真机上却出现两类事故：

1. 长会话自动压缩失败，或 overflow 那一轮直接报错结束；jsonl 里没有 `compaction` 条目，
   或者有但 `details` 不是 `om.folded`（走了 pi 原生整段摘要）。
2. 第二次及以后的 memory 压缩静默丢掉更早的历史：smart→memory#1 还带着旧摘要，
   memory#1→memory#2 之后旧内容从 summary 里消失；或切在 turn 中间时，被驱逐的
   turn 前缀没有任何观察覆盖，模型 recall 必 `not_found`。

## 根因

### ① `session_before_compact` 三种返回值的真实后果

| 返回 | pi 实际行为 |
|------|-------------|
| `undefined` | 钩子让位，pi 用 **原生整段单次摘要** 兜底；长会话几乎必撞 token limit |
| `{ cancel: true }` | **本次压缩根本没发生**；`reason:"overflow"` 下该轮直接失败 |
| `{ compaction }` | 唯一正常出口 |

早期实现把「覆盖不全」「摘要过大」「内部异常」都当成 `return undefined` 或 `cancel`，
单测只断言"没返回 compaction"，看不出两者在真机上的差别。

### ② 真实驱逐区间 ≠ `messagesToSummarize`

pi 的 `prepareCompaction` 会在 turn 中间切（`isSplitTurn`），被驱逐的是
`messagesToSummarize ∪ turnPrefixMessages`；而 `[0, 上一条 compaction.firstKeptEntryId)`
早已不在上下文里，只活在 `preparation.previousSummary` 文本中。所以：

- 覆盖判定的分母必须是 branch 上 `[上一条 compaction 的 firstKeptEntryId, 本次 firstKeptEntryId)`
  内的全部来源条目（自然包含 turn 前缀），而不是只看 `messagesToSummarize`。
- `[0, boundaryStart)` 的历史只能靠前向携带 `previousSummary`；若仅在"分支上没有 memory
  compaction"时才携带，memory#2 起就丢。

## 修法（`src/agent/continuousMemory/extension.ts`）

1. 返回值：用户 abort → `undefined`；覆盖不全 / body 超预算 / 内部异常 → 交
   `createEnsoCompactFallback`（返回 `{compaction}`）；只有 fallback 自身抛错才 `{cancel:true}`。
2. `compactionBoundaryStart()`：起点取上一条 compaction 的 `firstKeptEntryId`（找不到则退到
   compaction 之后）；`continuousMemoryProjection()` 要求该区间内每个来源条目都被观察覆盖
   或早于 `coveredThroughEntryId`。
3. `carriedPriorSummary()`：上一压缩为 memory 就沿用其 `details.priorSummary`（常数、不嵌套）；
   否则把 `previousSummary` 截到 `PRIOR_SUMMARY_MAX_TOKENS` 写入 `details.priorSummary`，
   渲染时前置 `## Prior compacted history`。
4. 压实用 `CARRIED_BOUNDARY_ID` 合成边界观察，渲染为 `[carried boundary]` 不带 id，
   recall 工具对它返回明确说明，不引导模型去 recall 一个不在 ledger 的 id。

## 回归防线

`src/agent/continuousMemory/extension.test.ts`：

- 「失败象限」：覆盖不全 + `reason:'overflow'` → `{compaction}` 且 `previousSummary` 保留；
  abort → `undefined`；内部异常自 catch。
- 「smart→memory→memory→memory」：每轮 summary 恰含一次旧史、前史段长度恒定、`details.priorSummary` 常量。
- 「split-turn」：切点前 turn 前缀未覆盖则拒绝 memory 投影，覆盖后接受。
- 「连续多轮超限」：3 轮都走 memory 路径、summary ≤ 上限、含 `[carried boundary]`。

真机：两家厂商（google-antigravity / xai）跑通 observer → ledger → `/compact` → 模型自主
`enso_memory_recall`；期间还发现 thinking 部分混入 JSON 抽取、`stopReason:'error'` 被当空回复
两处缺陷，见 `runtime.test.ts`。

## 相关代码

- `src/agent/continuousMemory/extension.ts`：`compactionBoundaryStart` / `continuousMemoryProjection` / `carriedPriorSummary` / `session_before_compact`
- `src/agent/continuousMemory/session-ledger/projection.ts`：relevance top-N 压实与 `CARRIED_BOUNDARY_ID`
- `src/agent/ensoCompact/extension.ts`：fallback 返回语义（另见 [enso-compact-token-limit-fallback.md](enso-compact-token-limit-fallback.md)）
- pi：`dist/core/compaction/compaction.js` `prepareCompaction`（`turnPrefixMessages` / `isSplitTurn`）
