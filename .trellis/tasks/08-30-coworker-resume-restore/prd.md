# PRD：重启后 coworker 级联恢复与死 tab 修复

## 目标与用户价值

app 重启后，关机时还活着的 coworker（队友型 child 会话）恢复为可继续对话的活会话；已结束的 child 走只读回放；任何恢复不了的 child tab 都可以关闭。同时清掉 39f4d3a 架构切换在渲染层留下的死代码与坏链路，让手动雇佣重新可用。

## 背景（已核对源码/归档任务的事实）

### 现状缺陷

1. **重启后 coworker 不恢复且被打成 failed**：`resumeConversation` 级联恢复段（`src/renderer/stores/sessions/index.ts:1267-1290`）调用 `AGENT_SPAWN_COWORKER`，该通道在 39f4d3a 已封死为硬拒绝（`src/main/ipc/agent.ts:502-508`；动机：安全不变量 #2「Renderer 不能提交执行 target」）。
2. **死 tab 无法关闭**：`AGENT_DISMISS_COWORKER`（agent.ts:510-519）要求 `exactIdentity(coworkerId)` 解析出当前活着的 ChildSessionIdentity；重启后 child 未注册 → 拒绝；渲染层 `dismissCoworkerFromUI`（index.ts:1482-1484）void 掉结果，tab 删除完全依赖 `coworker-update: dismissed` 回流 → 永远挂着。
3. **手动雇佣对话框坏死**：`HireCoworkerDialog` → store `hireCoworker`（index.ts:1566）→ 同一封死通道，静默失败。
4. **工具直雇的活 coworker 也无法从 UI dismiss**：`coworker` 工具走 worker 侧 `SessionSupervisor.spawnCoworker`（supervisor.ts:1269），普通 SessionIdentity，从不进 Main `sessions` 索引，`'parent' in child` 校验必然失败（39f4d3a 起即坏）。

### 架构事实

- **coworker 四个来源**：(a) typed mention 派发、(b) Enso `team.hire` → 均为 typed child（ChildSessionIdentity，Main `reserveChild` + `child-ready` 握手入索引）；(c) 主 agent `coworker` 工具 → worker 直雇（普通身份，Main 仅经 `coworker-update` 进 `parent.coworkers` 映射，agentSessionIndex.ts:350-352；落 pi 原生 jsonl）；(d) UI 弹窗 → 死通道。
- **worker 命令面已无 coworker 通路**：命令 switch 只有 `spawn-child`（要求 Main registry 解析的 typed config）与 `dismiss-child`（要求 exact ChildSessionIdentity）；Main 现在没有任何命令能恢复或解雇 (c) 类。
- **08-28 design §7.3（作者拍板、从未实现）**：父会话 resume ready 后由 Main 级联恢复 child——新 generation、sessionFile/instanceId/name 不变、Enso 按 locked manifest 并继承 parent 模型、普通 type 按 registry 重新解析、类型已删 → 只读 + 标 unavailable，不得静默降级。
- **08-29（只读回放）**：范围是「回放通道不给执行权」，与 §7.3 互补而非替代；回放只认 `enso-` 前缀 safe journal → (c) 类历史对回放通道不可用。
- **「已结束」不落盘**：`child-ended`/`child-rejected` 在 reducer 只清运行态（reducer.ts:181-189）→ 跨重启无法区分已结束与活着。
- **容量**：worker coworker 路径 resume 豁免上限（supervisor.ts:1281 `!resumeFile &&`）；typed child 路径无豁免（supervisor.ts:1168 无条件卡 `MAX_ACTIVE_COWORKERS=5`）；Main reservation 上限 5。
- typed reservation（agentSessionIndex.ts:188-200）只有「新建」语义（撞名换新 instanceId）；resume 需要「按原 instanceId/name 重预约、只换 generation」的变体。
- 渲染层持久化保留 `coworkerIds`/`sessionFile`/`child` metadata/`agentType`/`coworkerName`（partialize 不清除）；Main 有读渲染层持久化的先例（`ensureParentReady` 经 `persistedConversation()` 取 resumeFile，agentDispatchService.ts:704-720）。
- `agentDispatchService.hireCoworker()` 已存在且完整（Enso team.hire 在用），可被新 IPC 复用。

## 已拍板决策

