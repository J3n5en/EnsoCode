# Search Anything — 实施

## 顺序

1. **Red（shared）**：设置目录匹配、浏览器 tab 合并/去重/最近 N 条。确认因缺实现失败。
2. **Green（shared）**：最小匹配/合并实现。
3. **Main / IPC**：`browserHost.listSearchableTabs`；`WINDOW_OPEN_SETTINGS` 可选深链；preload 类型。脏 IPC 单测。
4. **设置窗**：`SettingsContent` 收深链；各可搜行加 `data-settings-row`；闪烁样式。
5. **Dialog**：分组 UI、空查询最近标签、三类跳转。会话检索调用保持原样。
6. **验证**：`pnpm typecheck && pnpm test`；`biome check`；手测 `mod+k` 三类跳转。

## 验证

```bash
pnpm typecheck && pnpm test
pnpm exec biome check src/shared src/main/ipc src/renderer/components/search src/renderer/components/settings
```

## 风险 / 回滚

- 设置目录与页面行不同步 → 目录和 `data-settings-row` 同一批改；漏 id 则该行不可搜。
- persist key 是 tabId，`conversationId` 字段才是会话 → 跳转用 `conversationId`，不要把 persist map key 当会话 id。
- 设置窗与主窗不是同一 renderer → 深链必须走 Main，不能只 setState 主窗。
- 回滚：还原 Dialog / IPC / `data-settings-row`；会话冷索引可不动。

## start 前

- 复杂任务：`prd.md` + `design.md` + `implement.md` 已齐。
- 等用户批准本规划摘要后再 `task.py start`。
