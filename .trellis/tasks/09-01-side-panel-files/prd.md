# 右侧 Files 面板：树 + 高亮编辑 + 实时刷新

## Goal

在现有右侧 dock 里提供可浏览、可编辑的工作区文件面板：语法高亮、能改、能保存；磁盘被本会话/其他会话/外部改了要跟上。不接 LSP。可把文件丢进当前对话输入框（拖拽优先，右键兜底）。

## Background

- dock 已有 `terminal` / `changes`，菜单 Files 仍 Soon。`SidePanelTabKind` 已含 `'file'`。
- 读盘有 `files.read`（>2MB 或非文件 → null），无通用 write、无 listDir、无 watch。
- 高亮编辑：`@pierre/diffs` 的 `File` + `EditProvider`（`@pierre/diffs/edit`）。树不强制 `@pierre/trees`。
- Composer 已能插 file mention；`DndContext` 已包住 `SidePanel`（`App.tsx`）。`insertComposerMention` 可无拖拽插入。
- EnsoAi 教训：只听本会话 timeline 看不见另一会话；整棵仓库递归 watch 易泄漏；路径对不上 + 不 bump 编辑器内容会一直显示旧稿；`isDirty` 会挡住 reload。

## Requirements

1. **入口**：现有右侧 dock。`+` 解禁 Files；每会话最多一个 `file` 面板（稳定 id `files`）。可与终端、Changes 并存。
2. **布局**：左树右编辑。树根 = 会话 cwd（worktree 优先，否则项目目录）。懒加载子目录；忽略 `node_modules` / `.git` 等与 `fileSearch` 相同的目录。
3. **打开/编辑**：点文件 → `files.read` → pierre `File` + edit。Cmd/Ctrl+S 保存。无 LSP、无补全。
4. **实时**：
   - 本会话 `edit`/`write` 成功 → 已打开且未脏的 tab 静默换成磁盘最新（bump contents/version）。
   - **每个打开文件** 在 main 挂非递归 `fs.watch`；另一会话或外部改同一 path 同样刷新。
   - 脏 tab 不覆盖，提示外部已变，可选重载/留下。
5. **Watch 生命周期**：开 tab 才 watch，关 tab / 卸会话 / 关面板必须 `watchStop`。禁止项目根递归 watch。
6. **拖进输入框**：树/打开文件可拖到 Composer，落成 file mention（相对 cwd 的 path，与 @ 提及一致）。右键「发送到对话」走同一插入口。拖拽做不到就只保留右键，不算失败。
7. **SSH**：同一套 Files UI。list/read/write 走现有 `SshExecutor`（和 agent 同一条连接、远端 cwd）。**不**在远端挂 inotify。实时 = 本会话工具成功必刷 + 对已打开文件短轮询（约 2s，关 tab 即停）。读失败 / 过大仍跳过。

## Acceptance Criteria

- [ ] AC1：可新建唯一 Files 面板；树能展开项目目录并打开文本文件。
- [ ] AC2：编辑后 Cmd/Ctrl+S 写回磁盘；刷新后再打开内容一致。
- [ ] AC3：本会话 agent 改已打开且未脏的文件，编辑器在数秒内变成新内容。
- [ ] AC4：本地：另一会话（同一 cwd）改同一文件，未脏 tab 同样更新。SSH：本会话 agent 改完必刷；另一会话靠打开文件轮询跟上。
- [ ] AC5：关 Files 面板后本地 `fs.watch` 与 SSH 轮询均为 0。
- [ ] AC6：右键「发送到对话」在输入框插入该文件 mention。拖到 Composer 若实现则同样插入。
- [ ] AC7：脏文件被外部修改时不丢本地编辑，有冲突提示。
- [ ] AC8：`pnpm typecheck && pnpm test` 与 biome 通过；路径限制与 watch refcount 有单测。

## Out of Scope

- LSP / 补全 / 调试 / Monaco
- `@pierre/trees`（可用现有列表/折叠；不引入也能交）
- 整仓库递归 watch、文件树实时每一处新建文件都闪
- Files 内再开多个 dock tab（编辑器用面板内页签即可）
- 自动保存写盘；SSH 上递归 watch / 远程 inotify

## Key Decisions

| 项 | 选择 |
|---|---|
| 保存 | 手动 Cmd/Ctrl+S |
| 实时 | 本地：打开文件非递归 watch；SSH：打开文件轮询。都加本会话工具信号 |
| SSH | 浏览+编辑+保存，复用 SshExecutor，不空态 |
| 拖拽 | 复用现有 DndContext；做不到则右键 |
| 树 | 自建懒加载，不绑 pierre/trees |
