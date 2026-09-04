# Design: Cmd session switch slots

## Boundary

只动渲染层。不新增 IPC、settings 字段、持久化。槽位是侧栏当前可见顺序的派生值。

## Slot list（可单测）

新增纯函数（与 `pinned.ts` 同目录，例如 `sessionSwitchSlots.ts`）：

输入：会话 `order` / `conversations`、`pinnedOrderIds`、项目顺序、`collapsedProjects`、`expandedProjects`、`listQuery`、折叠上限。

输出：最多 9 个去重后的 `conversationId`。

规则与 `Sidebar` 渲染对齐：

1. `pinnedConversationIds` 过滤搜索命中 → 先入列
2. 按项目顺序：折起则跳过会话；否则取 `projectConversationIds` 的可见切片（搜索中项目强制展开；未点「Show more」时 `slice(0, COLLAPSED_SESSION_LIMIT)`）
3. 已出现过的 id 跳过
4. 忽略 archived
5. `slice(0, 9)`

键盘与提示必须调用同一函数，禁止在 JSX 里另算一遍。

## Modifier + 数字

状态留在 `Sidebar`（折起/搜索/展开都在这里），不塞进 sessions store，也不改 `App.tsx` 动作表。

- `modHeld`：keydown/keyup 监听 Meta（Mac）或 Control（其它平台）；`blur` / `visibilitychange` 清掉，避免 ⌘-Tab 后提示卡住。
- Shift/Alt 按下时不当作速切模式（不画提示、不切会话）。
- `mod+Digit1`…`Digit9`：`preventDefault` + `selectConversation(slots[n-1])`。
- 远程节点：与 `App.tsx` 一样直接 return。
- 不把 `mod+1`… 登记进 `KEYBINDING_ACTIONS`（PRD：不可改绑）。

`eventToBinding` 对纯修饰键返回 `null`，保持不动；修饰键按下用 `e.key === 'Meta' | 'Control'` 跟踪。

## Row UI

`ConversationRow` 增加可选 `switchHint?: string`。有值时右侧只渲染 hint（`tabular-nums` / `text-[10px]`），盖住相对时间和 hover 操作按钮。无值保持现状。

Hint 文案用现成 `formatBinding('mod+1')`，不走 i18n。

## Tests

槽位函数按 `.trellis/spec/testing.md` 做同目录 `sessionSwitchSlots.test.ts`。用例少（去重、折起、上限 5、搜索、归档、截断 9），主会话 inline Red-Green，不上 coworker 拆角色。

组件与按键留 CDP/手工；不写 React 组件测试。