- **Q1 = A（恢复范围）**：reducer 在 `child-ended`/`child-rejected` 落盘 ended 标记；重启后只恢复未 ended 的 child，已 ended 走只读回放。存量数据无标记 → 升级后首个重启会把旧 child 当「未结束」恢复一次，可接受（可手动关闭兜底）。
- **Q2 = A（双形状保留）**：Main 补两条窄命令 `resume-coworker`（Main 从自己读的持久化取 name/agentType/sessionFile，渲染层不传路径）与 `dismiss-coworker`（按 `parent.coworkers` 映射校验后下发）；typed child 走 §7.3 reservation 恢复。「统一到 typed child」记为独立后续任务。
- **Q3 = A（手动雇佣）**：新 IPC → `agentDispatchService.hireCoworker()`（复用 Enso 同款守卫，雇出 typed child）；handler 加来源校验（仿 `persistedRootSpawn` 口径）；删 store 死 `hireCoworker` action。
- **Q4 = A（回放缺口）**：(c) 类历史不可回放本任务接受（tab 显示历史不可用 + 可关闭）；「coworker 路径写 safe journal」另立任务。

## 需求

- **R1 死 tab 可关闭**：dismiss IPC 失败且 child 未 started/spawning 时，渲染层本地移除（复刻 dismissed 回流分支的状态收敛：删会话、收缩 coworkerIds、activeTabId 回落）。不碰任何身份守卫。
- **R2 清除死代码**：删渲染层级联 spawnCoworker 段、store `hireCoworker` 旧实现、preload `spawnCoworker`、`AGENT_SPAWN_COWORKER` 通道常量与墓碑 handler。
- **R3 Main 级联恢复**：父会话 resume 的 `parent-ready` 后，Main 按持久化数据级联恢复该父下所有未 ended、未 dismissed 的 child：
  - typed child：resume 变体 reservation（原 instanceId/instanceName/typeKey，新 generation）→ `spawn-child` 带 Main 侧 resumeFile；类型已删/禁用 → 不恢复、渲染层只读回放；Enso 按 locked manifest 恢复并继承恢复后 parent 模型。
  - (c) 类：新 worker 命令 `resume-coworker`（exact parent identity + Main 侧 sessionFile）→ worker `spawnCoworker(resumeFile)`（沿用其容量豁免）。
  - 级联幂等：同 parent generation 只跑一次；已活着的 child 跳过。
- **R4 手动雇佣走 dispatch**：新 IPC `AGENT_HIRE_COWORKER` → 来源校验 → `dispatchService.hireCoworker()`；HireCoworkerDialog 改调新通道。
- **R5 活的 (c) 类 coworker 可 dismiss**：Main dismiss handler 降级链——exact ChildSessionIdentity → `dismiss-child`（现路径）；否则 parent.coworkers 映射命中 → 新 `dismiss-coworker` 命令；都未命中 → 返回 not-found（渲染层按 R1 本地移除）。
- **R6 ended 标记**：`child-ended`/`child-rejected` 落盘 ended；child 被成功恢复（新 generation 事件到达）时清除。

## 验收标准

- AC1 雇 coworker（工具/@派发/Enso/UI 四种来源各验）→ 优雅退出 → 重启 → 打开父会话：未结束的 coworker tab 全部恢复为活会话，可继续对话，历史完整；无 failed 报错。
- AC2 已结束的一次性派发 child 重启后不复活：tab 只读回放（Enso safe journal 类）或提示历史不可用（(c) 类），不占容量。
- AC3 任何未恢复的 child tab 点关闭 → tab 消失、父 coworkerIds 收缩、activeTabId 回落父会话；活 coworker（含 (c) 类）点关闭 → worker 会话销毁 + 主 agent 收到通知（notify=true 语义不变）。
- AC4 UI `+` 手动雇佣 → 走 Main dispatch 雇出 typed child，容量/name 去重守卫生效，tab 出现并选中。
- AC5 类型已删的 typed child 重启后不静默降级 general：不恢复为活会话，历史可读。
- AC6 安全不回退：渲染层任何路径不传文件路径/不指定 child 身份；resume 的 sessionFile 全部由 Main 从自己读的持久化取；exact generation 守卫不放松。
- AC7 `pnpm typecheck`、`pnpm vitest run`、Biome 全绿；改动的纯逻辑（reducer、dismiss 降级链、reservation resume 变体、级联筛选）均有先红后绿的测试。

## 超出范围

- coworker 工具 hire 统一到 Main dispatch（后续任务）
- coworker 路径写 safe journal（后续任务）
- 手机第二屏 child 恢复联动
