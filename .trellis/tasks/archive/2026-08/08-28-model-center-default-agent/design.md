# 设计：typed `@AgentType` 确定性派发与子 Agent TAB

本文定义已经拍板的最终架构：聊天中的 typed Agent mention 是应用控制面；Main 确定性地在当前普通主会话下创建一个全新 child/coworker session、创建 TAB，并把任务首条 prompt 只投递给该 child。主 coding Agent 不判断是否派发、不接收原任务，也不自动吸收 child transcript。

模型中心统一入口、全局默认模型及验证墙安全修复仍在同一任务内；本文件只把 Agent 方向收敛到现有 coworker/child-session/TAB 机制。实现切片与文件独占见 `implement.md`，F01–F20 根修见 `temp/model-center-default-agent/p0-remediation.md`。

---

## 1. 边界与现状锚点

### 1.1 最小行为差距

当前实现把 `@Enso` 路由到全局 `builtin-agent:enso`，用独立 invocation sidecar、drawer、snapshot 与全局 Enso history 承载结果。目标改为：

- 候选是 Agent **类型**，不是已存在实例；
- 每次发送 typed `@AgentType` 都新建一个唯一 child 实例和 TAB；
- child 使用现有 `SessionManager.create/open`、`coworker-update`、`Conversation.parentId/coworkerIds/activeTabId` 与 jsonl 恢复；
- child 的回复、ASK、工具进度、receipt 都在自己的 TAB；
- 父会话只追加不进入 LLM context 的安全 custom entry：派发、完成、失败，以及 Enso receipt 的安全摘要；
- child 只有显式调用 `message_main_agent` 时，内容才进入主 coding Agent context。

### 1.2 直接复用的现有机制

| 机制 | 现有路径 / symbol | 复用方式 |
| --- | --- | --- |
| child factory | `src/agent/supervisor.ts` `SessionFactory.createChildSession` | 扩展为接收 Main 已解析的 type/profile 与 generation |
| coworker lifecycle | `SessionSupervisor.spawnCoworker` / `dismissCoworker` / `coworkerSend` | typed dispatch 走同一 ManagedSession 与事件流，不另造 runtime |
| 容量 | `MAX_ACTIVE_COWORKERS`、`src/main/services/agentSessionIndex.ts` `MAX_ORIGIN_COWORKERS` | 收敛成 Main 原子 reservation + worker 兜底，统一上限 5 |
| TAB | `src/renderer/components/chat/CoworkerTabs.tsx` | reserved/ready 事件创建并选中 placeholder/真实 TAB |
| Renderer 投影 | `src/renderer/stores/sessions/index.ts`、`reducer.ts` | child 继续作为 `Conversation.parentId` 子项，不建 sidecar store |
| jsonl | pi `SessionManager.create/open`、`CoworkerInfo.sessionFile` | child 自己持久化；父 resume 后按 metadata 级联恢复 |
| child → Main 显式消息 | `src/agent/messageMain.ts` `createMessageMainTool` | 保留；这是唯一主动进入主 coding Agent context 的 child 通路 |
| Main session truth | `src/main/services/agentSessionIndex.ts` | 扩展 parent generation、active child、reservation、type/profile metadata |

### 1.3 必须清除的旧产品合同

以下不再是产品面，也不留兼容 shim：

- 全局 `ENSO_SESSION_ID = 'builtin-agent:enso'` 与 `spawnBuiltinEnsoSession`；
- `AgentInvocationRouter` 的全局 Enso queue/workspace/history；
- `BUILTIN_AGENTS_INVOKE/EVENT/SNAPSHOT/ASK_RESPOND`；
- `ensoSnapshot`、`useAgentInvocationsStore`、来源 invocation cards；
- `EnsoHistoryDrawer`、独立 `AgentComposer`、独立 Enso OAuth/history host；
- `Ask Enso` 弹窗、独立输入、独立 history；
- 把 child 完整回合或 transcript 注入父模型的任何方案。

`enso_capabilities`、`enso_app`、Enso system prompt、capability catalog/Gateway 保留，但只作为 **Enso child 的 locked profile**。

---

## 2. 目标架构

