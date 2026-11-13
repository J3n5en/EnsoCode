# 秘书 Agent 实现计划

> 依据设计稿 `docs/project-history/2026-11-13-secretary-agent-design.md`（commit 44c67bae6）。本文把设计落到逐文件的实现单元。worker 只读本文和设计稿即可动手。文中行号以 44c67bae6 为准，动手前用 grep 校准。

## 通用约定

- 每个单元独立提交，提交前跑 `pnpm typecheck && pnpm lint && pnpm test`。可单测逻辑按 Red-Green：先写失败的测试，再写实现。
- 新 IPC 必须同时改三处：`src/shared/types/ipc.ts` 常量，`src/main/ipc/secretary.ts` handler（在 `src/main/ipc/index.ts` 注册，照 `registerBotHandlers`），`src/preload/index.ts` 的 `secretary` 领域对象。另外在 `src/tooling/productCapabilityCoverage.fixture.ts` 的 `IPC_PRODUCT_COVERAGE`（:475）登记为 `excluded('Experimental secretary agent; not an Enso capability.')`，否则覆盖测试失败。
- IPC 入参按 `unknown` 收窄，返回 `{ ok, ... }`。renderer 只传 id，路径由 Main 从权威记录推导。
- Main 核心代码不能 `import 'electron'`，从 `@platform` 取 `app`（biome `noRestrictedImports`，server 壳 `src/server` 复用同一核心）。
- renderer 文案走 `t()`，中文写进 `src/shared/i18n.ts`（`src/shared/i18n.test.ts` 查漏译）。
- `userData/secretary/` 下的 JSON 用 `src/main/services/bots/files.ts` 的 `readJson` / `writeJsonAtomic` / `writeAtomic`。jsonl 追加照 `src/main/services/bots/routineRuns.ts:19`。
- 所有秘书 IPC、秘书工具执行、秘书会话 spawn 先查开关 `secretaryEnabled`。关闭时返回 `{ ok: false, error: 'disabled' }`。
- PWA：`secretary:*` 通道不在 `src/main/services/remoteRenderer/channels.ts` 的黑名单前缀里，远端默认可调。Main 推送用 `broadcastToRenderers`（`src/main/services/renderers.ts:46`，含远端）。不要新增 `window:` 前缀的通道。

## 关键结论

### 1. 实验开关

最近的先例是 `dropShelfEnabled`（#233）和 `scratchSessionsEnabled`。秘书开关 `secretaryEnabled: boolean`，默认 `false`，照它们改：

- `src/main/ipc/settings.ts:57` `SETTINGS_STATE_FIELDS` 与 :200 起的 `CONFIG_SYNC_EXCLUDED_STATE_FIELDS`（:237-239 同列）。
- `src/main/services/configSync/index.ts:99-104` 写 `{ mode: 'excluded', reason: 'secretary lives on this device' }`。
- `src/renderer/stores/settings/types.ts:181-185, 418`，`src/renderer/stores/settings/index.ts:214-216, 419-421`（字段、默认值、`setSecretaryEnabled`）。
- `src/renderer/components/settings/ExperimentalSettings.tsx` 加一行 `SwitchRow`（`rowId="experimental.secretary"`）。
- `src/shared/searchAnything.ts:260` 加 `experimental.secretary` 条目。
- `src/tooling/productCapabilityCoverage.fixture.ts:64-68, 250` 登记字段和 action。
- 配置 CLI：`src/main/services/configCli/policy.ts` 默认允许。布尔开关不含密钥、路径、执行入口，Main 每次调用现读，不需要 `RESTART_REQUIRED`，所以 `policy.ts` 不改。按 `docs/config-cli.md:100` 第 5 条，在 `src/main/services/configCli/server.test.ts` 补一条断言：`secretaryEnabled` 可 `set` 且 schema 里 `writable: true`。`docs/config-cli.md` 不需要改表。
- Main 读开关：`readSettingsState()?.secretaryEnabled === true`，照 `src/main/ipc/bots.ts:215` `botModeEnabled()`。

### 2. 会话记录（`enso-conversations`）的写入

现状：

- renderer 的 sessions store 用 `createElectronPersistStorage`（`src/renderer/stores/settings/storage.ts:67`）整份写回 `SETTINGS_WRITE_KEY`。`getItem` 读的是整份 `settings.read()`。
- Main 在 `SETTINGS_WRITE_KEY`（`src/main/ipc/settings.ts:965`）里调 `mergeConversationsWrite`（`src/main/services/remoteRenderer/conversationSync.ts:59`）。它按 sender 记 baseline。只有一个主界面时直接整份覆盖；多个时求 diff，推 `CONVERSATIONS_PATCH` 给其他主界面。
- renderer 收补丁在 `src/renderer/stores/sessions/index.ts:4506`。未水合时直接丢弃。应用逻辑 `applyConversationsPatchToState`（`src/renderer/stores/sessions/remotePatch.ts`）对已有行忽略 `RUNTIME_CONVERSATION_KEYS`，对新行整行采用 `set`。
- Main 现有的写法 `patchConversationsState`（`settings.ts:846`）只写盘并广播 `SETTINGS_CHANGED`。`SETTINGS_CHANGED` 只让 settings store 重读（`src/renderer/stores/settings/index.ts:1431`），sessions store 不重读。所以有 renderer 在线时，Main 插入的行会被下一次整份写回抹掉。现在只有 `pairSessionHost` 在无 renderer（headless）时用它，没暴露这个问题。

落地方案（单元 U1）：每个主界面一本账，补丁带 `seq`，写回带确认号。

```ts
// conversationSync.ts 内部
interface PeerLedger {
	/** 该 renderer 最近一次写回的值，或 conversations:read 时的磁盘值 */
	base: unknown;
	/** 已推给它、它还没确认应用的补丁 */
	pending: { seq: number; patch: ConversationsPatch }[];
}
```

- 全局 `seq` 单调递增，Main 每推一次补丁就加一。推送载荷 `ConversationsPatch & { seq: number }`。
- renderer 写回 `(value, ackSeq)`：`expected = base` 依次应用 `pending` 中 `seq <= ackSeq` 的补丁；`local = diffConversations(expected, value)`；账本改为 `{ base: value, pending: seq > ackSeq 的部分 }`；`local` 合并进磁盘，再以新 seq 推给其他主界面。单主界面也走这条路径，不再整份覆盖。
- Main 写入（插行、改行）：读磁盘，修改副本，`diffConversations(current, next)` 得到补丁，写盘并推给所有主界面。`patchConversationsState` 改为走这个入口（签名不变，调用方 `pairSessionHost` 不用改）。Main 写入和 renderer 写回都在 Main 事件循环里同步执行，天然串行。
- 账本重置：新增 IPC `CONVERSATIONS_READ`（`'conversations:read'`），返回 `{ value, seq }` 并把该 sender 的账本置为 `{ base: value, pending: [] }`。sessions store 的 `getItem` 改用它。`SETTINGS_READ` 仍只在账本缺失时建账（settings store 重读频繁，不能重置会话账本）。
- renderer：`remotePatch.ts` 记 `appliedConversationsSeq`，在 `setState` 应用补丁之前更新，这样 persist 同步回调里读到的确认号与值一致。`createElectronPersistStorage` 的 `enqueue`（storage.ts:73）在入队时同时捕获值和确认号（合并 pending 时取最后一次），`writeKey(name, value, ackSeq)` 多带第三个参数。水合前收到的补丁缓存起来，在 `onRehydrateStorage`（sessions/index.ts:4256）里按序应用，不再丢弃。
- `activeId` 不进补丁（`docs/engineering-reference/big-question/pwa-desk-active-conversation.md`），Main 插行不会切走任何一端的当前会话。

Main 新建一条记录需要的字段，照 `adoptPairSessionHeadless`（`src/main/services/pairSessionHost.ts:263-284`）再加两个展示字段：

```ts
{
	id, projectId, title, createdAt, lastActiveAt: createdAt,
	messages: [], commands: [], customEntries: [], dispatchMainEvents: {}, lastSeq: 0,
	spawning: false, status: 'idle', started: false,
	reasoningEnabled, thinkingLevel, lastProviderId, lastModelId,
	presetId?, approvalMode, worktree?,      // worktree: SessionWorktree
	driver: 'main',                            // 新字段，见结论 5
	secretaryOrigin?: { secretaryConversationId: string }, // 新字段，仅展示
}
```

`title` 必须非空（用 `extractRepresentativeTitle`，`src/shared/titleSource.ts:62`）。renderer 的 `newConversation` 会复用同项目里无标题、未启动的空白会话（sessions/index.ts:2604-2620），空标题的派出会话会被它抢走。

### 3. Main 原生建会话与 attach

可复用度：

