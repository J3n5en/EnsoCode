# 右侧 Changes 面板：会话 All / git diff HEAD

## Goal

在现有右侧 dock 面板里用 `@pierre/diffs` 的 `CodeView` 做评审面，让用户边聊天边看文件改动。同一 tab 可切换 **All**（本会话 agent 改过的文件）和 **Git**（相对 `HEAD` 的工作区 diff）。

## Background

- 右侧 `SidePanel` 已是 dockview：终端已实现，新建菜单里 Browser / Files 置灰预留。`SidePanelTabKind` 现为 `'terminal' | 'browser' | 'file'`。
- 聊天 timeline 里 `edit`/`write` 已用 `EditDiff` / `ReadFileView` 做折叠预览（窄栏 `max-h-96` + wrap），不适合当评审面。
- 读盘已有 `files.read`（非文件或 >2MB 返回 null）。没有通用写盘、没有 git IPC。
- Cursor Review Changes 用同一表面切 mode（All / Pending / Diff with Main / PR）。本期只抄 All + 工作区相对 HEAD，不做 Pending/Keep、Diff with Main、PR。

## Requirements

1. **入口在现有右侧面板**。不新开侧栏。`+` 菜单增加可用的 Changes 项；Browser / Files 仍占位。每会话最多一个 `changes` tab，可与终端 tab 并存、分屏。
2. **All | Git 是 tab 内切换**，不是两种 dock kind。默认 All；上次选择按会话记住。
3. **All**：聚合本会话成功的 `edit`/`write`（按 path）。第一次碰到该文件时留下 old 快照，new 为当前磁盘。`git commit` 后 All **仍显示**这次对话改过什么。
4. **Git**：会话工作区（worktree 优先，否则项目目录）上 `git diff HEAD`，并补 **untracked** 新文件。已暂存未提交的也算脏；进入 `HEAD` 后从 Git 列表消失。不按「会话是否碰过」过滤。
5. **渲染**：pierre `CodeView` 多文件 diff；侧栏用可滚动、可 split，不要聊天窄栏那套 wrap。语法高亮复用现有 `CODE_THEME` / `ensureHighlighter`。
6. **自动打开**：设置项「有文件改动时打开 Changes」，默认开。开启时，**当前会话新完成**的 `edit`/`write`（不是打开旧会话回放）会展开侧栏、确保有 Changes tab 并聚焦、切到 All。关闭则只靠菜单或聊天「在侧栏打开」。
7. **聊天**：折叠 diff 保留。可从 `edit`/`write` 行打开/聚焦 Changes 并滚到该文件。
8. **关 tab**：只回收 Changes 自身；不得调用 `terminal.dispose`。Tab 图标按 kind 区分。
9. **降级**：非 git 仓库、SSH 远端、读失败、二进制/过大文件 → 该 mode 空态或跳过该文件，不崩。手机端无本机 fs 时 Git 空态，All 能还原则片段 diff，否则跳过。

## Acceptance Criteria

- [ ] AC1：`+` 可新建 Changes；每会话只有一个；与终端可同时存在。
- [ ] AC2：All / Git 可切换；刷新或切走再回来，该会话仍是上次 mode。
- [ ] AC3：同一文件多次 edit 在 All 里合成一条；commit 后 All 仍在，Git 中已进 HEAD 的项消失。
- [ ] AC4：Git 含已暂存改动和 untracked；不含仅存在于已提交历史、工作区已干净的文件。
- [ ] AC5：设置默认开；agent 新完成一次 edit 会打开侧栏并聚焦 Changes（All）。关掉设置后不再自动开。
- [ ] AC6：打开旧会话（历史里已有 edit）不会仅仅因为回放时间线而自动打开。
- [ ] AC7：关 Changes tab 不影响终端 pty；关终端不影响 Changes。
- [ ] AC8：无仓库 / SSH / 读失败时对应 mode 空态可读，应用不抛错。
- [ ] AC9：`pnpm typecheck && pnpm test` 与 `biome check` 通过；All 聚合与 git 解析有单测。

## Out of Scope

- Pending / Keep / Undo、Diff with Main、PR review、Bugbot
- 文件树、侧栏内编辑/保存、Files/Browser kind
- 把聊天折叠 diff 换成侧栏（摘要留在时间线）
- 远程 SSH 上跑 git、对未跟踪目录做完整树 diff

## Key Decisions

| 决策 | 选择 |
|---|---|
| 挂载 | 现有右侧 dock，kind `changes` |
| All | 会话累积 + 首次 old 快照，commit 不清空 |
| Git | `diff HEAD` + untracked，整棵工作区 |
| 自动打开 | 设置开关，默认开；仅新完成的写文件工具 |
| 未跟踪 | Git 要包含，否则 `write` 新文件看不见 |
