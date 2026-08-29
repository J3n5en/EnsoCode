# 实现计划：`@AgentType` → child session/TAB 确定性派发

本计划只描述实现顺序、文件独占与验证合同；当前规划阶段不改 `src/**`、不跑门禁。产品合同见 `prd.md`，架构状态机见 `design.md`，F01–F20 根修映射见 `temp/model-center-default-agent/p0-remediation.md`。

执行编制固定为：启动 P0 owner 交付 → E0 共享契约 → R1 runtime / R2 gateway / R3 renderer 并行 → R4 串行集成。不得把已拍板的 child TAB 方向改回全局 Enso session/drawer。

---

## 0. 启动 P0 冻结墙

当前启动根修 owner 完成前，下列文件视为冻结，E0/R1/R2/R3 均不得触碰：

- `electron.vite.config.ts`
- `package.json`
- `pnpm-lock.yaml`
- `src/main/index.ts`
- `src/main/index.test.ts`
- `src/main/services/agentHost.ts` 中 utility worker modulePath/启动段
- `src/main/services/oauthProviders.ts`、`src/main/services/oauthProviders.test.ts`
- `src/main/ipc/providers.ts`
- `src/preload/index.ts`
- `src/renderer/components/oauth/OauthCredentialBootstrap.tsx`
- `src/renderer/components/oauth/oauthCredentialRefresh.ts`、对应 test
- `src/shared/types/ipc.ts`
- `src/tooling/productCapabilityCoverage.fixture.ts`、`productCapabilityCoverage.test.ts`

移交规则：

1. 启动 owner 完成交付并明确文件冻结快照；
2. `src/main/index.ts`、`electron.vite.config.ts`、package/lock 后续继续不碰；
3. `agentHost.ts` 移交 R1，OAuth files 移交 R2，`ipc.ts/preload/coverage` 移交 E0；
4. E0 全部落地后才允许 R1/R2/R3 扇出。

任何人不得为“先开工”复制一份 IPC/profile 类型绕过冻结；那会制造第二事实源。

---

## E0 — 共享契约 owner（串行前置）

### 独占文件

- `src/shared/builtinAgents.ts`、`src/shared/builtinAgents.test.ts`
- `src/shared/types/assets.ts`
- `src/shared/types/mentions.ts`
- `src/shared/types/agent.ts`
- `src/shared/types/ipc.ts`（启动 owner 移交后）
- `src/shared/types/index.ts`
- `src/shared/capabilities/types.ts`
- `src/shared/capabilities/catalog.ts`
- `src/shared/defaultModel.ts`、`src/shared/defaultModel.test.ts`
- `src/preload/index.ts` 的 agent registry/dispatch/summon/capability contract（启动 owner移交后）
- `src/tooling/productCapabilityCoverage.fixture.ts`、`productCapabilityCoverage.test.ts`（启动 owner移交后）
- 必要的 shared parse/contract tests

### 落地合同

1. **AgentTypeKey**：`agent:enso | builtin:<name> | custom:<id>`；`agent:enso` 的内部 Agent id 固定为 `enso`，Mention candidate 不再只认 Enso。
2. **locked manifest**：Enso 固定 `enso-locked-v1`、继承 parent model、tools 精确三项、skills/MCP 为空；保留名 normalize/case-fold helper。
3. **严格请求**：`AgentDispatchRequest` 只含 requestId/bindingId/typeKey/task；`additionalProperties:false`；无 target/profile/model/sessionId/name。
4. **identity/generation**：parent/child/session command/event/ASK/result/OAuth 都可携带 exact generation；解析失败返回 null。
5. **ready lifecycle**：`parent-ready/rejected/ended` 与 `child-ready/rejected/ended`；ready 包含 sessionFile/model/toolIds。
6. **custom entry projection**：dispatch/completed/failed/capability-receipt；类型上不属于 LLM message。
7. **child metadata**：agentTypeKey/instanceId/instanceName/dispatchOrigin/lockedProfileId。
8. **IPC clean cutover**：删除 `BUILTIN_AGENTS_*` 与死 `CAPABILITIES_RESULT`；新增 registry list、binding/dispatch、summon/prefill 三点式通道。保留 `AGENT_EVENT/SNAPSHOT` 作为普通+child统一事件流。
9. **capability identity**：Gateway request/response/receipt 带 child identity/generation/turn/request；无全局 Enso sessionId。
10. **schema/default**：F13–F15/F18 的真实值域、strict object、default usability reason 与 OAuth 三态算法先在 shared 固定。

### 交付验收