- `pairSessionHost`：`adoptPairSessionHeadless` 给出行形状，但只在 headless 下写盘。手机建会话的有 renderer 路径（`src/main/services/pairHost.ts:1174`）是先 spawn 再广播 `PAIR_SESSION_CREATED` 让 renderer 补登记。注释写明登记前的 agent 事件会被丢弃。秘书派活改为先写行再 spawn。
- `wirePairSessionHost` 的 `spawn`（`src/main/ipc/agent.ts:1097-1110`）是现成的 Main 侧 spawn 包装：`rootIdentity` / `prepareParent` / `readStoredOauthCredentialKeys` / `spawnBoundSession`。抽成导出函数 `spawnRootFromMain(request)`，pair 与秘书共用。
- `BotSessionHost` 绑定 Bot 成员档案与群聊，不复用。`agentDispatchService.ts` 管 child 会话（typed mention），不适用于根会话。
- 权威登记：`SourceAuthorityRegistry.createConversation`（`src/main/services/sourceAuthorityRegistry.ts:325`）对普通本地项目可直接由 Main 调用；失败回滚用 `removeConversation`（:436）。
- worktree：`WORKTREE_CREATE` handler（`src/main/ipc/worktree.ts:603-652`）的主体抽成导出 `createConversationWorktree(conversationId, projectId)`。
- 默认模型、推理、审批、预设：`src/shared/defaultModel.ts` 的 `scopedDefaultModels`（:227）、`resolveChatReasoning`（:249）、`resolveChatModel`（:271）、`defaultApprovalMode`（:207），加 settings 的 `defaultPresetId`。与 renderer `newConversation`（sessions/index.ts:2657-2690）同口径。

attach 会不会重复 spawn，结论是不会，证据如下：

- worker 的 `spawn` 对同一 identity 幂等：已存在时只回一个 `parent-ready`（`src/agent/supervisor.ts:2368-2382`）。renderer 的 `AGENT_SPAWN`（agent.ts:2219）用 `exactIdentity(sessionId)` 取当前代，与 Main spawn 的是同一代。
- renderer 收到 `parent-ready` 后置 `started: true` 和 `sessionFile`（sessions/index.ts:1866-1872）。不在线的 renderer 水合后发全量 `requestSnapshot`，快照把活着的会话标为 `started`（sessions/index.ts:1275）。之后发消息不会再 spawn。
- 残余窗口：行已到 renderer、`parent-ready` 还没到时用户立即发送，会再发一次 spawn。worker 在 `getRuntime` 等异步步骤之前查 `existing`，并发两次可能都穿过检查。U2 真机验证必须覆盖这个窗口；若复现，在 `supervisor.spawn` 里按 sessionId 记在途 Promise 合并并发调用。
- spawn 失败时 Main 不能用补丁把已有行改成 `failed`（`status` / `error` 是运行时键，补丁对已有行忽略）。失败一律删行、删权威，由提案卡片显示失败原因。

### 4. 秘书身份

新增 `ProjectKind = 'secretary'`，照 scratch 先例：

- 注册：`ensureSecretaryProject(dir)` 照 `ensureScratchProject`（sourceAuthorityRegistry.ts:202），启动时在 agent.ts:1351 旁调用，目录 `userData/secretary/workspace/`。
- renderer 要在 `settings.projects` 里看到它：`ChatView.tsx:568` 的 `onSend` 在找不到 `project` 时直接返回，`newConversation` 也要在投影里找到项目。scratch 也是这样做的，再在各消费处过滤。过滤点见 U3a。
- 秘书判定：**按项目 kind 推导**，`isSecretaryConversation(id) = registry.project(registry.conversation(id)?.projectId)?.kind === 'secretary'`。这与设计稿的 `ConversationAuthority.role` 不同，见「与设计稿的偏差」D1。

### 5. 会话目标续跑的归属

- renderer 续跑在 `continueGoal`（sessions/index.ts:2085，leader 才跑，含 25 轮上限和连续 3 次无进展暂停），队列泵在 `flushQueue`（:2165）。调用点在 :1329（补快照）、:1670（压缩结束）、:1942（`turn-completed`）。
- Main 侧只有 `pairSessionHost` 在 `isPairHeadless()` 时用 `src/shared/pair/headlessQueue.ts` 的 `onHeadlessIdle` / `applyHeadlessGoalSignal` 驱动，运行时从 pair 目录播种（pairSessionHost.ts:179-212）。
- 归属标记：Main 写的派出会话行带 `driver: 'main'`（持久化字段，加进 `Conversation` 类型 sessions/index.ts:257）。renderer 的 `flushQueue`、`continueGoal` 见到它直接返回；`setGoal` / `pauseGoal` / `resumeGoal` / `clearGoal`（:3818 起）见到它改调 IPC `secretary:goal-action`，本地不发 kickoff。`pairSessionHost.handlePairHeadlessAgentEvent`（:377）和 `seedRuntimes` 跳过 `driver === 'main'` 的行，避免 headless 时两个驱动方同时续跑。
- 队列数据仍在行的 `queuedMessages` 里，两端共用。用户在 renderer 里排队的消息经账本写回 Main，由 Main 在轮次结束时投递。

### 6. 工具装配

- `spawnSession`（`src/main/services/agentHost.ts:971`）的 `bot` 选项会关掉 Enso 插件（`extensionPlugins = null`），但 Claude 插件的 hooks 与 commands 不受 `bot` 控制（:1070-1071、:1165-1166），agentTypes 只在 `omitDispatchTools` 时清空。秘书需要新选项 `secretary`，五类全关：Enso 插件、Claude 插件的 skill/MCP/hooks/commands、子代理类型。
- 内置工具目录：`BUILTIN_TOOLS`（`src/shared/types/builtinTools.ts:12`）只有分组 id：`image_generation`、`subagent`、`workflow`、`todo`、`plan`、`ask_user`、`browser`、`web`、`background_tasks`、`memory`、`turn_discard`、`isolated_sandbox`、`computer`。核心工具 `read`、`grep`、`find`、`ls`、`bash`、`apply_patch` 不在分组里（supervisor.ts:2756 `buildCoreTools`），只靠 `disabledTools` 关不掉。codemode 由 `toolEnabled('isolated_sandbox')` 决定（supervisor.ts:2431），走的是扩展而不是 `customTools`。
- 结论：白名单在 worker 里按**工具名**执行。`secretaryMode` 时，`customTools` 在 `omitNamedTools`（supervisor.ts:3225）之后再只保留 `SECRETARY_TOOL_ALLOWLIST`；运行时 `applyBuiltinTools`（:3324）算出的 `next` 也与白名单求交，因为 `nextActiveToolNames`（`src/agent/builtinLoadout.ts:25`）会按分组把名字加回来。Main 另传强制禁用列表 `isolated_sandbox`、`workspace_write`、`goal` 以及白名单外的全部分组 id，关掉 codemode 扩展，也让 `builtinToolScopes` 的推送保持一致。新增内置工具因为不在白名单里，默认对秘书不可见。
- 白名单：14 个秘书工具，加 `ask_user`、`web_search`、`web_fetch`、`memory_search`、`memory_capture`、`memory_crystallize`、`memory_delete`。记忆工具跟随全局记忆开关（`DEFAULT_DISABLED_BUILTIN_TOOLS` 默认关 memory，agent.ts:1702 全局关时拒绝）。

### 7. Main 实现工具的链路

照 Bot 的 `delegation-invoke`：

1. worker 在 `secretaryMode` 时建 `new MemoryInvoker<SecretaryOp>`（照 supervisor.ts:3047），工具 `execute` 调 `invoker.invoke(op, params)`，emit `secretary-invoke`。
2. Main 在 agent.ts 的 worker 事件分支（照 :1722）收到后交给 `SecretaryHost.invoke(identity, op, params)`，结果经 `sendSecretaryResultToSession`（照 agentHost.ts:1554）发 `secretary-result`。
3. worker 在命令分支（照 supervisor.ts:2050，命令白名单 :1566）`resolve`。
4. 类型与解析在 `src/shared/types/agent.ts`：spawn-parent 字段（:1300 附近，解析键表 :3635、类型检查 :3711），worker 事件（:2097 附近，解析 :4497 用 `hasExactKeys`），命令解析。

Main 校验调用方：`identity` 必须是当前代（`agentSessionIndex.isCurrent`），会话必须是秘书会话，开关必须打开。

### 8. 需要用户确认的卡片

- 先例 `routine_propose`（`src/main/services/bots/routineProposal.ts`）是非阻塞草稿：工具立即返回“待批准”，用户在 Bot 界面批准。秘书照此：`session_create`、`todo_item_dispatch`、`secretary_profile_propose` 需要确认时立即返回 `{ status: 'awaiting_confirmation', proposalId }`，不挂起秘书的轮次。用户处理后，结果作为一条 `<session-updates>` 进回传队列（设计稿「确认卡片的状态」）。
- 聊天内卡片插在 `TimelineRow.tsx:2221`：那里已按工具名把 `goal_*` 分派给 `GoalSignalRow`。秘书三个工具在输出含 `proposalId` 时分派给 `SecretaryProposalRow`，状态从 renderer 的秘书 store 读（Main 推送）。聊天卡片和工作台读同一份 Main 状态。

### 9. 回传注入与去重

