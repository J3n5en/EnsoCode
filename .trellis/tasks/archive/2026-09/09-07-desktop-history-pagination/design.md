# Design

## 行为差距

现在：冷开只灌尾窗，桌面 Virtuoso 无上滑翻页。  
应该：首屏尾窗；到顶再要 `beforeIndex` 页；尾窗 snapshot 不擦前缀。

## 层

- 切片：`sessionHistoryTail`（纯函数，复用 `takeSnapshotTail` / `sliceHistory` 口径）
- IPC：扩展已有 `agent:parent-history-tail`，可选 `beforeIndex`
- 归并：`reducer.ts` 纯函数（history 页 + snapshot 前缀保留）
- 展示：`buildTimeline` 绝对 key；Virtuoso `firstItemIndex` + `startReached`

## 数据流

```
滚到顶
  → loadOlderHistory(conversationId)
  → electronAPI.agent.readParentHistoryTail({ conversationId, beforeIndex })
  → Main: 校验 id → 推导 sessionFile → projectParentHistoryPage(branch, beforeIndex)
  → applyHistoryPage：仅当 page.base + page.length === historyBaseIndex 时前置
```

`beforeIndex` 省略 = 现有「从末尾取尾窗」（hydrate 不变）。

## Snapshot

`applyAgentEvent` 的 snapshot 改为：

- `snapBase = snapshot.baseIndex ?? 0`
- `localBase = state.historyBaseIndex ?? 0`
- 若 `snapBase > localBase` 且本地权威区已覆盖 `[localBase, snapBase)`：保留该前缀，其后用 snapshot 覆盖，`historyBaseIndex` 仍为 `localBase`
- 否则与现在一样整段替换
- `snapBase === 0` 或缺省：全量，清 `historyBaseIndex`

## Virtuoso

- `firstItemIndex={historyBaseIndex ?? 0}`，prepend 时减小，视口钉住原行
- 行 key = `String(historyBaseIndex + localIndex)`，prepend 后已有行 key 不变
- `startReached` 调 `onStartReached`；在途锁在 store

## 明确不做

- 不一次读全文
- 不改 pair / 手机分页
- 不把正文写入 persist
- 不为看历史 spawn worker