- Enso reserved custom create/edit 被纯函数拒绝；Main/worker可共享 locked manifest。
- Renderer 构造含 profile/sessionId/conversationId/projectPath 的 dispatch request 解析失败。
- 旧 builtin Enso snapshot/invocation 类型与 channel 不再导出。
- `SessionSnapshot` 可携带 child metadata/custom entries，custom entries不混 `ProjectedMessage[]`。
- R1/R2/R3 所需签名全部在 E0 文档化；并行切片不得再改形状。

---

## R1 — Runtime / Main dispatch / child factory

R1 与 R2/R3 并行；只改本节 owner 文件。

### 独占文件

- `src/main/services/agentDispatchService.ts`（新，替代旧 Router）
- `src/main/ipc/window.ts`、`src/main/ipc/window.test.ts`（新增/补齐 summon handler）
- `src/main/services/activeConversationRegistry.ts`（新，Main source binding）
- `src/main/windows/SettingsWindow.ts`（仅窗口聚焦/来源类型协作）
- `src/main/services/agentHost.ts`（启动 owner移交后）
- `src/main/services/agentSessionIndex.ts`、`agentSessionIndex.test.ts`
- `src/main/ipc/agent.ts`、`src/main/ipc/agent.test.ts`（新增/补齐）
- `src/main/windows/MainWindow.ts`
- `src/agent/index.ts`
- `src/agent/supervisor.ts`
- `src/agent/messageMain.ts`、`messageMain.test.ts`（若现有 test）
- `src/agent/projection.ts`、`projection.test.ts`
- `src/agent/supervisor.agentDispatch.test.ts`（新；替换旧 Enso 专用测试口径）
- `src/main/services/agentDispatchService.test.ts`（新）
- `src/main/services/activeConversationRegistry.test.ts`（新）
- 删除 `src/main/services/agentInvocationRouter.ts`、`agentInvocationRouter.test.ts`

### 步骤

1. **source binding**
   - MainWindow 登记 window kind；selection 变化调用 registry。
   - registry 从 persist conversation metadata、projects、AgentSessionIndex 验 root parent/project/path/current model。
   - binding 绑定 sender、TTL、root parent；切换/删除/关闭即失效。
   - dispatch strict reject Renderer target/profile/session identity。
   - `window.summonAgent('agent:enso')` 只聚焦/创建 MainWindow并发 `composer-prefill`；Settings/Onboarding 不取得 dispatch binding，不在点击时雇佣。

2. **原子 reservation 与唯一实例**
   - `AgentSessionIndex.reserveChild(parentIdentity,typeKey)` 在同一同步临界区统计 active+reserved，统一上限 5。
   - Main 生成 instanceId/sessionId/generation/instanceName；实例名对 active/reserved/restorable children 查重。
   - failure/cancel释放 reservation；ready 后转 active；worker容量只作第二道兜底。

3. **parent container ready**
   - 普通 `spawn` 增加 Main generation；公共 `postMessage ok` 不再代表 ready。
   - 未started parent 只 spawn，不 prompt；worker创建 runtime/factory/jsonl后发 `parent-ready`。
   - current model不可用时 dispatch返回结构化 action；不能借 child type显式模型建立 parent。

4. **child factory**
   - 新 `spawn-child` 只接受 Main生成 identity + E0 resolved type/profile。
   - `SessionFactory.createChildSession`：Enso走 locked分支；普通 Agent按 resolved model/tools/skills/MCP。
   - Enso tool ids exact verify；不加载普通工具、本机 skills/MCP。
   - 注册 ManagedSession/coworker-update/jsonl后发 `child-ready`；Main handshake通过才 prompt。

5. **exactly-once 首条 task**
   - Main记录 `{childGeneration,requestId}`；ready/retry重放不二次 prompt。
   - 原 task只进入 child prompt/jsonl；绝不调用 parent prompt/steer。
   - `child-reserved` 事件先于任何 child session event，保证 Renderer先建 TAB。

6. **custom parent notifications**
   - Main生成安全entry并发 `append-session-custom-entry`；worker校验exact parent generation，经per-session journal gate调用 `sessionManager.appendCustomEntry`。Main不得直接改jsonl。
   - dispatch entry 只含安全 child引用与状态，不复制原任务正文；无 child transcript/tool args。
   - 发 custom-entry event/snapshot projection供 timeline。
   - typed-mention child完成时禁止调用当前自动 `ParentNotifier` summary；只有显式 `message_main_agent` 保留进入 parent context。