- 注入：`promptSession(identity, text, undefined, deliveryId)`（agentHost.ts:1641）。worker 收到 prompt 时若会话仍在运行会转成 steer（supervisor.ts:1832），所以 Main 判断空闲有竞态也不会丢消息。
- 回执：worker 发 `delivery-settled` / `delivery-rejected` / `delivery-deferred`（`src/shared/types/agent.ts:1949-1951`），之后是该轮的 `turn-completed` / `turn-failed`。设计稿要求“秘书这一轮正常结束才算投递成功”，所以以 `delivery-settled` 之后第一个非 aborted 的 `turn-completed` 为成功。
- 重启去重：`StartedDeliveryIndex`（`src/main/services/bots/startedDeliveries.ts:44`）能查某个 deliveryId 是否已写进会话 jsonl。重启时在途批次的 deliveryId 已在 jsonl 里就视为已投递，否则重投。
- `BotSessionHost` 的准入、预算、插话改排对秘书都用不上，只借用上面三点。

### 10. 待审批与 `ask_user` 计数

- `pairSessionHost` 的计数：`handlePairHeadlessAgentEvent`（pairSessionHost.ts:377）首行 `if (!headless) return`。在 `approval-request` / `approval-resolved`、`ask-request` / `ask-resolved` 上用 `nextPendingCount`（:489）按 requestId 增减，按事件 identity 的 sessionId 分节点记（子会话 `root::cw-*` 单独一份），`turn-completed` / `turn-failed` 时清零（:437），接管时从 pair 目录的 `pendingApprovalCount` 播种（:207）。
- 结论：派出会话的分类**不复用**这套计数。原因有三：只在 headless 下工作，不聚合子会话，轮次结束清零（子代理的审批可能跨轮）。
- 改用 `SessionStateTracker`（`src/main/services/extensionPlugins/sessionState.ts`）。它按根会话聚合根和全部子节点的 asks 与 approvals，用快照的 `pendingAsks` / `pendingApprovals` 播种，`worker-exited` 时全部置 `failed`，`status(id)` 返回 `state: 'idle' | 'running' | 'waiting' | 'error'` 和两个计数。agent.ts:241 已有实例 `pluginSessionStates`，在 `broadcastAgentEvent`（:272）里经 `publishPluginSessionStatus`（:318）喂事件。U4 导出只读查询 `observedSessionStatus(id)`；U6a 把 `observe(event)` 的结果同时交给插件发布和秘书观察者，只调一次。
- 同一份状态也用于 `session_send` 的拒绝判定（`pendingAsks + pendingApprovals > 0` 即拒）和 Main 续跑的 `canFlush`。

### 11. 记忆空间

- 可见空间由 `memorySpaceContext` / `resolveSpaceIds`（`src/main/services/memory/space.ts`）决定：`all` = bot → chat → project → global。写入的空间检查在 `bridge.ts`（capture :117，delete 可见性 :207）。上下文在 agent.ts:1688 按会话权威算。
- 秘书的私有空间就是 `secretary` 隐藏项目的 project 空间 `proj:<secretaryProjectId>`。`MemorySpaceContext` 加 `secretary?: { readProjectIds: string[] }`。有它时：`all` = 私有 + 可见项目 + global；`project` = 私有；capture、crystallize、delete 的目标不是私有空间就抛 `MemoryValidationError('read_only', ...)`。校验在记忆服务里，不靠工具描述。

### 12. 界面落点

- 侧栏：`src/renderer/components/chat/Sidebar.tsx`。滚动区开头在 :939（`GroupChips` 之后、“Add a project” 按钮之前），伪项目行插在这里，与分组标签无关。scratch 区块（:1049）是同类先例。折叠图标列在 :859，秘书图标放在最上方。`orderedProjects`（:288）过滤掉 `secretary`；“Active” 区按 `slicedIdSet` 过滤（:620），秘书会话不在任何项目分组内，自然不进去。
- 右侧面板：dockview，组件表 `DOCK_COMPONENTS`（`src/renderer/components/sidepanel/SidePanel.tsx:672`），开面板的函数在 `src/renderer/lib/sidePanelDock.ts`（`addSidePanelChanges` 等）。`SidePanelTabKind`（`src/shared/types/sidePanel.ts:3`）加 `'secretary-board' | 'secretary-memory'`。
- 设置页：分类联合类型在 `src/renderer/components/settings/constants.ts:4`，显隐在 `settingsCategories.ts`（照 `BOT_PAGES` 按开关显隐），列表与内容在 `SettingsContent.tsx:174, 346`，深链在 `src/shared/settingsDeepLink.ts`。PWA 打开设置走 `src/web/electronShim.ts:210` 的 `bridge.openSettings`。
- 欢迎页：`App.tsx:687` 的 `Onboarding` 带 `!window.electronAPI.remote`，不能照搬。秘书欢迎页渲染在主区域 `App.tsx:665` 的 `<ChatView />` 槽位，由秘书 store 的 `welcomeOpen` 切换，不判断 `remote`。

### 13. 会话引用

- `mentionComposer.ts` 的 chat 段只有 `label` 和 `sessionFile`（:136），`createEditorPayload` 把 `id` 设成 `sessionFile`（:328）。来源：`MentionEditor.tsx:132`（chip dataset）、:479（候选），`Sidebar.tsx:2268/2305` 与 `dragDrop.ts:30`（拖拽）。`ChatMentionCandidate.id` 是会话 id（`src/shared/types/mentions.ts:24`）。
- 补法：chat 段加 `conversationId?: string`，四个来源都带上，`createEditorPayload` 透传到 mention。wire 文本（`chatRefLine`）不变。
- 发送链路：`ChatView.tsx:568` `onSend` → `routeComposerPayload` → `store.send(text, target, images)`。运行中进 `queuedMessages`，之后 `deliver`（sessions/index.ts:2012）→ `agent.prompt`（4 个位置参数，preload:877）。mentions 在 `send` 处已经丢了。处理方式见偏差 D2。

### 14. PWA 完整模式

- 远端调用通道按前缀黑名单（`channels.ts`），`secretary:*` 与 `conversations:read` 自动可用。`src/web/electronShim.ts` 复用 preload，新 preload API 不需要单独适配。
- 头像：`src/shared/localImage.ts:31` 加 `SECRETARY_AVATAR_HOST = 'secretary-avatar'` 与 `secretaryAvatarUrl(version)`，经 `routed()` 在远端走隧道代理；`src/main/services/localImageProtocol.ts:85` 照 Bot 头像加分支。
- 欢迎页、工作台、确认卡片都不依赖本机窗口能力。

### 15. 只读结果的脱敏与标注

- `redactSecrets(text)` 在 `src/main/services/memory/distill.ts:119`，纯字符串函数，Main 内直接导入。
- 包裹格式 `<untrusted-content source="session:<id>">…</untrusted-content>`。正文里出现的 `</untrusted-content` 要转义成 `<\/untrusted-content`，防止提前闭合。先脱敏再包裹。

## 与设计稿的偏差（请主代理确认）

- **D1 不加 `ConversationAuthority.role` 与 `origin`。** 秘书会话按项目 kind 判定，派出关系只存在 `dispatch.json`。理由：`parseConversationAuthority`（`src/shared/types/agent.ts:3004`）用 `hasOnlyKeys`，新增字段要同步改解析，否则旧版 renderer 读投影整份失败；而 `secretary` 项目里的会话恰好就是全部秘书会话，项目 kind 本身只由 Main 写入。派出关系放两处会有不一致的风险。renderer 行上的 `secretaryOrigin` 只用于显示“由秘书派出”，任何权限判断都不读它。
- **D2 点名授权走独立 IPC，不改 `AGENT_PROMPT`。** `ChatView.onSend` 在秘书会话里发送前调 `secretary:reference-conversations(secretaryConversationId, conversationIds)`。理由：消息可能先进队列再投递，要把 id 带过 `send`、`queuedMessages`、`deliver`、`prompt`、`steer` 和 pair 路径。授权本来就归秘书身份、在用户发出时生效，与那一轮是否成功无关。Main 仍逐个校验，且只接受秘书会话。
- **D3 U2 的测试入口是 dev-only IPC `secretary:dev-create-session`**，只在 `!app.isPackaged` 时注册，U10 删除。
- **D4 秘书会话不加载全局指令**（spawnSession 的 `instruction` 置空）。全局指令是给写代码的会话的。回复语言由 profile 决定。
- **D5 初次设置与开场白用普通用户消息触发**：表单完成或选择对话后，renderer 新建秘书会话，用 `send()` 发一条固定的引导语（i18n 文案），不新增 Main 注入通道。

## 数据形状

`src/shared/types/secretary.ts`（U3c 建）：