```text
Composer typed mention
  @agent:enso | @builtin:<name> | @custom:<uuid>
          │
          │ request 只含 bindingId + typeKey + task + typed file refs
          ▼
Main AgentDispatchService
  1. sender/binding 权威校验
  2. 重读 Main AgentTypeRegistry
  3. 原子占用 parent coworker 容量
  4. Main 生成 child identity/generation/唯一实例名
  5. parent 未 ready → 仅 spawn parent container，绝不 prompt coding model
  6. 等 parent-ready
  7. spawn-child → 等 child-ready + identity/profile/toolIds 精确确认
  8. prompt-child 首条 task（exactly once）
          │
          ├── AGENT_EVENT → 现有 sessions reducer → child TAB
          │       reply / ASK / approval / tools / receipts / jsonl
          │
          └── Main 生成安全通知
                  → worker `append-session-custom-entry`
                  → parent SessionManager.appendCustomEntry(...)
                  → dispatch / completed / failed / safe receipt summary
                  → 不参与 buildSessionContext

child 显式 message_main_agent
  └── ParentNotifier / custom_message → 唯一允许主动进入主 coding Agent context 的通路
```

控制面不变量：Renderer 只能选择 Main 返回的 `typeKey`；不能提交 tool profile、system prompt、model、skills、MCP、sessionId、generation、instanceName 或 target conversation/path。

---

## 3. Agent 类型 registry 与 locked Enso manifest

### 3.1 稳定身份

```ts
type AgentTypeKey =
  | 'agent:enso'
  | `builtin:${string}`
  | `custom:${string}`;

interface AgentTypeCandidate {
  typeKey: AgentTypeKey;
  displayName: string;
  description: string;
  source: 'system' | 'builtin' | 'custom';
  locked: boolean;
}
```

- `agent:enso` 是固定保留键，且其内部 Agent id 固定为 `enso`；展示名 `Enso`，不可删、禁用、编辑、覆盖。
- 内置 Agent type 由 `BUILTIN_AGENT_TYPES` 派生，过滤 `disabledBuiltinAgentTypes`。
- 自定义 type 以 `AgentTypeEntry.id` 生成 `custom:<id>`；同名 builtin 可以同时出现，用 source badge 区分，不再靠名字覆盖路由。
- 现有实例名、coworker name、session title 一律不进入候选。
- 自定义名称经 Unicode normalize + trim + case-fold 后为 `enso`，或 type key/profile id 命中保留命名空间时，判非法；settings create/edit 与 Main registry 两层都 fail-closed。

Main 每次打开 mention picker可返回 registry snapshot；真正 dispatch 时必须重读当前 registry。Renderer 缓存只能用于显示，不能成为授权事实源。

### 3.2 Enso locked profile

```ts
interface LockedAgentProfile {
  profileId: 'enso-locked-v1';
  typeKey: 'agent:enso';
  inheritParentModel: true;
  systemPromptId: 'enso-system-v1';
  toolIds: readonly ['enso_capabilities', 'enso_app', 'ask_user'];
  skillPaths: readonly [];
  mcpServers: readonly [];
}
```

Main 只根据 `typeKey='agent:enso'` 选择 manifest；Renderer 请求中不存在 `profileId`。worker 同样内置 manifest，并在 `child-ready` 前核对：

- typeKey/profileId 固定；
- 模型与 parent 当前模型一致；
- tools 精确等于三项，不多不少；
- skills/MCP 为空；
- no generic read/grep/find/ls/bash/edit/write/subagent/coworker/background tool。

任一项不匹配，worker 发 `child-rejected`，Main 终止 generation，任务不得 prompt。

普通 builtin/custom Agent 不使用 locked profile。Main 把当次 registry 的合法配置解析成 `ResolvedAgentTypeSpawnConfig`：

- 显式配置 model：使用该 model；否则继承 parent；
- `tools` 按 `all|readonly`；
- skillIds/MCP ids 在 Main 对 settings 权威集合解析；
- 缺失、禁用、凭证不可用或非法引用直接拒绝；不降级到 general；
- Renderer 不能覆盖这些字段。

---

## 4. Main 权威 source binding

### 4.1 绑定形状

```ts
interface ParentSourceBinding {
  bindingId: string;
  ownerWebContentsId: number;
  windowKind: 'main';
  parentConversationId: string;
  parentProjectId: string;
  parentProjectPath: string;
  selectedProviderId: string;
  selectedModelId: string;
  issuedAt: number;
  expiresAt: number;
}
```

