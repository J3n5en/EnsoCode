# Implement: Cmd session switch slots

TDD：槽位纯函数 inline Red-Green（预计 < 10 个 `it`）。红灯前不写实现。

1. RED：`src/renderer/stores/sessions/sessionSwitchSlots.test.ts`
   - 空列表 → `[]`
   - Pinned + 项目可见行按顺序
   - 同一 id 只保留第一次（Pinned 优先）
   - 折起项目的会话不入列
   - 未展开「Show more」只取前 `COLLAPSED_SESSION_LIMIT`
   - 搜索过滤后只保留命中行
   - archived 不入列
   - 超过 9 条截断
2. GREEN：实现 `sessionSwitchSlots.ts`，跑 `pnpm test` 绿。
3. `Sidebar`：用该函数算 `slots`；跟踪 `modHeld`；`mod+1..9` 调用 `selectConversation`；把 `switchHint` 传给 Pinned 与项目里的 `ConversationRow`（仅首次出现的 id）。
4. `ConversationRow`：`switchHint` 替换右侧时间/hover 按钮。
5. 远程节点守卫；window blur 清 `modHeld`。
6. 验证：`pnpm test`、`pnpm typecheck`；真机按住 ⌘ 看提示、⌘1 切换、折叠侧栏键盘仍切、Composer 聚焦仍切。

Rollback：还原上述文件即可，无持久化。