```ts
import type { ModelRef, ThinkingLevel } from './agent';

export type SecretaryAutonomy = 'ask-first' | 'tell-after' | 'full';

export interface SecretaryProfile {
	version: 1;
	name: string;
	avatar: { color: string; imageVersion?: number };
	model?: ModelRef & { thinkingLevel?: ThinkingLevel };
	autonomy: SecretaryAutonomy;
	autoApproveProjectIds: string[];
	visibleProjectIds: 'all' | string[];
	dispatchModel:
		| { mode: 'project' }
		| { mode: 'fixed'; model: ModelRef }
		| { mode: 'choose'; candidates: ModelRef[] };
	dispatchWorktree: 'never' | 'auto' | 'always';
	maxRunningDispatches: number; // 默认 3，1..10
	addressAs?: string;
	replyLanguage: 'ui' | 'zh' | 'en';
	style: 'concise' | 'detailed';
	notify: 'needs-user' | 'with-done' | 'off';
	dailyBriefAt?: string; // 'HH:MM' 本地时间；缺省表示关闭
	updatedAt: number;
}
// 人设补充文字在 persona.md，头像在 avatar.png，均不进 profile.json

export type ProposalStatus = 'pending' | 'executing' | 'succeeded' | 'failed' | 'rejected' | 'expired';

export interface DispatchDraft {
	projectId: string;
	prompt: string;
	title?: string;
	goal?: string;
	model?: ModelRef;
	worktree: boolean;
	todoId?: string;
}

export type SecretaryProposal = {
	id: string;
	secretaryConversationId: string;
	createdAt: number;
	updatedAt: number;
	status: ProposalStatus;
	error?: string;
} & (
	| { kind: 'dispatch'; draft: DispatchDraft; conversationId?: string }
	| { kind: 'profile'; draft: Partial<Omit<SecretaryProfile, 'version' | 'updatedAt'>> & { persona?: string } }
);

export type SecretaryResultKind =
	| 'goal-complete' | 'goal-blocked' | 'turn-ended' | 'needs-user'
	| 'failed' | 'stalled' | 'interrupted';

export interface DispatchRecord {
	conversationId: string;
	projectId: string;
	secretaryConversationId: string;
	createdAt: number;
	todoId?: string;
	goal?: string;
	turn: number; // 每次 turn-completed / turn-failed 加一
	lastState: 'running' | 'idle' | 'waiting' | 'error';
	lastEventAt: number;
	stalledTurn?: number; // 已报 stalled 的轮次，一轮只报一次
	lastResult?: { kind: SecretaryResultKind; turn: number; at: number };
}

export type SecretaryUpdate = { key: string; at: number; text: string; secretaryConversationId?: string } & (
	| { kind: SecretaryResultKind; conversationId: string }
	| { kind: 'proposal'; proposalId: string; status: ProposalStatus }
	| { kind: 'schedule'; scheduleId: string }
);

export interface SecretaryDispatchFile {
	version: 1;
	dispatched: Record<string, DispatchRecord>;
	named: string[];
	proposals: Record<string, SecretaryProposal>;
	outbox: SecretaryUpdate[];
	inflight?: {
		deliveryId: string;
		secretaryConversationId: string;
		keys: string[];
		attempt: number; // 1..6
		nextAttemptAt: number;
		settled?: boolean;
	};
}

export interface SecretaryTodo {
	id: string; text: string; dueAt?: number; projectId?: string;
	createdAt: number; updatedAt: number; conversationId?: string; doneAt?: number;
}

export interface SecretarySchedule {
	id: string; name: string; prompt: string;
	at?: string;   // 一次性，ISO 时间
	cron?: string; // 五段式本地时间；与 at 二选一
	createdAt: number; lastFiredAt?: number;
	system?: 'daily-brief' | { todoId: string };
}

export interface SecretaryAuditEntry {
	at: number; secretaryConversationId: string | null;
	op: string; targetId?: string; ok: boolean; detail?: string;
}

export type SecretaryCard =
	| {
			kind: 'session';
			conversationId: string; projectId: string; projectName: string; title: string;
			state: 'running' | 'idle' | 'waiting' | 'error' | 'not-started';
			lastText?: string; startedAt: number;
			result?: SecretaryResultKind; secretaryConversationId: string; unread?: boolean;
	  }
	| { kind: 'proposal'; proposal: SecretaryProposal; projectName?: string };

export interface SecretaryBoard {
	needsYou: SecretaryCard[];
	running: SecretaryCard[];
	todos: SecretaryTodo[];
	done: SecretaryCard[];
}

export interface SecretaryState {
	enabled: boolean;
	projectId: string | null;
	profile: SecretaryProfile | null; // null = 未完成初次设置
	persona: string;
	board: SecretaryBoard;
	proposals: Record<string, SecretaryProposal>;
}
```

`src/shared/secretary/tools.ts`（U3b 建，与上面的类型文件分开，方便并行）：

```ts
export const SECRETARY_OPS = [
	'project_list', 'project_info', 'session_list', 'session_read',
	'session_create', 'session_send', 'session_stop',
	'todo_item_add', 'todo_item_update', 'todo_item_dispatch',
	'schedule_add', 'schedule_list', 'schedule_remove',
	'secretary_profile_propose',
] as const;
export type SecretaryOp = (typeof SECRETARY_OPS)[number];
export const SECRETARY_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
	...SECRETARY_OPS, 'ask_user', 'web_search', 'web_fetch',
	'memory_search', 'memory_capture', 'memory_crystallize', 'memory_delete',
]);
```

IPC 通道（全部加 `secretary:` 前缀，除 U1 的会话读）：

| 常量 | 值 | 方向 | 单元 |
| --- | --- | --- | --- |
| `CONVERSATIONS_READ` | `conversations:read` | invoke → `{ value, seq }` | U1 |
| `SECRETARY_DEV_CREATE_SESSION` | `secretary:dev-create-session` | invoke，仅 dev | U2，U10 删除 |
| `SECRETARY_GET_STATE` | `secretary:get-state` | invoke → `SecretaryState` | U5b |
| `SECRETARY_STATE_CHANGED` | `secretary:state-changed` | Main 推送 `SecretaryState` | U5b |
| `SECRETARY_RESOLVE_PROPOSAL` | `secretary:resolve-proposal` | invoke `(proposalId, 'confirm' \| 'reject', edits?)` | U5b |
| `SECRETARY_REFERENCE_CONVERSATIONS` | `secretary:reference-conversations` | invoke `(secretaryConversationId, ids[])` | U5b |
| `SECRETARY_TODO_MUTATE` | `secretary:todo-mutate` | invoke（界面编辑、删除、派出） | U5b |
| `SECRETARY_GOAL_ACTION` | `secretary:goal-action` | invoke `(conversationId, 'pause' \| 'resume' \| 'clear')` | U5c |
| `SECRETARY_SCHEDULES_LIST` / `SECRETARY_SCHEDULE_REMOVE` | `secretary:schedules-list` / `secretary:schedule-remove` | invoke | U6b |
| `SECRETARY_GET_PROFILE` / `SECRETARY_SAVE_PROFILE` / `SECRETARY_RESET_PROFILE` | `secretary:get-profile` 等 | invoke | U7 |
| `SECRETARY_SET_AVATAR` | `secretary:set-avatar` | invoke（照 Bot 头像 IPC 的入参形状） | U7 |

worker 协议（`src/shared/types/agent.ts`，U3b）：

```ts
// AgentCommand spawn-parent 增加
secretaryMode?: boolean;
// AgentWorkerEvent 增加
| { type: 'secretary-invoke'; identity: SessionIdentity; seq: number; requestId: string; op: SecretaryOp; params: unknown }
// AgentCommand 增加
| { type: 'secretary-result'; identity: SessionIdentity; requestId: string; ok: true; result: unknown }
| { type: 'secretary-result'; identity: SessionIdentity; requestId: string; ok: false; error: string }
```

Main 服务目录 `src/main/services/secretary/`：`store.ts`、`audit.ts`、`sessionFactory.ts`、`prompt.ts`、`tools.ts`（op 分派表）、`readers.ts`、`dispatch.ts`、`driver.ts`、`results.ts`、`deliveries.ts`、`schedules.ts`、`host.ts`（`SecretaryHost` 组装以上，并提供 `getSecretaryHost()`）。renderer：`src/renderer/stores/secretary.ts`，组件放 `src/renderer/components/secretary/`。

## 实现单元

### U0 实验开关

1. 目标：设置页「实验」出现「秘书」开关，默认关，可被 `enso config set secretaryEnabled true` 打开。完成判据：下面的测试通过；dev 应用里开关切换后 `settings.json` 的 `enso-settings.state.secretaryEnabled` 随之变化。
2. 文件：见结论 1 列出的全部位置。Main 读取函数 `secretaryEnabled()` 放在新文件 `src/main/services/secretary/enabled.ts`，读 `readSettingsState()`。
3. 测试：`src/main/services/configCli/server.test.ts` 补 `secretaryEnabled` 可写；`src/main/ipc/settings.test.ts` 补“开关是本机字段、不参与 config-sync”（照 :182 讨论模式用例）；`src/shared/searchAnything.test.ts` 补条目归属 `experimental`。
4. 不做：开关以外的任何秘书逻辑。风险：漏登记 `productCapabilityCoverage.fixture.ts` 会让编译期 Record 报错，按报错补。

### U1 Main 写会话记录