MainWindow 是唯一能取得 dispatch binding 的窗口。binding 由 Main 建立并与 `event.sender.id` 绑定：

1. Renderer 报告当前 root conversation selection；
2. Main 从持久 conversation metadata、project registry、`AgentSessionIndex` 交叉验证 root/child 关系、project/path 与当前模型；
3. Main 签发短期 binding；切会话、删会话、换项目、窗口销毁即失效；
4. dispatch 时只接收 `bindingId`，再次核验 sender、root parent、project、model 与 generation。

即使当前显示的是 coworker TAB，binding 的 parent 仍是其 root 普通会话；新 mention 创建 sibling child，不允许 child-of-child。

Renderer 自报的 `conversationId/projectPath/sessionId/parentId/model/profile` 即使夹带也因 strict schema (`additionalProperties:false`) 被拒绝。file mention containment、team target、receipt parent 均只从 binding 派生。

### 4.2 非主窗口召唤

设置窗与 Onboarding 不能直接 dispatch。它们只调用 `window.summonAgent('agent:enso')`：Main 聚焦/创建 MainWindow，并发一个 `composer-prefill` 事件。真正发送仍在 MainWindow Composer，届时重新取得 parent binding。

---

## 5. identity、generation 与 ready handshake

### 5.1 身份合同

```ts
interface SessionIdentity {
  sessionId: string;
  generation: string; // Main randomUUID，每次 spawn/resume/rebuild 都新建
}

interface ChildSessionIdentity extends SessionIdentity {
  parent: SessionIdentity;
  instanceId: string;      // Main randomUUID
  instanceName: string;    // Main 生成且在 parent 下唯一
  typeKey: AgentTypeKey;
  profileId?: 'enso-locked-v1';
}
```

`childSessionId` 由 Main 生成，例如 `${parentId}::cw-${instanceId}`；不再由 Renderer 的 slug/name 拼接。`instanceName` 使用 type display name + 唯一短后缀，Main 对 parent 的 active/reserved/restorable children 检查冲突并循环生成。每次 mention 都分配新 `instanceId/sessionId/generation/name`，不会复用同类型旧 TAB。

所有 session command/event 都携带 identity generation。Main 与 worker 只接受当前 generation；旧 ready、ASK response、OAuth event、tool result、turn completion 一律幂等丢弃。

### 5.2 parent ready

普通会话新增真正的 worker ready 事件，而不是把 `postMessage` 成功或首个 status 当 ready：

```ts
type ParentLifecycleEvent =
  | { type: 'parent-ready'; identity: SessionIdentity; sessionFile: string; model: ModelRef }
  | { type: 'parent-rejected'; identity: SessionIdentity; reason: string }
  | { type: 'parent-ended'; identity: SessionIdentity; reason: string };
```

未 started parent 的 dispatch：

- Main 用 binding 中**当前选择模型**调用普通 spawn；
- 只建立 parent `AgentSession`/factory/jsonl，不调用 `prompt`，因此 coding model不计费、不见 delegation task；
- 等 `parent-ready` 后才继续；
- 无当前可用模型时返回选择模型动作，不用 child type 的显式模型代替 parent 模型。

### 5.3 child ready

```ts
type ChildLifecycleEvent =
  | {
      type: 'child-ready';
      identity: ChildSessionIdentity;
      sessionFile: string;
      model: ModelRef;
      toolIds: readonly string[];
    }
  | { type: 'child-rejected'; identity: ChildSessionIdentity; reason: string }
  | { type: 'child-ended'; identity: ChildSessionIdentity; reason: string };
```

Main 只有在 identity、parent generation、typeKey、profile/model/toolIds 全匹配后，才把 reservation 转 active 并发送首条 task prompt。超时只能失败，禁止乐观成功。

---

## 6. typed mention 派发状态机

### 6.1 请求

```ts
interface AgentDispatchRequest {
  requestId: string;
  bindingId: string;
  recipient: { kind: 'agent-type'; typeKey: AgentTypeKey };
  task: {
    text: string;
    images: AttachedImage[];
    fileMentions: readonly FileMentionRef[];
  };
}
```

`task` 至少有 text/image 之一；file refs 只允许结构化选择。Main 按 binding projectPath 做 realpath containment、文件类型与大小限制，生成一次性不可变快照后才放进 child task context。

