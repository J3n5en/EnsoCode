# 状态管理规范

两个主 store：设置持久化的 `stores/settings/` 与会话元数据持久化的 `stores/sessions/`。右侧面板另有 `stores/sidePanel/`：dock 布局与各会话的开关/宽度/Changes 模式 persist 到 localStorage，`fullscreen`、`browserHoles` 只活在内存里。

`snapshotsByConversation`（Changes「Session」模式的编辑前全文）也是运行态：按会话 `loadSnapshots` 惰性从主进程回读，
`saveSnapshots` 写内存 + IPC 落盘。会话键不存在 = 尚未回读，此时 `ChangesView` **不得聚合也不得保存**——否则用当前磁盘
内容 reconstruct 出的 old 会盖掉磁盘上更早的快照；回读失败要标成已加载（空），不然面板永远空白。
为什么不能 persist 见 [../main/settings-persistence.md](../main/settings-persistence.md) “不适合放这里的数据”。

```
stores/settings/
  types.ts     SettingsState：数据字段 + 全部 action 的签名
  storage.ts   electronStorage：persist 的 IPC 存储适配器
  index.ts     create + persist + 副作用
stores/sessions/
  reducer.ts   applyAgentEvent：agent 事件 → 会话投影的纯函数（seq 单调守卫）
  index.ts     create + 元数据 persist + onAgentEvent 订阅 + spawn/send/abort
```

`sessions` 的正文是**可丢弃投影**（权威源在 worker/jsonl）；会话元数据写入
`settings.json` 的 `enso-conversations`。正文、customEntries 和可由 worker 重建的
commands 不持久化，commands 仍由 snapshot / commands 事件恢复到内存。
消息按 `message-upsert` 的 index 整条替换，**没有增量归并**；
过期 seq 的事件在 reducer 里丢弃。改事件处理逻辑时改 `reducer.ts`（纯函数，有测试），
不要把逻辑写进订阅回调。

完整模式和桌面窗口共用 `enso-conversations`，但多端合并补丁不含 `activeId`。
远程界面的当前会话记在本机 `localStorage`（`remoteActive.ts`），不要把 `activeId` 加进共享补丁。

## 加字段的完整流程

漏掉任何一步都会出问题：

1. `types.ts` 的 `SettingsState` 加字段和 action 签名（带中文注释说明约束）
2. `index.ts` 的 `initialState` 加默认值
3. `index.ts` 的 create 里实现 action
4. 有副作用（主题、字体、语言）→ 同时写进 `applySettings()`，
   否则多窗口同步时另一个窗口不生效
5. 会被主进程读取（去重比对）→ 同步 `src/main/services/assetScan/index.ts` 的 `existingKeys()`

## 手机目录的 provider 口径

`pairCatalog` 下发给手机的「模型服务」必须与桌面聊天选择器同一套可用判定：启用 + 凭证真实可用 + 启用模型（`usableProvidersForOauthSnapshot`）。

订阅条目的凭证是 `oauthAccountKey`，`apiKey` 为空。只认 `apiKey` 会把已登录订阅全部滤掉，手机新建会话就只剩 API-key 服务。OAuth 快照从未 ready 到 ready 也要重新推目录，否则登录完成后手机仍看不到订阅。

密钥、baseUrl、oauthAccountKey 仍只留在 renderer / main，不下发手机。

## 订阅要选片，不要整取

```tsx
// 正确：只在 providers 变化时重渲染
const providers = useSettingsStore((state) => state.providers);
const updateProvider = useSettingsStore((state) => state.updateProvider);

// 错误：任何设置变化都会重渲染
const { providers, updateProvider } = useSettingsStore();
```

## 批量新增返回实际数量

导入类 action 内部去重，返回**真正新增的条数**，让界面能如实反馈
（"已导入 37 项"而不是"已导入 59 项"）：

```ts
addSkills: (skills) => {
  const knownNames = new Set(get().skills.map((s) => nameKey(s.name)));
  const fresh = skills.filter((skill) => { /* 判重并累积 */ });
  if (fresh.length > 0) set((state) => ({ skills: [...state.skills, ...fresh] }));
  return fresh.length;
},
```

去重的身份定义各不相同，见 [../main/services.md](../main/services.md) 的去重表。
主进程扫描时已经标记过重复，store 这层是最后一道 —— 两处都要有。

## 删除要清理外部资源

`removeInstruction` 除了改 state 还要删掉磁盘上的本地副本：

```ts
removeInstruction: (id) => {
  // 只删本地副本，源文件不动
  void window.electronAPI.instructions.delete(id);
  set((state) => ({ instructions: state.instructions.filter((i) => i.id !== id) }));
},
```

新增「有外部落地物」的实体时照此处理，别让文件残留。

## 拒绝要赶在乐观回显之前

`sessions.send()` 会先把用户消息乐观上屏再发给 worker。任何“这条压根不会发出去”
的判断（会话已结束、只读历史、无可用模型……）必须放在乐观回显**之前**，
否则会往时间线里插一条幽灵消息 —— 只读历史被污染后重启还会消失，更难查。