1. 目标：Main 能插入和修改 `enso-conversations` 的行，所有在线主界面立即收到，任何 renderer 的整份写回都不会抹掉它。完成判据：设计稿三条测试加下列测试全部通过；dev 应用多窗口（桌面 + 第二个浏览器主界面）下现有会话的增删改、置顶、归档不回归。
2. 文件：
   - `src/main/services/remoteRenderer/conversationSync.ts`：按结论 2 改成账本。导出 `readConversationsFor(sender, current)`、`mergeConversationsWrite(sender, current, value, ackSeq)`、`applyMainConversationsPatch(current, patch)`，以及 `onConversationsMerged(listener)`（U5c 用来在用户排队后补投）。
   - `src/main/ipc/settings.ts`：`SETTINGS_WRITE_KEY`（:965）解析第三参数 `ackSeq`（非负整数，否则按 0）；新增 `CONVERSATIONS_READ` handler；`patchConversationsState`（:846）改为经 `applyMainConversationsPatch` 写入。另加 `readPersistedConversations(): Record<string, Record<string, unknown>>`（U4 用）。
   - `src/shared/conversationsPatch.ts`：`parseConversationsPatch` 解析并返回 `seq`。
   - `src/shared/types/ipc.ts`、`src/preload/index.ts`：`settings.readConversations()`；`settings.writeKey(name, value, ackSeq?)`。
   - `src/renderer/stores/settings/storage.ts`：`createElectronPersistStorage` 接受可选 `{ read?, ackSeq? }`；`enqueue` 把 `ackSeq` 与值一起存进 `pending`。
   - `src/renderer/stores/sessions/remotePatch.ts` 与 `src/renderer/stores/sessions/index.ts:4245, 4256, 4506`：确认号、水合前缓存、水合后补用。
3. 测试（先写）：
   - 新建 `src/main/services/remoteRenderer/conversationSync.test.ts`：Main 插入后 renderer 以旧 `ackSeq` 写回，记录不丢；renderer 确认补丁后删除该记录，删除生效；两个主界面并发写入，结果与单端顺序写入一致；单主界面时只合并 diff，Main 期间插入的行保留；`conversations:read` 重置账本。
   - `src/renderer/stores/settings/storage.test.ts`：确认号在入队时绑定，合并时取最后一次。
   - `src/renderer/stores/sessions/remotePatch.test.ts`：水合前的补丁在水合后应用；`seq` 递增记录。
   - `src/shared/conversationsPatch.test.ts`：解析 `seq`。
   - `src/main/ipc/settings.test.ts:251` 的已有用例按新签名更新。
4. 风险：所有会话写入都经过这里，出错会丢用户会话。审查重点是“确认号与值同一时刻捕获”。不做：Main 其他整份写 `enso-conversations` 的入口（`removeProjectAndConversations` 等）不迁移；不改 `activeId` 语义。

### U2 Main 原生建会话

1. 目标：Main 不依赖 renderer，在本地项目建一个普通可见会话并发首条 prompt。完成判据：单测通过；真机（桌面与 PWA 各一次）用 dev IPC 建会话，renderer 不刷新就看到新行和流式正文，立即打开并发第二条消息，worker 里该会话只有一代、jsonl 只有一个。
2. 文件：
   - 新建 `src/main/services/secretary/sessionFactory.ts`：
     ```ts
     export interface MainSessionRequest {
     	projectId: string; prompt: string; title?: string;
     	model?: ModelRef; thinkingLevel?: ThinkingLevel; worktree: boolean;
     	secretaryOrigin?: { secretaryConversationId: string };
     }
     export type MainSessionResult = { ok: true; conversationId: string } | { ok: false; error: string };
     export interface SessionFactoryPorts {
     	project(id: string): ProjectAuthority | undefined;
     	createConversation(projectId: string, projectVersion: number): ConversationAuthority | undefined;
     	removeConversation(id: string): void;
     	defaults(projectId: string): { providerId: string; modelId: string; reasoningEnabled: boolean; thinkingLevel: ThinkingLevel; presetId?: string; approvalMode: ApprovalMode };
     	createWorktree(conversationId: string, projectId: string): Promise<SessionWorktree>;
     	writeRow(row: Record<string, unknown>): void;   // 经 U1 入口
     	removeRow(id: string): void;
     	spawn(request: AgentSpawnRequest): Promise<ActionResult>;
     	prompt(id: string, text: string, deliveryId: string): ActionResult;
     	newId(): string;
     	now(): number;
     }
     export async function createSessionFromMain(ports: SessionFactoryPorts, request: MainSessionRequest): Promise<MainSessionResult>;
     ```
     顺序：校验项目 active 且 kind 为 local（ssh、scratch、bot-home、secretary 一律拒绝）→ 建权威 → 可选 worktree → 写行（结论 2 的形状，`driver: 'main'`）→ spawn → 带 `deliveryId` 发首条 prompt。写行之后任一步失败：删 worktree、删行、删权威。
   - `src/main/ipc/agent.ts`：把 :1097-1110 抽成导出 `spawnRootFromMain(request)`，`wirePairSessionHost` 改用它；导出 `promptRootFromMain(id, text, deliveryId)`（`exactIdentity` + `promptSession`）。
   - `src/main/ipc/worktree.ts`：抽出 `createConversationWorktree`。
   - `src/main/ipc/secretary.ts`（新建，并在 `src/main/ipc/index.ts` 注册）：dev-only `SECRETARY_DEV_CREATE_SESSION`。
3. 测试：新建 `src/main/services/secretary/sessionFactory.test.ts`，用假 ports：写行先于 spawn；spawn 失败时行与权威都被删除；ssh 项目被拒；行标题非空；默认模型与 renderer 同口径（用 `defaultModel.ts` 的同一组输入断言）。
4. 风险：结论 3 的并发 spawn 窗口。若真机复现，本单元一并修 `supervisor.spawn`（按 sessionId 合并在途调用），补 `src/agent/supervisor.*.test.ts` 用例。不做：秘书相关校验、目标续跑、回传。

### U3a 秘书隐藏项目与过滤

1. 目标：Main 启动时幂等登记 `secretary` 项目；它不出现在任何项目列表、项目选择器、分组、手机目录、记忆空间名之外的地方；秘书会话可以用普通 `newConversation` 建出来。完成判据：测试通过；dev 应用里项目列表、项目搜索、手机目录都看不到它。
2. 文件：
   - `src/shared/types/agent.ts:903` `ProjectKind` 加 `'secretary'`，`isValidProjectRemoteFields`（:2930）加分支；`src/shared/types/project.ts:25` 加 `'secretary'`。
   - `src/main/services/sourceAuthorityRegistry.ts`：`projectIdentity`（:69）加 `secretary:`；`createProject`（:151）拒绝该 kind；新增 `ensureSecretaryProject(dir)`；`removeProject`、`selectProject` 等对 scratch 的特判（:290-304）同样覆盖 secretary。
   - `src/main/ipc/agent.ts:1351` 启动登记；`authoritativeSpawnCwd`（:387）与 :468 不取 worktree；`src/shared/conversationCwd.ts:11` 对 secretary 返回 `canonicalPath`。
   - 新建 `src/main/services/secretary/identity.ts`：`secretaryProjectId()`、`isSecretaryConversation(id)`。
   - 其余 Main 过滤：`src/main/ipc/projects.ts:61`、`src/main/ipc/worktree.ts:177`、`src/main/services/browserFileRoot.ts:20`、`src/main/ipc/memory.ts:607, 626`（空间名记为“秘书”）、`src/main/services/extensionPlugins/sessions.ts:71`；`src/main/ipc/agent.ts` 的 `publishPluginTurnEnd`（:309）与 `publishPluginSessionStatus`（:320）对秘书会话不发插件事件。
   - renderer：`src/renderer/stores/settings/index.ts:1366` 映射 kind；`Sidebar.tsx:288` 过滤；`src/renderer/stores/pairCatalog.ts:44-67` 去掉该项目及其会话；`WorkspaceSearchDialog.tsx:184` 开关关闭时排除；其余 `grep -rn "kind === 'scratch'\|kind !== 'scratch'" src/renderer` 命中处（`WorktreePicker`、`WorkspaceBadge`、`ChatView`、`FilesView`、`ChangesView`）逐处把 secretary 当作“没有可操作工作区”处理。
3. 测试：`sourceAuthorityRegistry.test.ts`（幂等登记、拒绝外部创建与删除）；`src/shared/types/agent` 的解析测试接受新 kind；`src/shared/conversationCwd.test.ts`；`src/renderer/stores/pairCatalog.test.ts` 排除秘书会话。
4. 不做：侧栏伪项目行（U9）；工具装配（U3b）。

### U3b 秘书会话的工具装配

