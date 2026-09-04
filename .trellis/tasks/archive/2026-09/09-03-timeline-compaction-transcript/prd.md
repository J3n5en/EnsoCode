# timeline-compaction-transcript

## Goal

长会话 resume 后能滚到真正的第一条消息；compaction 在时间线上可见。

## Background

用户反馈「长会话滚不到最上方」。真机验证：jsonl 有 1254 条消息、6 次 compaction 的会话，
resume 后渲染层只拿到 160 条。

根因：`supervisor.ts` 用 `session.messages` 作为渲染层消息源，而它是 pi 的 **LLM 上下文视图**
（`buildContextEntries` 遇到 compaction 只保留 summary + `firstKeptEntryId` 起的条目 + 之后的条目）。
resume、rewind、`agent_end` reconcile 都走这条路，所以：

- resume 直接丢掉 compaction 之前的全部历史；
- 运行中自动压缩后，下一次 `agent_end` 的 reconcile 会把列表按 index 覆盖并 `messages-truncated`，
  表现为「聊着聊着历史突然消失」；
- `compactionSummary` 消息在 `buildTimeline` 里被静默丢弃，用户毫无感知。

## Solution

- `src/agent/transcript.ts` `transcriptMessages(sessionManager, contextMessages)`：
  从 `getBranch()` 取 compaction 之前（`firstKeptEntryId` 之前）的条目，经
  `sessionEntryToContextMessages` 映射后拼在 context 前面。更早的 compaction 自然变成
  `compactionSummary` 消息留在原位；后半段沿用 context 本身，保证与运行中
  `message_start/update` 的下标对齐。
- supervisor：resume / rewind / `agent_end` 改用 `transcript()`；新增 `compaction_end`
  reconcile（自动压缩在 agent_end 之后异步完成）。
- projection：`compactionSummary.summary` → text part，透出 `tokensBefore`。
- 渲染：新 `compaction` 时间线行，分隔线「上下文已压缩（压缩前 N tokens）」，点击展开摘要。

## Acceptance Criteria

- [x] TDD：transcript 4 例 / projection 1 例 / timeline 2 例先红后绿；全量 `pnpm test` 通过
- [x] 真机：该会话回放 1258 条（含 6 个摘要行），滚到顶为第 0 条 user 消息
- [x] compaction 行可见、可展开摘要

## Notes

- 复现材料：生产会话 `2026-09-02T10-06-40-302Z_01a06195…jsonl` 复制到 dev，需同时写
  `source-registry.json` 与 `settings.json` 的 `enso-conversations`；`lastProviderId`
  必须是 dev 里存在的 provider，否则 `resumeConversation` fail-closed 静默不 spawn（空白页、无提示）——
  这本身是个独立的小问题，未处理。
- 已知代价：`agent_end` 每次对整段 transcript 做 JSON 比较；万条量级若卡顿，只比较 context 段即可。
- Virtuoso 「动态测高卡顶」假设未证实；修复后未复现。

## Commits

- 7d4b48d fix(agent): resume/reconcile from full transcript so compaction no longer drops history
- fca2334 feat(chat): render compaction summary as a divider row in the timeline
