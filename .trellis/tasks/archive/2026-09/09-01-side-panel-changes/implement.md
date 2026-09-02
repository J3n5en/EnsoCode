# Implement: 右侧 Changes 面板

## TDD

先测再写（纯函数）：

1. `aggregateSessionChanges`：多 edit 合成、write 新文件、快照优先于磁盘、reconstruct 失败降级。
2. `gitDiff` service：name-status + untracked 编文件列表；非仓库错误；超大/二进制跳过（可用假 `git`/`read` 注入，对齐 checkpoint host 风格）。

UI / dock / 设置不强制单测，靠 typecheck + 真机。

## Order

1. Shared：`SidePanelTabKind` 加 `'changes'`；`IPC_CHANNELS.GIT_DIFF_HEAD` + `GitDiffFile` 类型。
2. Main：`services/gitDiff.ts` + 测试 → `ipc/git.ts` 注册 → preload。
3. All 聚合纯函数 + 测试（可放 `src/renderer/lib/sessionChanges.ts`，不依赖 React）。
4. `ChangesView` + CodeView；`SidePanel` 注册组件、菜单、图标、关 tab 分流。
5. `sidePanelDock.addSidePanelChanges`；store：`snapshots`、`changesModeByConversation`。
6. 设置 `openChangesOnFileEdit` + GeneralSettings + i18n。
7. 自动打开监听（active 会话新 tool key）。
8. 聊天 ToolRow「在侧栏打开」。
9. `pnpm typecheck && pnpm test`、`biome check`。

## Validate

```bash
pnpm test
pnpm typecheck
pnpm exec biome check .
```

真机：本地 git 会话 edit → 自动开 All；commit 后 All 还在、切 Git 应空（若工作区干净）；`git add` 未 commit 时 Git 仍能看到；菜单再开 Changes 不重复 tab；关 Changes 终端还在。

## Risky files

- `SidePanel.tsx`：`onDidRemovePanel` 误杀 pty。
- `stores/sidePanel` persist migrate：已有 `version: 2` 清过旧 tabs；加字段保持 merge，不要再清空 `layouts`。
- `ipc/agent.ts` 里已有 `FILES_READ`，git **不要**再塞进 agent；走独立 `ipc/git.ts`。
- CodeView options 不要和 `EditDiff` 共用（wrap vs scroll）。

## Rollback

revert 本任务提交即可。残留 layout 里的 `changes` 面板会被 `fromJSON` catch 掉。