1. 目标：秘书会话只看得到白名单工具，插件整批关闭，14 个秘书工具经 Main 执行（本单元先返回 `unavailable`，后续单元逐个实现）。完成判据：回归测试断言白名单外的内置工具、核心工具、插件工具都不可见；dev 应用里开关打开后新建秘书会话，让模型列出可用工具，结果与白名单一致；开关关闭时秘书会话 spawn 被拒。
2. 文件：
   - 新建 `src/shared/secretary/tools.ts`（见数据形状）。
   - `src/shared/types/agent.ts`：spawn-parent `secretaryMode`、`secretary-invoke` 事件、`secretary-result` 命令及解析。
   - 新建 `src/agent/tools/secretary.ts`：`createSecretaryTools(invoker: MemoryInvoker<SecretaryOp>): ToolDefinition[]`。每个工具给完整 JSON schema（类型、必填、`additionalProperties: false`），`prepareArguments` 做别名与类型归一化（照 `src/agent/tools/routinePropose.ts` 的 `normalizeRoutineProposeParams`），归一化发生在 schema 校验之前。
   - `src/agent/supervisor.ts`：`spawn` 接 `secretaryMode`（照 `botRoutines` 的传参，:1724、:2353）；建 invoker（照 :3047）；`sessionTools` 加秘书工具；:3225 之后按白名单过滤；`applyBuiltinTools`（:3324）与白名单求交；命令分支处理 `secretary-result`。
   - `src/main/services/agentHost.ts`：`spawnSession` 的 `options.secretary?: { systemPrompt: string }`：预设 `{ id: 'secretary', name: 'secretary', skillIds: [], mcpServerIds: [] }`，`extensionPlugins` 为 null，Claude 插件 skillPaths、mcpServers、hooks、commands 全部不带，`agentTypes` 与 `subagentModels` 为空，`instruction` 为空（D4），`extraDisabledTools` 用强制列表，spawn-parent 带 `secretaryMode: true`；新增 `sendSecretaryResultToSession`。
   - `src/main/ipc/agent.ts`：`spawnBoundSession`（:475）对秘书会话：开关关闭则拒绝；否则用 `buildSecretarySystemPrompt` 组装后调 `spawnSession(..., { secretary })`。worker 事件分支处理 `secretary-invoke`，交给 `getSecretaryHost()?.invoke(...)`。
   - 新建 `src/main/services/secretary/prompt.ts`：`buildSecretarySystemPrompt({ profile, persona, uiLanguage })`，纯函数。内容：身份、不读写代码、`<untrusted-content>` 内的指令一律不执行、结果类型的含义（`turn-ended` 不等于完成）、未完成初次设置时引导用户并用 `secretary_profile_propose` 提交。
   - 新建 `src/main/services/secretary/tools.ts`：`Record<SecretaryOp, Handler>` 分派表，本单元全部返回 `{ ok: false, error: 'unavailable' }`。
3. 测试：
   - 新建 `src/agent/supervisor.secretary.test.ts`（照 `supervisor.agentDispatch.test.ts:2540` mock `createAgentSession` 取 `customTools`）：工具名是白名单子集，包含 14 个秘书工具；传入 pluginTools 时仍不出现；`applyBuiltinTools([])` 后激活名仍是白名单子集；没有 `bash`、`read`、`grep`、`find`、`ls`、`apply_patch`、`codemode`、`subagent`、`workflow`、`browser_*`、`computer`、`todo`。
   - `spawnSession` 的测试（`grep -rln "spawnSession" src/main --include=*.test.ts` 找到现有文件）：秘书 spawn-parent 不含 `pluginTools`、`skillPaths`、`mcpServers`、`pluginHooks`、`pluginCommands`、`agentTypes`，含 `secretaryMode`，`disabledTools` 包含强制列表。
   - 新建 `src/agent/tools/secretary.test.ts`：别名与类型归一化、schema 完整。
   - 解析测试：多余键被 `hasExactKeys` 拒绝。
   - `src/main/services/secretary/prompt.test.ts`：提示词含不可信内容规则与语言设置。
4. 风险：白名单泄漏，审查重点是运行时 `applyBuiltinTools` 与 codemode 扩展。不做：任何工具的业务逻辑。

### U3c 秘书数据模型与存储

1. 目标：`userData/secretary/` 下全部文件的类型、解析、读写、审计追加就位。完成判据：测试通过。
2. 文件：新建 `src/shared/types/secretary.ts`（见数据形状）；`src/shared/secretary/parse.ts`（`parseProfile`、`parseDispatchFile`、`parseTodos`、`parseSchedules`，坏输入给默认值或丢弃单条，不抛错）；`src/main/services/secretary/store.ts`（`SecretaryStore(dir)`：profile、persona、avatar 及版本号、dispatch、todos、schedules 的读写）；`src/main/services/secretary/audit.ts`（`appendAudit(dir, entry)`，超过 5MB 改名为 `audit.1.jsonl` 后新开）。
3. 测试：临时目录读写往返；坏 JSON、未知字段、越界数值的归一化；审计轮转。
4. 不做：业务逻辑。纯数据单元，可与 U1、U2、U3a、U3b 并行。

### U4 会话与项目读

1. 目标：`project_list`、`project_info`、`session_list`、`session_read` 可用，结果脱敏并标注不可信。完成判据：测试通过；真机里秘书能说出某项目当前分支和某会话最后的回复。
2. 文件：
   - 新建 `src/main/services/secretary/readers.ts`，注册进 `tools.ts`。
   - 新建 `src/shared/secretary/transcript.ts`：`projectReadableMessages(messages, limit)` 只保留 `user` 与 `assistant` 的文本部分（去掉工具调用、工具输出、思考）；`wrapUntrusted(source, text)`。
   - 数据来源：会话行 `readPersistedConversations()`（U1）；权威 `getSourceAuthorityRegistry()`；状态 `observedSessionStatus(id)`（agent.ts 新导出，读 `pluginSessionStates.status`）；正文 `readSessionHistoryFile(sessionFile, beforeIndex)`（agent.ts:875，已导出）；分支与脏状态在 `src/main/services/worktree/service.ts` 新增导出 `currentBranch(repoPath)`，复用 `repoIsClean`；脱敏 `redactSecrets`。
   - 规则：只列根会话；排除 child（`parentId`）、bot（权威 `bot`）、已归档、秘书项目内的会话；只列可见项目。`session_list` 默认 50 条；`session_read` 默认最后 10 条、上限 30 条、单条 2000 字符，支持 `before` 翻页；ssh 项目只给元数据，不跑 git。
3. 测试：投影排除工具调用与输出；嵌套 `</untrusted-content` 被转义；`sk-` 开头的密钥被打码；可见性过滤；ssh 项目没有 git 字段；分页。
4. 不做：写操作。

### U5a 授权、自主度与提案状态机（纯逻辑）

1. 目标：设计稿「自主度与可操作范围」「确认卡片的状态」写成纯函数。完成判据：测试覆盖完整矩阵与全部状态转移。
2. 文件：新建 `src/shared/secretary/policy.ts`：
   ```ts
   export function dispatchDecision(profile: SecretaryProfile, projectId: string): 'direct' | 'direct-tell' | 'confirm';
   export function canOperate(file: SecretaryDispatchFile, conversationId: string): boolean;
   export function transitionProposal(
   	proposal: SecretaryProposal,
   	action: { type: 'confirm' } | { type: 'reject' } | { type: 'expire' } | { type: 'finish'; ok: boolean; error?: string; conversationId?: string },
   	now: number
   ): { proposal: SecretaryProposal; changed: boolean };
   export function validateDispatch(draft: DispatchDraft, ctx: {
   	project?: ProjectAuthority; visible: boolean; running: number; max: number; worktreeMode: SecretaryProfile['dispatchWorktree'];
   }): { ok: true; draft: DispatchDraft } | { ok: false; error: string };
   ```
   只允许 `pending → executing | rejected | expired` 与 `executing → succeeded | failed`；其余返回 `changed: false`。24 小时过期。`worktreeMode` 为 `never` 时强制 `worktree: false`，为 `always` 时强制 `true`。
3. 测试：3×2 自主度矩阵；重复确认第二次 `changed: false`；过期；重新校验的每种失败原因（项目被删、变成 ssh、不可见、达到上限）。
4. 不做：IO。

### U5b 派活工具、确认卡片与点名授权

1. 目标：秘书能派活、发消息、停止，确认卡片在聊天与工作台都能处理，点名授权生效，每个写操作进 `audit.jsonl`。完成判据：测试通过；真机走通“派活 → 卡片确认 → 会话出现在项目下”，两端同时点确认只建一个会话。
2. 文件：
   - 新建 `src/main/services/secretary/dispatch.ts`：`session_create`、`session_send`、`session_stop`、`todo_item_add`、`todo_item_update`、`todo_item_dispatch`。
     - `session_create` / `todo_item_dispatch`：`validateDispatch` → `dispatchDecision`。`confirm` 写提案并返回 `{ status: 'awaiting_confirmation', proposalId }`；否则直接 `createSessionFromMain`，记 `DispatchRecord`（`driver: 'main'`，`secretaryOrigin`），返回 `{ status: 'created', conversationId }`。
     - `session_send`：`canOperate` 不通过即拒；`observedSessionStatus` 有待审批或待回答时拒绝并返回 `needs-user`；运行中把 `{ id, text }` 追加到行的 `queuedMessages`（经 U1 入口）；空闲且活着时直接 `promptRootFromMain`；worker 已释放时先按 `planPairResume`（`src/shared/pair/headlessResume.ts`）恢复再发。
     - `session_stop`：`abortSession`；有目标则置为暂停。
     - 确认处理 `resolveProposal(id, action, edits)`：先 `transitionProposal` 到 `executing` 并落盘，成功的那一次才执行；执行前 `validateDispatch` 重新校验；结束写 `succeeded` / `failed`，往 `outbox` 追加一条 `proposal` 更新（注入在 U6a）。
   - `src/main/ipc/secretary.ts`：`SECRETARY_GET_STATE`、`SECRETARY_STATE_CHANGED` 推送、`SECRETARY_RESOLVE_PROPOSAL`、`SECRETARY_REFERENCE_CONVERSATIONS`（逐个校验：权威存在、根会话、不是 bot、不在秘书项目、项目可见；只接受秘书会话发起；通过的加入 `named` 并审计）、`SECRETARY_TODO_MUTATE`。
   - renderer：新建 `src/renderer/stores/secretary.ts`（`get-state` + 推送）；新建 `src/renderer/components/secretary/SecretaryProposalRow.tsx`，在 `TimelineRow.tsx:2221` 分派；`mentionComposer.ts`、`MentionEditor.tsx:132, 479`、`Sidebar.tsx:2268, 2305`、`dragDrop.ts:30` 带 `conversationId`；`ChatView.tsx:568` 在秘书会话里发送前调用点名 IPC（D2）。