写测试时，**只断言错误文案会放过这类 bug**（文案是对的，消息也进去了）。
必须同时断言消息数不变：

```ts
const before = store.getState().conversations.ended.messages.length;
const error = await store.getState().send('...', target);
expect(error).toContain('read-only');
expect(store.getState().conversations.ended.messages).toHaveLength(before);
```

## 乐观回显不算「有正文」

正文冷缓存清空后靠 `snapshot` 补回，门控必须用 `hasAuthoritativeMessages()`，
不能用 `messages.length === 0`——用户先发一句就会把门关死，之后 worker 的
`message-upsert` 全部越界丢弃，时间线永久空白（见
[big-question/optimistic-echo-blocks-snapshot.md](../big-question/optimistic-echo-blocks-snapshot.md)）。
同理，任何「本地是否已有数据、要不要去拉」的判断都要过滤 `optimistic` 条目。

## 乐观回显的收回：文本匹配 + 投递回执

回显先按文本匹配被同文 user upsert 消费（`sameUserText`，已覆盖 `<role>` 前缀、
`/skill:` 展开、图片缩放提示、超长正文截断）。worker / pi 任何新的正文改写都会让
匹配失效，回显滞留在尾部：`chatTimelineBusy` 恒真，三点 loading 不停、回复被挡在回显之上，
重启从 jsonl 重读才恢复。兜底是 `deliveryId` 回执：renderer 随 prompt/steer 下发
`deliveryId`，worker 按 pi 投递顺序（新 prompt 自身的 user 消息先于滞留 steer）配对，
user upsert 之后发 `delivery-settled`，reducer 按 id 收回。worker 里所有注入 user 消息的
调用都必须走 `promptTracked` / `steerTracked`，否则队列错位。

侧栏 Files 按会话常驻（`mountedIds` 只增不减）。`evictColdMessages` 会把隐藏会话的
`messages` 置空；此时对时间线做「已见 write」占位，会把空数组当成权威历史。
之后 snapshot / tail 回填会把每一条历史 write 当成新文件，整树展开。
这类 seen-set / 时间线 diff **必须等权威正文再占位**，冷清空时把 seen 重置为
`null`，不要写成空 `Set`。

`buildTimeline` 的 tool `key` 是本地数组下标（`${messageIndex}-${partIndex}`）。
`historyBaseIndex` 从 tail 切到全文 snapshot 时同一条 write 的 key 会变，seen
必须随 `historyBaseIndex` 清掉重占位，否则会误刷新。

## lastOutputAt 只认可见进展

「无输出则停止」和运行中「距上次返回」都读 `lastOutputAt`。写入点在 `reducer.ts`：

- 生成心跳：新增非空 assistant `text` / `thinking`、新的工具结果、变化的非空 `tool-output`、变化的 write/edit 可见预览。
- 不刷新：用户消息、空 assistant（含 Connection error）、空 thinking、静态 toolCall、越界 upsert、递增 seq 但可见内容不变的全量快照。
- write/edit 必须复用时间线的 `extractWriteContent` / `extractEdits`；edit 比较 oldText/newText 对，不比较键顺序或多余 metadata；空 old/new 占位不算，删除算。
- task/subagent/approval 等可见状态进展沿用独立事件处理。watchdog 只把等人（审批 / 提问）和 coworker spawning 当豁免；静默 subagent、coworker 及无截止时间的工具按 `lastOutputAt` 计时。父会话等 coworker 时心跳取自身与 running 子会话的较新值。
- 前台 bash / powershell 有生效超时：worker 在工具起点的 `tool-output` 带 `deadlineAt`，renderer 记入 `toolDeadlineAt`，心跳取 `max(lastOutputAt, 未收口工具截止)`。静默长命令不被误杀，豁免有上限；不要改回无界的「有工具在跑就豁免」。

越界 `message-upsert` 只推 `seq`。把丢弃的权威事件当成心跳，watchdog 会认为模型一直有输出。

冷会话（正文已被 `evictColdMessages` 清空）的 `message-upsert` 在 store 层就被跳过、不进 reducer，
但可见输出仍要续 `lastOutputAt`（`isVisibleGenerationOutput(message)`，无旧正文可比、按 5s 节流），
否则只做 LLM 文本 + read/grep 的后台会话零心跳，到点被 watchdog 误 abort。
同理 `continueGoal` 的无进展守卫在正文为空时回退到 `lastTurnDigest.assistantText`；
partial `snapshot` 恢复后要和 `turn-completed` 一样先 `flushQueue` 再 `continueGoal`（`abortRequested` 时不抢跑）。

`snapshot` 不是新输出：同代连续 running 保留 `runStartedAt` / `lastOutputAt` 与未完成工具尾巴；
首次/新代 running 以接收时间建立起点但不伪造输出。同代 idle/failed 结算 activeMs，显式清空时钟。
**不能只省略时钟字段**：store 浅合并投影会保留旧值。新代/终态清空 toolOutputs，同轮快照清掉已完成工具的旧输出。
toolResult upsert 落地时仍须删掉对应 `toolOutputs` / `toolStartedAt` / `toolDeadlineAt` key，避免 UI 残留已结束的流式尾巴、过期截止拖长计时。非空 `toolOutputs` 不再豁免 stall。