7. **generation与恢复**
   - 所有 session命令/事件核对 generation；普通 raw sessionId控制路径迁移到 exact target。
   - parent终止级联 child generation terminate、ASK/Gateway cancel hook。
   - resumeFile 恢复时生成新 generation；Enso重新锁 profile；普通 type缺失/非法不降级 general。

8. **旧全局 Enso runtime 删除**
   - 删除 `ENSO_SESSION_ID`、`spawn/promptBuiltinEnsoSession`、`ensoSnapshot`、builtin event分流、global workspace/latest-session 查找。
   - 所有 child统一走 `AGENT_EVENT/SNAPSHOT`。

### scoped tests

- 两次 `@Enso`/同 type生成不同 child id/generation/name/TAB metadata。
- 未started parent：spawn→ready→child spawn→ready→task；parent `prompt` spy为 0，child `prompt` 恰 1。
- fake/late ready、错 profile/toolIds、旧 generation不能 prompt。
- 并发第 5/第 6 child的原子容量；失败释放 reservation。
- Renderer伪造 target/profile/reserved key/plain spawn抢 locked identity 全拒。
- parent custom entries在 jsonl/snapshot可恢复，但 `buildSessionContext` 不含它们。
- child transcript不注入 parent；显式 `message_main_agent` 才进入。

### 覆盖 findings

F01、F02、F03、F08、F11、F12、F16、F19，以及本切片 F20。

---

## R2 — Gateway / OAuth / settings / provider safety

R2 不改 supervisor、Composer、sessions store。

### 独占文件

- `src/main/services/capabilityGateway.ts`、`capabilityGateway.test.ts`
- `src/main/services/secretRedactor.ts`、`secretRedactor.test.ts`（新，若 E0 未提供纯类型）
- `src/main/services/providerApi.ts`、`providerApi.test.ts`
- `src/main/services/oauthProviders.ts`、`oauthProviders.test.ts`（启动 owner移交后）
- `src/main/ipc/capabilities.ts`
- `src/main/ipc/settings.ts`、`settings.test.ts`（新/补齐）
- `src/agent/tools/ensoApp.ts`、`ensoApp.test.ts`
- `src/agent/tools/ensoCapabilities.ts`、`ensoCapabilities.test.ts`
- `src/agent/ensoPrompt.ts`
- `src/renderer/components/oauth/useOauthLoginFlow.ts`、对应 test（仅 flowId/owner过滤的共享 flow，不碰 child host UI）

### 步骤

1. Gateway invocation context从全局 invocation改为 `ChildSessionIdentity + immutable parent binding + turnId`；仅 locked Enso child current generation可调用。
2. dangerous queue active锁覆盖 ASK announced → first decision → handler执行 → receipt settle；generation terminate附 AbortSignal/fail-closed。
3. ASK response仅 allow/deny，携带 child generation/requestId；重复、过期、错TAB/错generation accepted:false。
4. 每个 handler返回 `CapabilityExecutionEnvelope {modelResult,receipt}`；receipt由 Main权威对象/真实结果生成。
5. receipt由Main生成安全child entry与parent summary，再经R1 exact-identity custom-entry command交给worker写对应SessionManager；deny/fail/cancel不产生成功终态。
6. settings Gateway写使用 `broadcast:'all-renderers'`；普通 Renderer自写继续 exclude sender。
7. OAuth加 `flowId/ownerWebContentsId/host/childGeneration/requestId`；allow ACK立即返回，最终 login结果异步；错误 owner/flowId/cancel/reopen/respond拒绝。
8. wizard与 Enso child flow隔离；child TAB rebind只能同 flow。busy/failed必须失败 receipt，不能 completed。
9. provider error删除远端 body；统一 value-aware `SecretSet`覆盖 key/header/query/userinfo/token。
10. default handler用 auth.json真 keys + shared usability；invalid组合零写入/零成功 receipt。
11. executable schema与 handler权威资源双验；ASK label来自 Main lookup，不取模型 params。
12. request/generation终结清理；已settled request id只保留有界最近集合防短时重放。

### scoped tests

- allow ACK先于延迟OAuth完成；下一危险ASK直到handler settle才出现。
- wizard flow不能被 Enso child cancel；两个 Enso child不能互相 respond/rebind。
- settings owner与其它window都收到 changed；普通自写sender不回环。
- provider恶意错误体含真实key时，error/modelResult/receipt/event/custom entry均无该值。
- disabled provider/model、空 API key、logout OAuth default均 unavailable且零写。
- fake coworker/account/provider label不能改变 ASK对象。
- generation终止取消 queued/active/handler；旧 result不投给新 child。

### 覆盖 findings