3. 测试：新建 `src/main/services/secretary/dispatch.test.ts`（假 ports）：先问我时总是出提案；派完告诉我且在免确认项目时直接建；达到上限报错；非派出且未点名的会话拒绝发送；有待审批时拒绝；运行中进队列；同一提案确认两次只执行一次；重新校验失败记 `failed` 并给原因；每个写操作写一行审计。`src/main/ipc/secretary.test.ts`：点名拒绝 child、bot、不可见项目、非秘书发起方。`src/renderer/components/chat/mentionComposer.test.ts`：`conversationId` 从段带到 payload，wire 文本不变。提案卡片组件用 `renderToStaticMarkup` 断言各状态的文案与按钮。
4. 风险：确认的并发执行，靠“先落盘再执行”。不做：回传注入（U6a）、目标续跑（U5c）、工作台面板（U9）。

### U5c Main 驱动派出会话的队列与目标

1. 目标：带 `goal` 的派出会话由 Main 续跑到完成、受阻或触发安全限制，renderer 打开它时不再续跑；排队消息由 Main 投递。完成判据：测试通过；真机里派一个带目标的会话，桌面与 PWA 都打开它，jsonl 里每轮只有一条续跑消息。
2. 文件：
   - `src/renderer/stores/sessions/index.ts`：`Conversation` 加 `driver?: 'main'`、`secretaryOrigin?`；`flushQueue`（:2165）与 `continueGoal`（:2085）对 `driver === 'main'` 直接返回；`setGoal` / `pauseGoal` / `resumeGoal` / `clearGoal`（:3818 起）改调 `secretary:goal-action`。
   - 新建 `src/main/services/secretary/driver.ts`：`DispatchDriver`。`goal-signal` 用 `applyHeadlessGoalSignal` 改行的 `goal`；`turn-completed` / `turn-failed` 时，从行的 `queuedMessages`、`goal` 与 `observedSessionStatus` 的计数拼出 `HeadlessSessionRuntime`，调 `onHeadlessIdle`，回写行，再 `promptRootFromMain`。补上 renderer 有、`headlessQueue` 没有的“连续 3 次无进展暂停”，用 `turn-completed` 的 `digest.assistantText` 比对（照 sessions/index.ts:2110-2128）。首条消息为 `prompt` 加 `goalKickoffText(goal)`。订阅 `onConversationsMerged`：空闲的 `driver: 'main'` 会话出现排队消息时立即投递。
   - `src/main/services/pairSessionHost.ts:377` 与 `seedRuntimes` 跳过 `driver === 'main'`。
   - `src/main/ipc/secretary.ts`：`SECRETARY_GOAL_ACTION`。
3. 测试：新建 `src/main/services/secretary/driver.test.ts`：续跑直到 `complete`；`blocked` 停止；25 轮暂停；3 次无进展暂停；排队消息先于续跑投递；aborted 轮不续跑；有待审批不续跑。renderer 端在现有 goal 测试文件（`grep -rln "continueGoal\|goal-continuation" src/renderer --include=*.test.ts`）补 `driver: 'main'` 不续跑、不泵队列。`pairSessionHost` 测试补跳过用例。
4. 风险：双驱动重复投递，见风险第 2 条。不做：结果分类与回传。

### U6a 回传

1. 目标：派出会话的结果按设计稿七种类型分类，聚合后注入秘书会话，有去重、批量上限、成功判定和有限重投。完成判据：测试通过；真机里派出会话结束后，秘书在没有用户输入的情况下收到 `<session-updates>` 并转告。
2. 文件：
   - 新建 `src/main/services/secretary/results.ts`（纯函数）：`classify(record, event, status, now): SecretaryResultKind | null`；`stalled(records, statuses, now)`（运行中、10 分钟无事件、该轮未报过；`waiting` 优先于 `stalled`，worker 退出算 `failed`）；`updateKey(conversationId, kind, turn)`；`takeBatch(outbox, { max: 20, maxChars: 12_000 })`；`formatSessionUpdates(batch)`（`lastText` 先脱敏再包 `<untrusted-content>`）。带目标的会话，轮次结束不报 `turn-ended`。
   - 新建 `src/main/services/secretary/deliveries.ts`：目标秘书会话解析（发起者 → 已归档或删除时取最近活跃的秘书会话 → 都没有时只更新工作台）；目标空闲时注入；跟踪 `delivery-settled` 与随后的轮次结束；失败重投，间隔 `30s × 2^(attempt-1)`，最多 6 次，用完只留工作台。`outbox` 与 `inflight` 存在 `dispatch.json`。
   - 新建 `src/main/services/secretary/host.ts`：`SecretaryHost.onAgentEvent(event, changes)`、每分钟定时器（停滞、重投、提案过期，`unref`）、启动恢复（`lastState: 'running'` 的记录报 `interrupted`；在途批次查 `StartedDeliveryIndex`）、按 `profile.notify` 发系统通知（经 `notifyDesktop()`，server 壳为 noop）、推送状态。
   - `src/main/ipc/agent.ts:272` `broadcastAgentEvent`：`observe` 只调一次，结果交给 `publishPluginSessionStatus` 与 `getSecretaryHost()?.onAgentEvent`。
   - 工作台投影 `buildBoard(file, rows, statuses)` 放在 `results.ts`，与 `session_list` 共用数据源。
3. 测试：分类表逐条；`waiting` 不报 `stalled`；worker 退出报 `failed`；同一轮只报一次 `stalled`；去重键；20 条与 12k 字符的截断；只有正常结束才算成功；重投间隔与 6 次上限；改投规则；重启后 `interrupted`；重启后已开始的投递不重发。
4. 风险：秘书自己正在忙时一直不空闲，回传堆积。批次上限与工作台兜底。不做：定时。

### U6b 定时

1. 目标：`schedule_add`、`schedule_list`、`schedule_remove` 可用，到点后消息进回传队列。完成判据：测试通过；真机里加一个两分钟后的一次性定时，秘书按时收到 `<secretary-schedule>`。
2. 文件：新建 `src/main/services/secretary/schedules.ts`：`at`（ISO）与 `cron` 二选一；cron 用 `src/shared/bots/cron.ts` 的 `parseCron` / `nextRun`，也接受 `src/shared/bots/routineSchedule.ts` 的 `parseScheduleText` 短语；到点往 `outbox` 追加 `schedule` 更新，一次性任务随后删除；启动时补投错过的一次性任务一次，cron 不补；`syncSystemSchedules(profile, todos)` 生成每日简报与待办到期提醒。IPC `SECRETARY_SCHEDULES_LIST` / `SECRETARY_SCHEDULE_REMOVE`。
3. 测试：假时钟下一次性与 cron 的触发、错过补投规则、系统定时随 profile 与待办变化。
4. 不做：scheduler 插件的任何集成。

### U7 配置与初次设置

1. 目标：表单与对话两条路径都能完成初次设置，之后可修改、可重来，PWA 可用。完成判据：测试通过；真机（桌面与 PWA）首次点秘书入口看到欢迎页，两条路径各走一遍，`profile.json` 内容正确。
2. 文件：
   - `src/main/ipc/secretary.ts`：`SECRETARY_GET_PROFILE`、`SECRETARY_SAVE_PROFILE`、`SECRETARY_RESET_PROFILE`（`{ clearMemory: boolean }`）、`SECRETARY_SET_AVATAR`。保存后的副作用：`syncSystemSchedules`；模型变化时经 U1 入口改秘书会话行的 `lastProviderId` / `lastModelId` / `thinkingLevel`，并对活着的会话 `setSessionModel`（agentHost.ts:1433）；名字或人设变化时对空闲的秘书会话 `releaseParentSession`（:1893），运行中的在本轮结束后释放，下次发送按新提示词恢复。
   - `secretary_profile_propose`：提案 `kind: 'profile'`，确认后写入，同一套状态机。
   - 头像：`src/shared/localImage.ts`、`src/main/services/localImageProtocol.ts:85`。
   - 清空私有记忆：在 `src/main/services/memory/store.ts` 加按空间删除的函数（没有现成的），带测试。
   - renderer：`constants.ts:4` 加 `'secretary'`；`settingsCategories.ts` 按开关显隐；`SettingsContent.tsx:174, 346`；`src/shared/settingsDeepLink.ts`；`searchAnything.ts` 条目；新建 `SecretarySettings.tsx`（表单、定时列表、重来）、`SecretaryProfileForm.tsx`（三步，欢迎页、设置页、提案卡片的“就地修改”共用）、`SecretaryWelcome.tsx`（挂在 `App.tsx:665`）。秘书 store 加 `newSecretaryConversation()`：`newConversation(secretaryProjectId)` 后按 profile 设模型，再按 D5 发引导语。
