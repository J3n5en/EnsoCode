# 实现切片

## 切片 1 — 尾窗纯函数 + parser
- 抽出 `takeSnapshotTail`（60 条 / 600KB），pairPolicy 复用
- `parseSessionSnapshot` 允许 `baseIndex`（非负整数）

## 切片 2 — reducer
- snapshot 带 `baseIndex>0`：写入尾窗，记下 `historyBaseIndex`
- snapshot 无/0：整段替换，清 `historyBaseIndex`
- `message-upsert` 用 `index - historyBaseIndex`；小于 0 丢正文

## 切片 3 — worker
- `registerManagedSession` resume：先投影并 emit 尾窗 snapshot（赶在 status 前），再全量投影 + 全量 snapshot
- `managed.messages` 始终是全量（upsert 下标不变）