回归测试必须覆盖重复内容 + 更大 seq、historyBaseIndex 尾窗、快照前后重复 tool-output，以及 `{...old, ...projection}` 清理行为。

## 会话标题的自动总结守卫

标题自动总结（首条即时 + 每轮 `turn-completed{digest}` 滚动）在 `sessions/index.ts` 里有两层守卫，缺一不可：

- **在飞基准** `pendingTitleBaselines`（内存 Map）：发起时记下当时的标题，`title-generated` 回流时
  标题已不等于基准就丢弃；同一会话同时只允许一个在飞（第二个回合到来时跳过，不排队）。
- **手动锁** `Conversation.titleLocked`（随 `...conversation` 持久化）：`renameConversation` 置位并清基准，
  之后所有自动路径都跳过。跨重启生效，靶向「用户改过名就永远别动」。

resume 与否的判断**只能用调用点触发时刻的快照**（spawn 路径看 `!conversation.sessionFile`），
不得在通用函数里读 live `sessionFile`：`parent-ready` 常抢在 `spawn()` IPC 返回前落地，新会话此刻
已带 `sessionFile`，按它判断会把桌面首条总结整个误杀（commit `b829adc`）。

本轮摘要（用户请求 + assistant 结论）由 worker 在 `agent_end` 切出并挂在 `turn-completed.digest` 上，
renderer 只做门禁与发起——冷会话正文已被 `evictColdMessages` 清空、手机端会话可能没正文，
renderer 侧的 `messages` 不可依赖。

## 持久化边界

写入 `settings.json` 的内容由 persist 的 `partialize` 决定。因此：

- **大段文本不要进 store** —— 指令文件内容存 `userData/instructions/<id>.md`，
  store 只留元数据（`name` / `sourcePath` / `local` / `bytes`）。
- 临时 UI 状态（弹窗开合、筛选词、忙碌标记）用 `React.useState`，不要进 store。
- 驱动时间线 chrome 的在途标记必须进可订阅投影，不能只放模块级 `Set`。
  `olderHistoryInFlight` 挡连环请求，但 React 看不到；顶部 loading 要写
  `Conversation.historyLoading`（手机走 `onHistoryPending`）。
  `partialize` / `evictColdMessages` 必须剥掉，避免冷开或挤出缓存后顶部一直转圈。
- 字段的兼容性约束见 [../shared/types.md](../shared/types.md) 的"持久化类型的演进"。

高频会话事件使用 `createElectronPersistStorage()` 对象级入口，在 JSON 编解码和
contextBridge 复制之前合并写入；不能在 `createJSONStorage` 后再排队字符串。
同键最多一个在途写入及一个最新待写值。完整契约见
[设置持久化规范](../main/settings-persistence.md#会话流式持久化的内存上限)。

Zustand persist 即使收到 `set((state) => state)` 也会调用存储适配器。
已知无需更新的后台事件应在调用 `set` 之前返回，保留无标题首条用户消息的标题提取。

### persist 回灌不会补 `emptyProjection`

会话 store 没有自定义 `merge`：persist 把磁盘对象整段盖进内存。`emptyProjection`
只服务新建会话，旧盘（v1、`partialize` 补字段前）缺的运行态集合**不会**被默认值填上。
`applyAgentEvent` 入口会归一这些字段，但卡死巡检、设置订阅这类读点**不经过 reducer**。

因此形状变更必须同时做两件事：

1. `SESSIONS_VERSION` +1，在 `migrateSessions` 里按 `emptyProjection` 补空集合
   （缺或 `null` 才写空值，已有非空保持原样）。不要放 `onRehydrateStorage`，
   原因见 [../main/settings-persistence.md](../main/settings-persistence.md)。
2. 卡死巡检读 `pendingApprovals` / `pendingAsks` 一律经 `stallLiveWorkFlags` 容错（缺或
   `null` 当空），不要直接 `.length`。巡检不经 reducer，只靠 migrate 挡不住尚未回写的旧盘。

## 多窗口同步

store 末尾注册了 `settings.onChanged` → `persist.rehydrate()`。
这意味着**任何窗口的写入都会让其它窗口重载整个 store**。
写操作要幂等、要小、不要在 rehydrate 的副作用里再触发写入，否则会形成回环。

独立设置窗是**另一个渲染进程**，不是主窗口里的一层 UI。它会重新跑一遍
`initialState` + 异步 persist。任何发生在该窗口第一次 `settings:read` 成功前的
`setState`（包括模块加载时的 source-authority 投影）都会走 persist 落盘。
`electronStorage` 按 store 名挡住这次水合前写入；详见
[../main/settings-persistence.md](../main/settings-persistence.md)。
