# 技术设计：重启后 coworker 级联恢复与死 tab 修复

## 边界与所有权

| 关注点 | 归属 | 原则 |
|---|---|---|
| 级联恢复的触发与编排 | Main（新 `restoreChildren` 逻辑，挂在 `agentDispatchService` 或近旁） | 身份、路径、配置全由 Main 权威数据决定 |
| resume 的 sessionFile | Main `agentSessionIndex.persistedConversation()` | 渲染层永不传路径（沿用 08-29 铁律） |
| typed child 身份 | Main `reserveChild` 的 resume 变体 | 原 instanceId/instanceName/typeKey，新 generation |
| (c) 类 coworker 执行 | worker `SessionSupervisor.spawnCoworker/dismissCoworker`（现有） | Main 只新增两条窄命令做遥控 |
| tab 增删的唯一数据流 | worker 事件回流（`coworker-update`/`child-ready`） | 渲染层本地移除仅限「Main 判 not-found」的死 tab |

## 数据流

### R3 级联恢复

```
渲染层 resumeConversation(parentId)（现有，不改）
  → AGENT_SPAWN → spawnSession → worker parent resume
  → worker 发 parent-ready
  → Main setAgentEventListener（agent.ts:302 已特判 parent-ready）
      → restoreChildren(parentIdentity)   ← 新增，幂等（per parent generation 一次）
          1. persistedConversation(parentId).coworkerIds
          2. 逐个读 child 持久化：跳过 ended === true、跳过已在 sessions 索引且 alive 的
          3. 形状判定：持久化有 child metadata（ChildConversationMetadata）→ typed；否则 → legacy
          4a. typed：resolveAgentType(typeKey[, lockedProfileId])
                失败/已删/禁用 → 跳过（渲染层走只读回放，不降级）
                成功 → reserveChildResume(parent, metadata)   ← reservation resume 变体
                     → host.spawnChild(child, cwd, config, resumeFile=Main 侧 sessionFile)
                     → child-ready 握手（现有 observe 逻辑收编入索引）
          4b. legacy：sendAgentCommand({ type: 'resume-coworker', parent: exact identity,
                coworkerId, name, agentType?, resumeFile })
                → worker spawnCoworker(..., resumeFile)（现有，容量豁免已内建）
                → coworker-update 回流
  → 渲染层按单一数据流重建 tab（reducer 现有 generation 领养逻辑）
```

### R5 dismiss 降级链（Main handler）

```
AGENT_DISMISS_COWORKER(parentId, coworkerId, notify)
  1. parent = exactIdentity(parentId)，非 SessionIdentity → 拒绝（不变）
  2. child = exactIdentity(coworkerId)
     是 ChildSessionIdentity → dismiss-child（现路径，不变）
  3. 否则 sessions.get(parentId).coworkers.has(coworkerId)
     → sendAgentCommand({ type: 'dismiss-coworker', parent, coworkerId, notify })
  4. 都未命中 → { ok:false, code:'not-found' }
```

### R1 渲染层 dismiss 兜底

```
dismissCoworkerFromUI: await IPC 结果
  ok → 等 coworker-update 回流（不变）
  !ok 且 conversation 未 started 且未 spawning
     → 本地移除：删 conversations[coworkerId]、父 coworkerIds 过滤、
       activeTabId 命中则置 undefined（复刻 reducer dismissed 分支）
  !ok 且 started → 保持现状（真活着的 dismiss 失败不能静默吞 tab）
```

## 契约变更

### 新 worker 命令（shared 类型 + 解析器 + supervisor case，三方一致）

```ts
{ type: 'resume-coworker'; parent: SessionIdentity; coworkerId: string;
  name: string; agentType?: string; resumeFile: string }
{ type: 'dismiss-coworker'; parent: SessionIdentity; coworkerId: string; notify: boolean }
```
- supervisor 侧均先 `mustCurrent(parent)` exact generation 校验；resume-coworker 内部走现有 `spawnCoworker`（resumeFile 分支豁免容量、类型漂移降级 general 属现有语义，保留）；dismiss-coworker 走现有 `dismissCoworker`。
- 按 shared/types.md 规约：白名单解析、解析失败打 warn 不静默丢弃。

### reservation resume 变体（agentSessionIndex）

```ts
reserveChildResume(parent: SessionIdentity, metadata: ChildConversationMetadata):
  ChildReservationResult
```
- 复用容量检查（occupied >= 5 → capacity-reached，跳过该 child，不整体失败）；
- instanceId/instanceName/typeKey/lockedProfileId 取自 metadata，不重新生成；name 已被占（同名新 child 已存在）→ 失败跳过；
- generation = 新 uuid；dispatchOrigin 沿用持久化值。

### typed child resume 的 spawn

- `host.spawnChildSession` 已有 `resumeFile` 形参（agentHost.ts:324-338），当前无调用方传它——本次接通；
- worker `spawnTypedChild`（supervisor.ts:1168）容量检查加 `!resumeFile &&` 豁免，与 coworker 路径对齐；
- Enso locked：resolveAgentType 按 lockedProfileId 走 locked manifest；模型继承恢复后 parent 模型（§7.3，取 `sessionIndex.model(parent)`）。

### 新 IPC（R4）

```
AGENT_HIRE_COWORKER(parentConversationId, name, agentType?) → TeamOperationResult
```
- handler 守卫：`isMainWebContents(sender)` + source authority 会话为 root/active（仿 `persistedRootSpawn` 口径，agent.ts:115-125）；
- 转 `dispatchService.hireCoworker(parentConversationId, name, agentType)`（不传 guard，UI 直发无 Enso 取消语义）。

### 删除（R2）

- `AGENT_SPAWN_COWORKER` 常量、preload `agent.spawnCoworker`、main 墓碑 handler；
- 渲染层 `resumeConversation` 级联段（index.ts:1267-1290）、store `hireCoworker` 旧实现体（改为调新 IPC）。

### 持久化新字段（R6）

- `Conversation.ended?: boolean`：reducer 在 `child-ended`/`child-rejected` 置 true；
  `coworker-update`（非 dismissed）与 `child-ready` 领养新 generation 时清除；
  partialize 保留。仅 child 会话有意义，父会话不写。

## 兼容与迁移

- 存量持久化无 `ended` 标记：升级后首个重启把所有历史 child 当未结束恢复一次（Q1 拍板可接受；恢复失败/不想要的可关闭）。
- (c) 类历史回放缺口（非 safe journal）：本任务接受；tab 空历史 + 可关闭（Q4）。
- sessions store 若需 migrate 版本号递增，仅加字段不破坏旧数据，可不 bump（加字段是宽松扩展）；如 reducer 测试要求初始形状更新则同步 emptyProjection。

## 权衡记录

- **双形状保留**（Q2=A）：resume-coworker/dismiss-coworker 是过渡期遥控命令，统一到 typed child 后可删；两条命令数据全部 Main 侧取，不放松安全不变量。
- **legacy resume 的类型漂移降级 general** 与 typed 的「不得降级」不一致：这是 worker 现有语义（supervisor.ts:1287 注释明确是有意的），本次不改，避免范围蔓延。
- **级联失败策略**：单个 child 失败只跳过该 child（渲染层落回放/死 tab 可关），不影响父会话与其他 child——恢复是尽力而为，父会话可用性优先。

## 回滚

各 commit 独立可回滚；新 worker 命令与新 IPC 均为增量面，回滚即恢复现状（功能坏但不引入新风险）。`ended` 字段回滚后被忽略，无迁移债。
