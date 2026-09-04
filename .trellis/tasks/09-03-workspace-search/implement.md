# 工作区搜索 — 实施

## 改动边界

- 要做：shared 检索纯函数 + 测试；Main 冷索引 + IPC + preload；`mod+k` Dialog；快捷键清单。
- 不做：Inspector / Fork / MEMORY、向量、jsonl 手扫。

## TDD

检索排序跨用例多，用 coworker 角色分离：

1. 测试先行者：只读本目录 PRD/design，写 `src/shared/workspaceSearch.test.ts`，确认红灯。
2. 实现者：只改 `workspaceSearch.ts`（及必要的 types export），不许改测试讨绿。
3. 冷索引 / IPC / UI 主会话做；IPC 脏输入单测 inline。

## Checklist

1. Red：`workspaceSearch` 失败测试（排序、CJK/拉丁、标点、scope、草稿排除、当前标记、上限 50、snippet 160、nearby）。
2. Green：实现纯函数。
3. Main `workspaceSearchIndex`：registry ∩ `SessionManager.list`；无匹配路径不读盘。
4. IPC 三点式：`IPC_CHANNELS` + `main/ipc` + preload；入参 unknown。
5. 快捷键：`keybindings.ts` + `capabilityGateway` DEFAULT + `App.tsx`（远程屏蔽）。
6. UI：`WorkspaceSearchDialog` 复用 `command.tsx`；空查询最近会话；选中跳转；正文命中预填 ChatFindBar。
7. i18n：可见英文 key 补中文。
8. `pnpm typecheck && pnpm test`；`biome check`。

## 验证

```bash
pnpm exec vitest run src/shared/workspaceSearch.test.ts
pnpm typecheck && pnpm test
```

## 回滚

删本项新增文件与三点式通道即可；不改权威源。
