# 桌面冷开上滑加载更早历史

## Goal

冷开长会话只先上屏尾窗；往上滚到顶再按页从 jsonl 补更早消息。不 spawn worker，也不一次灌全文。

## Background

点开未启动的历史会话时，桌面只走 `hydrateParentHistoryTail`（最后 60 条 / 600KB）。`requestSnapshot` 在 worker 未 spawn 时补不回全文。桌面时间线没有手机那种 `history` 分页，滚到尾窗第一屏就停。

真机：`87db8cf8-9144-4dba-8219-37123cbeccec` 的 jsonl 有 252 条，UI 停在「探索了 4 个文件」+「spawn 只传 projectId」。

发一条消息才会 `resumeConversation` → `deferFull`，只看历史走不到。

## Requirements

1. 冷开首屏仍只取尾窗，行为与现在一致。
2. 桌面滚到时间线顶部且还有更早消息时，按与手机相同的条数/字节预算再取一页（`beforeIndex` = 当前 `historyBaseIndex`）。
3. 分页只读已登记的父会话 jsonl，不 spawn、不改会话状态/审批。
4. 新页接到现有权威区前面；空页或接不上则不改视图。
5. 之后到达的尾窗 snapshot 必须保留已加载的更早前缀；全量 snapshot（无 / 0 `baseIndex`）仍整表替换并清 `historyBaseIndex`。
6. 虚拟列表 prepend 后视口不跳到顶，已渲染行的 key 用绝对下标。
7. 已滚到 jsonl 第 0 条后不再请求。

## Constraints

- 路径仍由 Main 从已登记 `sessionFile` 推导，渲染层只传 `conversationId` + 可选 `beforeIndex`。
- 正文不持久化（现有 partialize 不变）。
- 不改手机 pair 协议，不改 resume / `deferFull`。
- 不为了看历史自动 resume。

## Acceptance Criteria

- [x] TDD：jsonl 按 `beforeIndex` 切片、桌面 history 合并、尾窗 snapshot 保留前缀；先红后绿
- [ ] 冷开会话滚到顶能继续出更早消息，直到第 0 条（待真机）
- [x] 上滑过程中发消息 / resume 全量到达后，已加载前缀不丢；全量到达后不再分页（reducer 覆盖）
- [x] 相关单测通过；全量 `pnpm test` 3 个无关超时复跑即绿

## Notes

- 手机参考：`applyGuestHistory` / `sliceHistory` / `ChatScreen.onStartReached`
- 桌面消息是从 `historyBaseIndex` 起的稠密数组，不是手机的稀疏 Map