F04–F10、F13、F15、F18、F19，以及本切片 F20。

---

## R3 — Renderer registry / dispatch / TAB / summon

R3 不改 Main services/Gateway/shared形状。

### 独占文件

- `src/renderer/hooks/useMentionSearch.ts`
- `src/renderer/components/chat/mentionComposer.ts`、`mentionComposer.test.ts`
- `src/renderer/components/chat/composerRouting.ts`、`composerRouting.test.ts`
- `src/renderer/components/chat/MentionPicker.tsx`
- `src/renderer/components/chat/MentionChip.tsx`
- `src/renderer/stores/sessions/timeline.ts`、`timeline.test.ts`
- `src/renderer/components/chat/ChatView.tsx`
- `src/renderer/components/chat/MessageTimeline.tsx`、`TimelineRow.tsx`
- `src/renderer/stores/sessions/index.ts`、`index.test.ts`
- `src/renderer/stores/sessions/reducer.ts`、`reducer.test.ts`
- `src/renderer/components/agent/AgentChildOauthHost.tsx`、test（新；child TAB宿主）
- `src/renderer/components/app/TitleBar.tsx`
- `src/renderer/App.tsx`
- `src/renderer/settings.tsx`
- `src/renderer/components/onboarding/Onboarding.tsx`
- 删除 `src/renderer/stores/agentInvocations/**`
- 删除 `src/renderer/components/agent/AgentComposer.tsx`
- 删除 `AgentInvocationCard.tsx`、`agentInvocationViewModel.ts/test`、`agentInvocationList.ts`
- 删除 `EnsoHistoryDrawer.tsx`、`AskEnsoLauncher.tsx`、`ensoApproval.ts`
- 旧 `EnsoOauthLoginHost.tsx` clean cutover为 child host（重命名/重写，不留双宿主）

### 步骤

1. mention picker调用 Main registry snapshot；Agents顺序：Enso、enabled builtins、legal customs；Files组保持。实例名不进入候选。
2. candidate/chip只保存 typeKey/显示数据；普通手打 `@name` 不派发，未解析token阻止发送。
3. `routeComposerPayload` 对任意 typed agent recipient调用 `agent.dispatch`；不再硬编码 `recipient.id==='enso'`。
4. dispatch路径不调用 `sessions.send`，不乐观插入 parent user message。收到 `child-reserved`立即建 placeholder child Conversation并选TAB。
5. reducer按 `(sessionId,generation,seq)`处理 ready/message/ASK/tool/custom receipt/terminal；错generation事件丢弃。
6. child TAB直接复用 `ApprovalBar`/`AskBar`/message timeline；Enso dangerous ASK没有 allowSession；OAuth flow显示在 child TAB。
7. parent timeline渲染 custom entries，和 messages按时间合并；custom entry不塞进 messages数组。
8. snapshot/rehydrate使用现有 parent→coworker级联；删除 sidecar/history drawer/loadSnapshot分支。
9. TitleBar右上召唤只 prefill `agent:enso`；settings/onboarding只调用 Main summon并关闭/聚焦对应窗口，不打开独立 composer。
10. 无会话时按 Main prefill事件创建普通 draft；无project保留一次pending prefill并显示project动作；无model预填但发送fail-closed。
11. i18n 本切片只使用英文 key；`src/shared/i18n.ts` 由 R4串行收口。

### scoped tests

- registry分组包含所有合法类型且不含 instances；duplicate label靠 typeKey/source区分。
- 每次同 type发送产生两个 child placeholders；parent messages不含原task。
- child-ready后task只在child timeline；ASK/tool/receipt均在child TAB。
- stale generation/low seq不能覆盖恢复后的child。
- parent custom dispatch/completed/failed可见，但普通 message list/context投影不混入。
- settings/onboarding summon只focus/prefill；没有drawer/dialog/global history。
- Enso+file mention仍由Enso child唯一接收；files经过typed refs。

### 覆盖 findings

F04、F06、F12、F16、F19，以及本切片 F20。

---

## R4 — 串行集成与 clean cutover

R1/R2/R3 全部交付后才开始。R4 不重写业务，只处理接缝、删除残留与最终门禁。

### 独占文件/范围

- `src/main/ipc/index.ts`
- `src/shared/i18n.ts`、`i18n.test.ts`
- E0/R1/R2/R3 改动文件的调用方迁移与删除确认
- 旧 Enso 文件/符号/channel 的最终删除
- 本任务精确路径 Biome收口

### 收口清单

