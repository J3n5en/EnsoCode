# Implement

## 1. jsonl 分页（纯函数）

- `projectParentHistoryPage(branch, beforeIndex)`：投影后按 `sliceHistory` 取 `beforeIndex` 之前一页
- `projectParentHistoryTail` 保持「从末尾取」，内部可复用同一投影
- 测：短历史、80 条取 `beforeIndex=20`、空页、不扫整卷投影

## 2. IPC

- 通道仍 `AGENT_PARENT_HISTORY_TAIL`
- handler 收 `conversationId` + 可选 `beforeIndex`（非有限数字当省略）
- preload：`readParentHistoryTail(conversationId, beforeIndex?)`
- 能力表保持 excluded；注释写明也可按页读

## 3. reducer

- 导出 `applyHistoryPage(state, { baseIndex, messages })`
- 空页 / 接不上 → 原对象
- 接上 → 前置权威区，乐观尾巴仍在末尾，`historyBaseIndex = page.baseIndex`
- snapshot：尾窗保留更早前缀（见 design）；全量仍清 base

## 4. 时间线 key

- `buildTimeline` 接收 `historyBaseIndex`（默认 0），行 key 用绝对下标
- 补 1 例：base=40 时首条 user key 为 `"40"`

## 5. store + UI

- `loadOlderHistory(id)`：`historyBaseIndex > 0`、单飞、调 IPC、`applyHistoryPage`
- `hydrateParentHistoryTail` 仍走无 `beforeIndex`
- `ChatView`：`hasOlder` 时把 `onStartReached` / `firstItemIndex` 传给时间线
- `MessageTimeline` Virtuoso：`firstItemIndex` + `startReached`

## 验证

```
pnpm exec vitest run src/main/services/sessionHistoryTail.test.ts src/renderer/stores/sessions/reducer.test.ts src/renderer/stores/sessions/timeline.test.ts
pnpm typecheck && pnpm test
```

## 回滚

只回本任务提交。分页挂了最坏是滚不到更早（现状）；snapshot 前缀逻辑回退到整表替换即可。
