# PRD：升级 pi-cursor 到 1.4.31

## 问题

Enso 锁在 `@rahularya01/pi-cursor@1.4.30`，并靠 pnpm patch 在 `yi` / `ig` 入口挂 `__ensoCursorHandleInteraction` / `__ensoCursorHandleExec`。上游 1.4.31 已发布（2026-09-04），含原生工具同流执行、历史重建、错误分类与 checkpoint 修复。裸升会丢掉 hook。

## 目标

1. 依赖升到 `1.4.31`。
2. 补丁重打到 `patches/@rahularya01__pi-cursor@1.4.31.patch`，两处 hook 语义不变：有会话桥才接管，否则走上游。
3. `src/agent/cursor/**` 现有测试保持绿。

## 非目标

- 不改 Enso 会话桥 / 审批语义（web/fetch 仍按现有 `interactionQuery`）。
- 不把 1.4.31 的 in-process HTTP/2 替换现有 spawn 包装（保留兼容）。