3. 测试：`parseProfile` 默认值与坏输入；保存拒绝非法自主度；提案确认写入、拒绝不写；表单步骤的纯 reducer；`settingsCategories` 显隐；重来时可选清空记忆。
4. 不做：接入配置 CLI（设计稿明确不接）。

### U8 记忆

1. 目标：秘书可读写私有空间，只读检索全局和可见项目空间，校验在记忆服务里。完成判据：测试通过；真机里秘书写记忆落在私有空间，写全局被拒。
2. 文件：`src/main/services/memory/space.ts`（结论 11）；`src/main/services/memory/bridge.ts`（写入限制；非私有空间的检索结果 `redactSecrets` 后标 `untrusted`）；`src/main/ipc/agent.ts:1688` 对秘书会话传 `{ projectId: secretaryProjectId, secretary: { readProjectIds } }`，`readProjectIds` 为 profile 可见的本地项目。
3. 测试：`space.test.ts` 与 `bridge.test.ts`：capture 到 global 被拒；`project` 落私有空间；`all` 只含可见项目；删项目记忆被拒；检索结果脱敏。
4. 不做：记忆面板 UI（U9）。

### U9 界面

1. 目标：侧栏伪项目行、折叠图标、快捷键、工作台、记忆面板、“由秘书派出”标记、会话引用跳转全部可用。完成判据：组件测试通过；真机截图对照设计稿侧栏示意；PWA 下工作台就地确认后桌面卡片同步变化。
2. 文件：
   - 新建 `src/renderer/components/secretary/SecretarySidebarSection.tsx`，插在 `Sidebar.tsx:939`；折叠图标插在 :859；行内只有 ＋ 与 ⚙，右键只有这两项加“重新设置秘书”；未设置时点击打开欢迎页；“需要你处理”数取自 `board.needsYou.length`。
   - `src/renderer/lib/keybindings.ts`：`KEYBINDING_ACTIONS`、`DEFAULT_KEYBINDINGS`、`ACTION_LABEL_KEYS` 加 `openSecretary`。
   - 右侧面板：`src/shared/types/sidePanel.ts`、`SidePanel.tsx:672` 加 `secretaryBoard` 与 `secretaryMemory` 组件、`sidePanelDock.ts` 加 `addSidePanelSecretaryBoard` / `addSidePanelSecretaryMemory`；秘书会话里隐藏终端、文件、改动的入口（`SidePanel.tsx` 的新建菜单约 :540-580，以及 `App.tsx:331` 的终端快捷键）。
   - 新建 `SecretaryBoardPanel.tsx`（分组顺序固定，“已完成”默认折叠；就地审批复用现有审批与提问组件和 IPC，跳转用 sessions store 的选择动作，停止用 `agent.abort`）与 `SecretaryMemoryPanel.tsx`（复用 `MemoryLibrary.tsx` 的 `MemoryRows`，按私有空间过滤）。
   - `Sidebar.tsx` 的 `ConversationRow`（:2390）按 `secretaryOrigin` 显示“由秘书派出”。
   - 引用跳转：秘书消息里的 chat 引用卡片按 `sessionFile` 在会话表里查到会话后选中。
3. 测试：分区不受分组标签影响；未设置时显示默认名“秘书”；快捷键默认值；工作台分组渲染。
4. 不做：手机精简视图。

### U10 验收

1. 目标：至少两家厂商的模型在桌面和 PWA 各走通“问进展 → 派活 → 确认 → 回传 → 转告”。完成判据：验证脚本通过，截图与 `audit.jsonl` 存档在本地；删除 `SECRETARY_DEV_CREATE_SESSION`。
2. 文件：`scripts/verify-secretary.mjs`（见下节）；删除 dev IPC 及其 preload 出口与覆盖登记。
3. 不做：新功能。

## 依赖与并行

| 单元 | 依赖 | 主要文件集 | 难度 |
| --- | --- | --- | --- |
| U0 | 无 | settings 相关 | 易 |
| U1 | 无 | conversationSync、settings.ts、storage.ts、sessions store 补丁 | 难 |
| U3c | 无 | shared/types/secretary、services/secretary/store、audit | 易 |
| U2 | U1 | services/secretary/sessionFactory、agent.ts 抽函数、worktree.ts 抽函数 | 难 |
| U3a | U0 | registry、ProjectKind、各 scratch 过滤点 | 中 |
| U3b | U3a | agent/tools/secretary、supervisor、agentHost、shared/types/agent | 难 |
| U4 | U3b、U3c | readers、transcript | 中 |
| U5a | U3c | shared/secretary/policy | 中 |
| U5b | U2、U4、U5a | dispatch、ipc/secretary、提案卡片、mention | 难 |
| U5c | U1、U2、U5b | driver、sessions store 续跑、pairSessionHost | 难 |
| U6a | U5c | results、deliveries、host、agent.ts:272 | 难 |
| U6b | U6a | schedules | 中 |
| U7 | U3a、U5a、U6b | profile IPC、设置页、欢迎页 | 中 |
| U8 | U3b、U3c | memory/space、bridge | 中 |
| U9 | U5b、U6a、U7 | 侧栏、右侧面板 | 中 |
| U10 | 全部 | 脚本 | 中 |

可以并行的批次（文件集不重叠）：

1. U0、U1、U3c。
2. U2、U3a、U5a。
3. U3b，之后 U4 与 U8 并行。
4. U5b，然后 U5c，然后 U6a。
5. U6b 之后 U7；U9 最后，再 U10。

U3a、U3b、U5b、U9 都会碰 `src/shared/types/agent.ts` 或 `Sidebar.tsx`。同一批次里不要让两个单元同时改同一文件。

## 真机验证脚本思路

环境照 `.agents/skills/enso-cdp/SKILL.md`，不碰真实 userData：

```bash
node .agents/skills/enso-cdp/scripts/mk-env.mjs /tmp/enso-sec 2
node scripts/fake-provider-issue-27.mjs        # 后台运行；8899，回复里写 [[tool:name {json}]] 让模型确定地调用工具
ENSO_USER_DATA_DIR=/tmp/enso-sec ENSO_CDP_PORT=9333 pnpm dev   # 后台运行
lsof -nP -iTCP:9333 -sTCP:LISTEN                # 确认端口属于隔离实例
ENSO_CDP_PORT=9333 node .agents/skills/enso-cdp/scripts/cdp.mjs eval '(async()=>{ ... })()'
```

dev 下 CDP 端口由 `src/main/index.ts:79` 打开，`ENSO_CDP_PORT` 可改。`scripts/verify-secretary.mjs` 复用 `cdp.mjs` 的连接方式，按步骤断言：

1. U1：eval 调 dev IPC 建会话，不刷新页面，读 `useSessionsStore` 断言新行存在；立刻触发一次 sessions store 写回，再读 `settings.json` 断言行仍在。
2. U2：建会话后立即选中并发第二条消息；断言 `agent.requestSnapshot` 回来的该会话只有一个 generation，`userData/agent/sessions` 下只有一个对应 jsonl。
3. 派活：用 fake provider 让秘书调用 `session_create`；断言聊天里出现提案卡片；点确认；断言会话出现在目标项目下、带“由秘书派出”。
4. 回传：fake provider 让派出会话结束一轮；断言秘书会话出现 `<session-updates>` 的 user 消息，且 `dispatch.json` 的 `outbox` 清空。
5. 两端并发：桌面与 PWA 同时 eval 确认同一提案，断言只建出一个会话，`audit.jsonl` 只有一条执行记录。

PWA 完整模式：桌面 dev 实例经 relay-dev 配对（做法见 `docs/project-history/2026-10-03-bot-mode-design.md:715`），在 Chrome 打开完整模式时加 `--remote-debugging-port=9334`，同一脚本以 `ENSO_CDP_URL=http://127.0.0.1:9334` 再跑一遍。

真实模型验收（AGENTS.md 要求两家厂商）：把隔离环境的 provider 换成真实凭证，分别用两家模型跑第 3、4 步。工具调用参数的归一化在这一步最容易出问题，失败时先看 `prepareArguments`。

## 主要风险

1. U1 的账本出错会丢用户会话，影响面是所有会话，不只秘书。确认号必须与值同时捕获；多窗口回归必须真机验证。
2. 派出会话的投递只能有一个驱动方。renderer leader、`pairSessionHost` headless 与 Main 驱动三方都可能在轮次结束时投递。靠 `driver: 'main'` 一处标记让另外两方让出，三处都要有测试。
3. 白名单泄漏。核心工具不在分组里，运行时开关会按分组加回名字，codemode 走扩展。三处都要在 worker 里按名字兜底，回归测试覆盖。
