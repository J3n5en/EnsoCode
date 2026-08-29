# 设计：重启后回放 coworker child 历史

## 已拍板的三个方向

| 问题 | 决定 | 理由 |
| --- | --- | --- |
| 谁读 safe journal | **Main 读取并投影** | child 早已不在 worker 里；走 Main 不需要新造 worker 命令，也不用复活会话 |
| 恢复成什么 | **只读历史**，不可继续对话 | 复活活 session 会牵动 generation 语义、容量计数与能力授权；旧 generation 不该重获执行权 |
| 保真度 | **接受与原始 TAB 的差异** | R10 原文要的就是「此前回复与**完整已脱敏** receipt」，safe journal 正好对口；要求完全一致需要 child 另写一份 pi session，属另一套持久化策略 |

## 现状盘点（已存在，不用重造）

- `EnsoSafeJournal.restore(file) -> SafeJournalProjection` —— 读取 + 逐行容错（坏行记 `partial`）
- `SessionSnapshot.safeJournal?: SafeJournalProjection` —— 快照类型**已预留槽位但从未被填充**
- `parseSafeJournalProjection` —— 解析器已在 `shared/types/agent.ts`
- child 会话在 settings 里持久化了 `sessionFile`（指向 safe journal），重启后 TAB 也在

缺的只有一条：**从「磁盘上的 journal」到「渲染层 child TAB 时间线」的投影通道**。

## 安全边界（本任务最关键的部分）

### 路径必须由 Main 推导，渲染层只给 conversationId

```
Renderer                 Main
  conversationId  ─────►  persistedConversation(conversationId).sessionFile
                          ↓ 校验：解析后必须落在 userData/agent/sessions 内
                          ↓ 校验：文件名前缀必须是 enso-（只读 safe journal，不碰 pi session）
                          EnsoSafeJournal.restore(file)
  SafeJournalProjection ◄─
```

**绝不接受渲染层传来的路径**。理由：那等于开放任意文件读取。
路径来自 Main 自己读的 `settings.json`（`enso-conversations`），是权威源。

渲染层持久化时会清掉 `generation`，本来也拼不出文件名（`enso-<sessionId>-<generation>.jsonl`），
这正好强制了上面的方向。

### 不放宽任何既有守卫

- 这是**纯读路径**，不 spawn、不注册 capability invocation
- `persistedRootSpawn` 对直接 child spawn 的拒绝保持原样
- 回放不进 `agentSessionIndex`，因此**不占容量**、不影响 5 个存活实例的计数
- 回放出的 TAB 不获得任何可执行权限；旧 generation 依旧无法调用能力

## 投影规则（纯函数，放 shared）

`projectSafeJournal(records) -> { messages, customEntries }`

| SafeJournalRecord | 投影为 |
| --- | --- |
| `safe-user-text` | `ProjectedMessage { role:'user', content:[{type:'text'}] }` |
| `safe-assistant-text` | `ProjectedMessage { role:'assistant', content:[{type:'text'}] }` |
| `capability-receipt` | `AgentSessionCustomEntry { kind:'capability-receipt', receipt }` |
| `enso-operation` | 丢弃（内部关联用，对用户无信息量） |
| `safe-model-result` | 丢弃（其结论已体现在 receipt 与助手回复里） |

放 `src/shared/` 的理由：纯数据变换、无 IO，Main 与 Renderer 都可能用，且便于单测。

## 通道（三点式）

| 位置 | 内容 |
| --- | --- |
| `IPC_CHANNELS.AGENT_CHILD_HISTORY_READ` | `'agent:child-history-read'` |
| `src/main/ipc/agent.ts` | handler：查持久化会话 → 校验路径 → restore → 返回 projection |
| `src/preload/index.ts` | `agent.readChildHistory(conversationId)` |

请求/响应：

```ts
// 请求：只有 conversationId，没有路径、没有 generation
{ conversationId: string }

// 响应
| { ok: true; projection: SafeJournalProjection }
| { ok: false; code: 'not-found' | 'unavailable'; error: string }
```

## 渲染层触发时机

在 `selectTab` 选中一个 child TAB 时惰性加载，条件全部满足才发请求：

- 该会话 `parentId` 存在（是 child）
- `started !== true`（不是活会话，活的走正常事件流）
- `messages.length === 0`（没加载过，避免重复请求）
- 未被标记为已尝试过（失败也不重试，防止反复打 IPC）

加载结果写入该 child 会话的 `messages` / `customEntries`，并置 `historyOnly: true`。

## 只读的表达

`historyOnly` 的 child 会话：

- `send()` 直接返回明确文案（当前是「coworker not restored yet — resume the conversation first」，
  对已结束实例是误导），改为说明该实例已结束、历史只读
- 不改 ChatView 的既有禁用逻辑，避免扩大改动面

## 验证矩阵

| 条件 | 结果 |
| --- | --- |
| child 有 journal 且完好 | 返回 records，`partial:false` |
| journal 有坏行 | 返回可解析部分，`partial:true`，渲染层照常展示 |
| 文件不存在 | `{ ok:false, code:'not-found' }`，TAB 保持空且不反复重试 |
| conversationId 不是持久化 child | `{ ok:false, code:'not-found' }` |
| 解析出的路径不在 sessions 目录内 | `{ ok:false, code:'unavailable' }`（防穿越） |
| 文件名不以 `enso-` 开头 | `{ ok:false, code:'unavailable' }`（不读 pi session） |
| 活着的 child | 不触发本路径（走正常事件流） |

## 不做

- 不让回放出的 TAB 可继续对话
- 不给 child 另写 pi 完整 session 文件
- 不改 safe journal 的写入格式（回放要能读老数据）
- 不碰容量计数与 capability 授权