### 6.2 状态

```text
received
  → source-bound
  → capacity-reserved
  → parent-spawning? → parent-ready
  → child-spawning
  → child-ready
  → task-dispatched
  → running ↔ waiting-user / waiting-approval
  → completed | failed | cancelled
```

完整顺序：

1. Composer 选择 typed Agent candidate；显示 chip，普通文本 `@name` 不触发控制面。
2. 发送进入 `AgentDispatchService.dispatch`，不调用 `sessions.send`、`AGENT_PROMPT` 或 coding model。
3. Main 校验 binding/registry/file refs，原子占用容量，生成 child identity。
4. Main 发 `child-reserved`；Renderer 在父 `CoworkerTabs` 立即创建 placeholder TAB 并切过去。
5. parent 未 ready 时仅 spawn parent container，等 `parent-ready`。
6. Main 发 `spawn-child`，worker 用 child factory 创建 session，注册事件订阅/jsonl/ASK/approval。
7. worker 发 `child-ready`；Main 做 exact handshake。
8. Main 向 child 发一次 `prompt-child`。首条 task 只写 child jsonl，成为 child TAB 的 user message。
9. Main 生成安全 `agent-dispatch` custom entry，并用 exact parent identity 下发 `append-session-custom-entry`；持有 SDK SessionManager 的 worker 校验 generation、串行 append 到 parent jsonl并发 projection，不进入 parent LLM context。
10. child 的普通事件通过 `AGENT_EVENT` 进入现有 session reducer；ASK、工具、OAuth host、receipt 都在 child TAB。
11. child turn 完成/失败时，Main 同样生成 `agent-completed|agent-failed`，由worker写parent custom entry；不附完整 transcript。child TAB保留完整历史。
12. child 需要主动把结论交给 coding Agent 时，显式调用 `message_main_agent`；除此之外禁止自动注入。

首条 prompt exactly-once：Main 为 `{childGeneration, requestId}` 保留幂等记录；ready 重放、IPC response 重试、Renderer 重发均不会二次 prompt。

容量达到 5 时，在创建 child 前返回结构化 `capacity-reached`；不 spawn parent、不建孤儿 TAB。并发两个 dispatch 由 Main reservation 原子串行，worker 上限只作为第二道兜底。

---

## 7. TAB、timeline 与 jsonl

### 7.1 child TAB

沿用 `Conversation` 子项，扩展：

```ts
interface ChildConversationMetadata {
  parentId: string;
  childGeneration: string;
  agentTypeKey: AgentTypeKey;
  agentInstanceId: string;
  agentInstanceName: string;
  dispatchOrigin: 'typed-mention' | 'manual' | 'agent-tool';
  lockedProfileId?: 'enso-locked-v1';
}
```

`coworker-update`/snapshot 携带这些安全 metadata。reducer 以 `(sessionId,generation,seq)` 单调归并；旧 generation 不覆盖新恢复会话。

### 7.2 custom entry 通知

pi `SessionManager.appendCustomEntry()` 明确不参与 `buildSessionContext()`。本方案用它记录：
- Main 负责生成、脱敏与授权 custom entry；worker 是 SessionManager 的唯一写入者。`append-session-custom-entry` 必须按 exact session generation 经 per-session journal gate 串行，不能由 Main 直接改 jsonl，也不能与 resume/terminate 跨 generation 串台。

```ts
type AgentSessionCustomEntry =
  | { kind: 'agent-dispatch'; child: SafeChildRef; at: number }
  | { kind: 'agent-completed'; child: SafeChildRef; receiptSummary?: string; at: number }
  | { kind: 'agent-failed'; child: SafeChildRef; errorCode: string; message: string; at: number }
  | { kind: 'capability-receipt'; receipt: CapabilityReceipt };
```

- parent 只收 dispatch/completed/failed 与安全 receipt summary；dispatch 只标明派给哪个实例，不复制原任务正文；不保存 child transcript/tool params。
- Enso child 自己追加完整但已脱敏的 `capability-receipt`，供 TAB/恢复显示。
- `SessionSnapshot` 增加 custom entry projection；Renderer timeline 合并 messages/custom entries 展示，但 model context 仍只由 SDK messages 构建。
- 不建立 sidecar persist、audit.json、HISTORY IPC 或全局 Enso snapshot。

