# Design: 右侧 Changes 面板

## Boundaries

- **Renderer**：dock 组件、All/Git 切换、CodeView、自动打开、设置开关。
- **Main**：git 工作区 diff（新 IPC）；读文件继续走现有 `files:read`。
- **Shared**：`SidePanelTabKind` 增加 `'changes'`；IPC 通道名；git 返回类型。
- 不改 agent worker、不改 checkpoint/rewind、不写盘。

## Dock 集成

`src/renderer/components/sidepanel/SidePanel.tsx`

- `DOCK_COMPONENTS` 增加 `changes: ChangesPanel`。
- 稳定 id：`changes`（每会话一个）。已存在则 `api.getPanel('changes')?.focus()`，否则 `addPanel({ id: 'changes', component: 'changes', title })`。
- `NewTabMenu` 增加 Changes；`onNewTerminal` 旁加 `onNewChanges`。
- `SidePanelTab` 按 `props.api.component` 选图标（terminal / changes），不要写死 `SquareTerminal`。
- `onDidRemovePanel`：仅 `panel.api.component === 'terminal'` 时 `releaseTerminal` + `terminal.dispose`。
- 导出 `addSidePanelChanges({ filePath?: string })` 到 `sidePanelDock.ts`，给自动打开和聊天行用。

## All 数据

纯函数（可单测）`aggregateSessionChanges(tools, snapshots, readFile)`：

输入：timeline 里 `state === 'ok'` 的 `edit`/`write`，顺序保留；`summary` 已是项目相对路径（`timeline.ts` `summarizeArgs`）。

按 path：

- 无快照：`edit` 用当前磁盘内容逆序 undo 全部 blocks 得到 old（同 `EditDiff.reconstructOld`）；失败则用第一块 `oldText` 作片段。`write` 的 old 为空串（新文件）或磁盘还原失败时 old 空、new 为 `writeContent`。
- 有快照：old 用快照，new 用 `files.read`（失败则最后一次 write 内容 / 合成后的文本）。
- 快照在 **第一次成功还原 old** 后写入 `sidePanel.snapshots[conversationId][path]`，persist 到现有 `enso-side-panel`。commit 后磁盘变了也不改 old。

路径解析：相对路径相对会话 cwd（worktree / 项目 path），与终端一致。

## Git 数据

新 service `src/main/services/gitDiff.ts`，ipc `src/main/ipc/git.ts`。

通道：`GIT_DIFF_HEAD: 'git:diff-head'`。

入参：`{ cwd: string }`（unknown 收窄）。cwd 必须是目录；SSH 项目 renderer 不调用，直接空态。

出参：`{ ok: true, files: GitDiffFile[] } | { ok: false, error: 'not-repo' | 'unavailable' }`。

`GitDiffFile`：`{ path, status: 'modified' | 'added' | 'deleted' | 'untracked', oldText, newText }`。

实现（cwd 下）：

1. `git rev-parse --is-inside-work-tree`
2. `git diff HEAD --name-status -z`（含已暂存）
3. `git ls-files --others --exclude-standard -z`
4. 内容：`git show HEAD:path` 作 old（added/untracked 无 old）；new 用读文件（deleted 无 new）。单文件沿用 2MB；二进制/`NUL` 跳过。

逻辑在 service，ipc 只校验。Renderer 把 `files` 编成 `CodeViewItem[]`。

刷新：切到 Git、窗口 focus、tab 可见时拉一次；不需要 file watcher（MVP）。

## 渲染

`ChangesView`：顶栏 All | Git（i18n），下面 `CodeView`。

options：`themeType: 'system'`、`CODE_THEME`、`preferredHighlighter: 'shiki-js'`、`disableWorkerPool`、`overflow: 'scroll'`、`diffStyle: 'split'`、`stickyHeaders`。与聊天 `EditDiff` 的 wrap 分开，不要共用会污染窄栏的 options 对象。

空态：All「本会话还没有文件改动」；Git「工作区相对 HEAD 没有改动」/「不是 git 仓库」/「远程项目不支持」。

## 自动打开

设置：`openChangesOnFileEdit: boolean`，`initialState` 默认 `true`。新字段靠 persist merge 缺省，不 bump `SETTINGS_VERSION`。无 `applySettings` 副作用。

UI：`GeneralSettings` 里与 Automatic updates 同款 Switch。

监听：renderer 订阅 sessions timeline，只对 **activeId** 比较「ok 的 edit/write 的 tool key 集合」。新增 key 且设置开 → `addSidePanelChanges()`。会话首次 mount 记下当前集合，避免回放误触发（AC6）。

## 聊天入口

`ToolRow`：`edit`/`write` 成功时多一个「在侧栏打开」，调用 `addSidePanelChanges({ filePath })`。CodeView `scrollTo` 若本期 API 不好用，先聚焦 tab 即可（AC 不强制滚到行）。

## 兼容

| 环境 | All | Git |
|---|---|---|
| 本地 git | 快照 + 读盘 | diff HEAD + untracked |
| 本地非 git | 同上 | `not-repo` 空态 |
| SSH | 读盘失败则片段/跳过 | 不调用 IPC |
| 手机 shim | `files.read` → null | 不调用或失败空态 |

## Tradeoffs

- All 快照在 renderer persist，不进会话 jsonl：重启应用仍在 localStorage；清站点数据会丢 old，All 再走 reconstruct（commit 后可能失败，该文件降级或消失）。可接受。
- Git 不做 watch：commit 后需再点 Git 或重新聚焦才刷新。
- 不复用 `kind: 'file'`，避免以后打开文件撞车。

## Rollback

去掉 `changes` 组件后，旧 layout JSON 里的 `changes` panel `fromJSON` 会失败；现有代码已 catch 后空态。设置多一个无副作用 boolean，可留着。
