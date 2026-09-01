# Implement: 右侧 Files 面板

## TDD

1. `resolveUnderCwd(cwd, rel)`：拒绝 `..`、绝对路径逃出、正确 join。
2. watch 表：refcount、stop 到 0 才 close、按 conversation 批量停。
3. `routeDrop` 增加 workspace-file → insert-file-mention。

## Order

1. Shared 类型 + IPC 常量。
2. Main `filesWorkspace.ts`（resolve/list/write/watch）+ 测试 → IPC → preload。SSH 分支复用 `SshExecutor`，与本地同一组通道。
3. `FileTree` 懒加载；`FilesView` 打开/编辑/保存。
4. SidePanel 注册 `files`、菜单解禁、关面板停 watch。
5. 工具成功刷新 + watch 事件 bump。
6. 右键发送到对话；再试 dnd（失败可关）。
7. i18n、capability fixture。
8. `pnpm typecheck && pnpm test`、biome。

## Validate

```bash
pnpm test
pnpm typecheck
pnpm exec biome check .
```

真机：打开文件、保存、本会话 agent 改同一文件、第二个会话改同一文件、关面板后确认无残留 watch（可打日志计数）。拖或右键进 Composer。

## Risky

- dockview 与 dnd-kit 抢 drag：右键是保底。
- 自己 write 触发 watch 重置光标：写后内容相等则不 bump。
- 关 tab 漏 stop → 泄漏；停 watch 必须走同一函数。
- 不要把任意 abs 交给 write/watch。

## Rollback

revert 本任务提交。残留 `files` dock 面板 fromJSON catch。