### 7.3 恢复

父会话 `resumeConversation` ready 后，按持久 `coworkerIds/sessionFile/agentTypeKey/lockedProfileId` 级联恢复 child：

- 每次 resume 由 Main 分配新 generation；sessionFile/instanceId/name 不变；
- Enso 永远按 locked manifest 恢复并继承恢复后 parent 模型；
- 普通 type 按当前 registry 重新解析；已删/非法/禁用的 type 只读展示历史并标 `unavailable`，不得静默降级 general；
- snapshot 从 child 自己 jsonl恢复 messages/custom receipts；父 custom notifications 从父 jsonl恢复。

---

## 8. Enso Gateway 安全落点

### 8.1 每 child 的权威 context

```ts
interface CapabilityInvocationContext {
  child: ChildSessionIdentity;
  parentBinding: Pick<ParentSourceBinding,
    'parentConversationId' | 'parentProjectId' | 'parentProjectPath'>;
  turnId: string;
  ownerWebContentsId: number;
}
```

只有 `profileId='enso-locked-v1'` 的当前 child generation 可以发 `capability-invoke`。target 不接受模型/Renderer传入 conversationId/path；team/file capability 只取创建 child 时固化的 parent binding，并在提交前复验 parent generation/alive。

### 8.2 ASK 与危险队列

- read/reversible 按 catalog 执行；dangerous 必须逐笔 ASK，无 `allowSession`。
- ASK 投影到发起 Enso child TAB 的 `pendingAsks`；响应携带 child identity/generation/requestId。
- 全局 dangerous queue 的 active 锁覆盖 announce → first valid decision → handler complete/fail/cancel → receipt settled；allow 后不能提前 pump。
- generation 结束、parent 结束、TAB dismiss、worker exit、app quit 全部 fail-closed；旧 response 不执行。
- team hire/dismiss 除 Gateway queue 外，还使用 `AgentSessionIndex` 原子 capacity/name reservation。

### 8.3 receipt

Main handler 基于权威对象与真实结果生成 `CapabilityReceipt`；模型文本不能决定 outcome/subject/changes。

- receipt 先过 schema 与统一 secret redactor；
- 安全 model result 回 Enso child 的 `enso_app`；
- receipt custom entry 写 Enso child jsonl并显示 TAB；
- parent 只写安全 summary custom entry；
- deny/fail/cancel 不得显示绿色完成；settings 包含 previous → value；team 逐成员一笔。

### 8.4 OAuth、settings、default、schema

验证墙已有安全合同原样保留并改绑 child identity：

- OAuth `flowId + ownerWebContentsId + host + childGeneration + requestId`；allow ACK 与登录最终结果分离；device code/prompt/progress 在 Enso child TAB 的 `OauthLoginStep` 显示。
- wizard flow 与 Enso child flow 不能互相 cancel/reopen/respond；history/TAB rebind 只能绑定同一 flow。
- Gateway settings 写广播全部 renderer（包括 owner）；普通 renderer 自写仍 exclude sender。
- default model 写前由 Main 用 auth.json 真 keys 校验 provider/model enabled、API key/OAuth account 真凭证。
- `sanitizeDefaultModel` 对确定失效的 API-key default 立即回退；无关 OAuth unknown/error 不能阻塞确定可用 API-key fallback。
- 所有 executable schema `additionalProperties:false`，值域来自 shared 权威常量；handler 提交前再次校验真实资源与对象 label。
- provider service 不返回远端 body；apiKey、Bearer、query key、URL userinfo、access/refresh token 在 success/error/throw/receipt/tool result/event/snapshot/custom entry 全链使用 value-aware redactor。
- `enso_app` raw params 只活在 worker→Main 当前执行内存，不进入 ProjectedMessage/jsonl/broadcast/custom entry。

---

## 9. 右上召唤与 Composer UX

### 9.1 候选

空 `@` 分组保持 `Agents` / `Files`：

1. `Enso` 固定第一，System/Locked badge；
2. 所有未禁用 builtin Agent types；
3. 全部合法 custom Agent types；
4. Files 组保持现有项目文件搜索。

不包含现有 coworker 实例名。重复 label 用 Built-in/Custom badge 与 description 区分，路由只认 typeKey。