1. 三点式核对 registry/dispatch/summon/capability：shared channel、Main handler、preload API、全部 caller。
2. 删除全部 `BUILTIN_AGENTS_*`、`CAPABILITIES_RESULT`、`ENSO_SESSION_ID`、`spawnBuiltinEnsoSession`、`ensoSnapshot`、`AgentInvocationRouter`、agentInvocations sidecar/drawer imports。
3. 删除旧 request origin/recipient仅Enso解析、固定完成 summary、global history owner/rebind。
4. 确认没有兼容 alias/shim、第二 events[]、audit文件、hidden Enso workspace/session。
5. i18n 收口：Agents/Files/type badges、capacity、parent ready、child TAB、summon/prefill、receipt/OAuth错误；三路检查字面量 `t()`、映射表、JSX直接label。
6. 核对 provider wizard/default/OAuth启动 owner改动未被覆盖。
7. 对本任务精确文件跑 Biome，F20要求 0 error/0 warning；不碰 `out-qa-*` 与其它任务。

---

## 集成 DAG

```text
启动 P0 owner
  └─ 冻结快照/移交
       └─ E0 shared + IPC + preload contract
            ├─ R1 runtime/Main dispatch/child factory
            ├─ R2 Gateway/OAuth/settings/provider safety
            └─ R3 Renderer registry/TAB/summon
                 └─ R4 接缝 + 旧 Enso clean cutover + i18n + Biome
                      └─ Main 一次性验证墙
```

并行期间禁止现场改 E0 shape；缺字段只回报 E0 owner，由 lead判断是否停批次修契约。

---

## 文件独占总表

| 路径 | owner | 说明 |
| --- | --- | --- |
| 启动冻结清单 | 启动 P0 owner | 移交前任何切片不碰 |
| `shared/builtinAgents.ts`、`types/{agent,mentions,ipc}.ts`、capability/default contracts、preload contract、coverage | E0 | R1/R2/R3 只消费 |
| `main/services/{agentDispatchService,activeConversationRegistry,agentHost,agentSessionIndex}`、`main/ipc/{agent,window}.ts`、`main/windows/{MainWindow,SettingsWindow}.ts`、`agent/{supervisor,index,projection,messageMain}` | R1 | Runtime、identity、summon Main handler 唯一 owner |
| `capabilityGateway/providerApi/oauthProviders/secretRedactor`、`ipc/{capabilities,settings}`、Enso tools/prompt | R2 | 领域安全唯一 owner |
| Composer/mention/ChatView/CoworkerTabs/sessions reducer+store/App/settings/onboarding/child OAuth host | R3 | Renderer唯一 owner |
| `shared/i18n.ts`、`main/ipc/index.ts`、残余调用方/删除/Biome | R4 | 并行结束后开始 |

---

## 最终验证墙（由 Main 一次执行）

### 静态/契约

- exact typecheck、scoped tests、精确文件 Biome。
- 禁词/死符号：global Enso session/drawer/sidecar/snapshot/history、旧 channels、兼容 shim为 0。
- manifest/profile/registry/default/schema/coverage完整 Record与 strict parse。

### 动态

1. started parent连续两次 `@Enso`：两个不同TAB/identity；任务只在各自TAB；主模型无原task。
2. 未started parent：只建container，主coding模型无请求；ready后child收到首prompt。
3. builtin/custom/Enso三种type：模型/tool/skills/MCP按各自合同；Renderer伪profile失败。
4. 容量5/6与并发；失败reservation回收。
5. child回复/ASK/tools/OAuth/receipt都在其TAB；父只见custom通知；显式message_main才进入主模型。
6. 重启恢复 parent+多个 child jsonl/custom entries；无drawer/global Enso history。
7. origin A/B与team target；伪造target、旧generation、重复ASK response全无副作用。
8. secret恶意回显、danger queue、OAuth flowId、settings全窗同步、default/schema F01–F20逐项复验。
9. 右上/设置/Onboarding召唤只focus/create ordinary chat + prefill `@Enso`。

动态未覆盖项必须写“未验”，不得用静态阅读代替实测。

---

## 明确不做

- 不给主模型派发决策权；
- 不把 child transcript/完整回合自动注入主模型；
- 不复用旧 Agent实例；
- 不保留全局 Enso session/window/drawer/snapshot/sidecar/history；
- 不新增 audit文件或兼容 shim；
- 不修改普通 coding approval缺省；
- 不以删除 catalog/OAuth/team/default 功能通过安全门禁；
- 不触碰另一任务 `.omp/extensions/enso-subagent-guard/**` 与 `src/tooling/trellisSubagentGuard.test.ts`。

无产品阻塞或用户 OQ。