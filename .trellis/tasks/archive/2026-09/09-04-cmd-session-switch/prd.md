# Cmd hold session switch hints

## Goal

按住 `mod`（Mac ⌘ / 其它平台 Ctrl）时，侧栏可见会话行右侧显示 `⌘1`… 槽位；按 `mod+1`…`mod+9` 切到对应会话。

## Background

侧栏栏目是 Pinned → 各项目会话 → Archived（`Sidebar.tsx`），没有独立「最近会话」区。项目默认最多露出 5 条（`COLLAPSED_SESSION_LIMIT`）；置顶会话会同时出现在 Pinned 和项目列表。全局快捷键在 `keybindings.ts` + `App.tsx`，`eventToBinding` 忽略纯修饰键，目前没有 `mod+1`…`9`。

## Requirements

- R1. 按住 `mod` 且未按 Shift/Alt 时，已分配槽位的可见会话行右侧把相对时间换成 `formatBinding('mod+N')`（Mac `⌘1`，其它平台 `Ctrl+1`）。松开、失焦或按下其它修饰键后恢复。
- R2. `mod+1`…`mod+9` 切到该槽位会话；空槽位不改变当前会话。侧栏折叠时不画提示，但按同一槽位表切换。
- R3. 点会话行仍走现有 `onSelect`；提示不是独立热区。按住 `mod` 时右侧提示优先于 hover 的置顶/归档按钮。
- R4. 槽位顺序与侧栏当前可见行一致：Pinned → 每个**未折起**项目里正在展示的会话（受搜索过滤、`COLLAPSED_SESSION_LIMIT` / 「Show more」影响）。Archived、折起项目、被「Show more」藏住的行不进槽位。
- R5. 同一 `conversationId` 只占第一次出现的槽位（Pinned 优先）；项目列表里的重复行不显示数字。上限 9。
- R6. 远程节点态（`activeNodeId !== 'local'`）不响应这组切换，与现有本机会话快捷键一致。Composer / 查找聚焦时 `mod+数字` 仍切会话并 `preventDefault`。

## Out of scope

- 不新增「最近会话」栏目；不改 Archived。
- 槽位不进设置页改绑；不做 `mod+0`。
- 不切 coworker 子标签（仍用现有 tab 快捷键）。
- 不改手机端 SessionDrawer、远程节点侧栏。
- 按住 `mod` 时不自动展开折起的项目。

## Decisions

- D1. 覆盖 Pinned + 所有已展开项目的可见行，不是只编当前项目。
- D2. 置顶重复行只编第一次出现。

## Acceptance Criteria

- [ ] AC1. 按住 `mod` 时，按 R4/R5 分配的可见行右侧显示 `⌘1`/`Ctrl+1` 起的提示，最多 9 条；重复出现的同一会话只在首次显示。
- [ ] AC2. 松开 `mod`、窗口失焦后提示消失，相对时间恢复。
- [ ] AC3. `mod+N` 有会话则切过去，空槽位保持当前会话；侧栏折叠时键盘仍按同一顺序工作。
- [ ] AC4. 折起项目、「Show more」隐藏行、Archived 不占槽位；展开「Show more」或搜索过滤后槽位跟随新的可见列表。
- [ ] AC5. 远程节点态 `mod+数字` 不切本机会话。
- [ ] AC6. Composer 聚焦时 `mod+数字` 切会话，不插入字符。