选择 Agent 后显示 typed recipient chip；发送后该 chip 从主 composer 消费，child TAB 成为当前 TAB。Agent + file mentions 共存时，files 是 child 首条 task 的只读快照，Agent 是唯一 recipient。

### 9.2 全局召唤

- MainWindow 右上角：聚焦 root 普通聊天并预填 `@Enso` chip；当前 child TAB 时先切回 parent root。
- Settings/Onboarding：Main IPC 聚焦/创建 MainWindow并发 prefill；不在当前窗口打开 composer/dialog/drawer。
- 无普通会话：优先当前/最近 project 新建普通 draft；无 project 时聚焦 project 空态并保留一次 pending prefill，选定项目后立即建 draft并预填。
- 无当前可用模型：仍可预填，但发送 fail-closed并提示先选模型；绝不创建 Enso 专用容器。

---

## 10. clean cutover 与兼容

### 10.1 保留

- `AgentTypeEntry`、`BUILTIN_AGENT_TYPES`、coworker tools/TAB/session jsonl；
- Enso capability catalog、Gateway、tools、prompt；
- default/OAuth/provider unified wizard；
- ordinary coding approval semantics。

### 10.2 删除或改写

| 旧实现 | clean cutover |
| --- | --- |
| `src/main/services/agentInvocationRouter.ts` + test | 删除；由 `agentDispatchService.ts` 替代 |
| `ENSO_SESSION_ID` / builtin session identity | 删除；改为每实例 child identity + locked profile |
| `src/renderer/stores/agentInvocations/**` | 删除；状态进入 sessions child projection |
| `EnsoHistoryDrawer.tsx`、`AgentComposer.tsx`、`AgentInvocationCard*`、`agentInvocationList.ts` | 删除 |
| `AskEnsoLauncher.tsx` | 删除；TitleBar/Settings/Onboarding 调统一 summon/prefill |
| `BUILTIN_AGENTS_*` IPC/preload | 删除；新增 registry/dispatch/summon 三点式链路 |
| `ensoSnapshot` / `broadcastBuiltinAgentEvent` | 删除；所有 child 走 `AGENT_EVENT`/snapshot |
| global history owner/rebind | 删除；OAuth/ASK owner 绑定具体 child TAB generation |
| 固定 `Enso completed the request.` | 删除；真实 child terminal + Main receipt |

不保留旧请求 shape、旧 channel alias、旧 global session resume 或隐藏 fallback。

---

## 11. 安全不变量

1. typed mention 是控制面；普通 `@text` 不派发。
2. Main 从 sender binding决定唯一 parent/target；Renderer 不能提交执行 target。
3. 每次 mention 新 identity/TAB；不复用同类型实例。
4. 未 started parent 先 ready、零 prompt；原任务从不发 coding model。
5. child 必须 exact ready handshake 后才 prompt；无超时乐观成功。
6. generation 覆盖 spawn/prompt/event/ASK/result/OAuth/terminal；旧 generation 全丢弃。
7. Enso locked profile 在 Main 与 worker 双验；Renderer不能伪造 profile或抢 reserved identity。
8. 普通 Agent 的 model/tools/skills/MCP只从 Main registry配置解析。
9. child transcript 只在 child jsonl/TAB；parent 默认通知使用不进 LLM context 的 custom entry。
10. 只有 child 显式 `message_main_agent` 才能主动进入主 coding Agent context。
11. Enso capability target固定为创建时的 parent binding；模型不能换 session/project。
12. dangerous queue锁到 handler/receipt settle；terminate fail-closed。
13. secret value redaction 覆盖所有成功/失败/持久化/广播投影。
14. 没有全局 Enso session/window/drawer/snapshot/sidecar/history，也没有兼容 shim。

---

## 12. 已拍板项

- 每次 typed `@AgentType` 新建 child实例/TAB：已拍板。
- 候选范围、Enso locked、模型继承规则：已拍板。
- Main 确定性派发、source binding、parent ready：已拍板。
- 主 coding Agent 不接原任务/完整 child 回合：已拍板。
- parent 只收安全 custom entry；child 显式 `message_main_agent` 是唯一主动 context 通路：已拍板。
- 旧独立 Enso/global snapshot/drawer/history 全部删除：已拍板。

本方案没有待用户拍板的产品 OQ。实现阶段只剩工程验证，不允许把上述结论改成开关或 fallback。