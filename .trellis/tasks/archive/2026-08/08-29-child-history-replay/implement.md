# 实现计划：重启后回放 coworker child 历史

单人串行执行，四步。每步做完即可独立验证。

## S1 — shared：投影纯函数 + 通道常量

**文件**
- `src/shared/types/ipc.ts`：加 `AGENT_CHILD_HISTORY_READ: 'agent:child-history-read'`
- `src/shared/types/agent.ts`：加 `ChildHistoryResult` 类型与 `parseChildHistoryResult`
- `src/shared/safeJournalProjection.ts`（新）：`projectSafeJournal(records)`
- `src/shared/safeJournalProjection.test.ts`（新）

**要点**
- `projectSafeJournal` 是纯函数、无 IO
- `enso-operation` / `safe-model-result` 丢弃
- 顺序按记录原顺序，`capability-receipt` 进 customEntries 而非 messages

**测试断言点**
- 四种记录类型各自的投影结果
- 丢弃类记录不出现在任何输出里
- 空输入返回空数组而不是 undefined

## S2 — Main：读取 handler 与路径校验

**文件**
- `src/main/ipc/agent.ts`：注册 `AGENT_CHILD_HISTORY_READ`
- `src/main/ipc/agent.test.ts`：补三点式与安全用例

**要点**
- 路径来源只能是 `agentSessionIndex.persistedConversation(id).sessionFile`
- 校验顺序：是持久化会话 → 有 sessionFile → `path.resolve` 后在 sessions 目录内 → basename 以 `enso-` 开头
- 用 `EnsoSafeJournal.restore`（Main 直接 import `src/agent/ensoSafeJournal`，
  与既有 `import { ENSO_SYSTEM_PROMPT } from '../../agent/ensoPrompt'` 同例）

**测试断言点**
- 渲染层传入不存在的 conversationId → `not-found`，且不读任何文件
- 持久化记录里的 sessionFile 指向 sessions 目录之外 → `unavailable`
- basename 不以 `enso-` 开头（即 pi 的普通 session）→ `unavailable`
- 正常路径 → 返回 projection

## S3 — preload + renderer store：惰性加载与只读

**文件**
- `src/preload/index.ts`：`agent.readChildHistory`
- `src/renderer/stores/sessions/index.ts`：`selectTab` 惰性触发 + `historyOnly` 标记 + `send` 文案
- `src/renderer/stores/sessions/index.test.ts` 或新测试文件

**要点**
- 触发条件四条全满足才发请求（见 design.md）
- 失败也要标记「已尝试」，不反复打 IPC
- `historyOnly` 不进 persist（属运行态，重启后重新加载即可）

**测试断言点**
- 选中已结束 child → 调用一次 IPC，消息与 receipt 落入该会话
- 再次选中 → 不重复调用
- 请求失败 → 标记已尝试，不重试
- 活着的 child（`started:true`）→ 不触发

## S4 — 门禁与真机

- `pnpm typecheck` / `pnpm vitest run` / 对改动文件跑 Biome
- 真机：派发 → **优雅退出** → 重启 → 切到 child TAB → 应看到任务、回复、receipt
- 真机：确认该 TAB 发不出消息，且文案说明已结束
- 真机：确认容量未被回放占用（回放后仍能派发到 5 个）

## 风险

- `selectTab` 是同步 action，惰性加载要异步进行且不能阻塞 UI 切换
- 渲染层已有「未恢复 coworker」的文案分支，改动时不要影响活会话的正常路径
