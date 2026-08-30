# 实现计划

串行 6 个 commit，每个独立可验证、可回滚。TDD：逻辑改动先写失败测试。

## C1 — R1+R6：渲染层 dismiss 兜底 + ended 标记（纯 store/reducer，先修最痛的）

**文件**：`src/renderer/stores/sessions/index.ts`、`reducer.ts`、对应测试

- reducer：`child-ended`/`child-rejected` 置 `ended: true`；`coworker-update`（非 dismissed）与新 generation 领养时清除；partialize 保留该字段
- `dismissCoworkerFromUI`：await IPC；`!ok && !started && !spawning` → 本地移除（删会话、coworkerIds 过滤、activeTabId 回落）

**测试**：
- child-ended → ended=true 且跨 partialize 存活；coworker-update 复活 → 清除
- 死 tab dismiss：IPC 失败 → 本地移除三件套；活 tab dismiss：IPC 失败 → 状态不动
- started coworker dismiss 成功 → 本地不动（回流驱动，钉住单一数据流）

## C2 — R2：清死代码

**文件**：`src/renderer/stores/sessions/index.ts`、`src/preload/index.ts`、`src/shared/types/ipc.ts`、`src/main/ipc/agent.ts`

- 删级联段（index.ts:1267-1290）、preload `spawnCoworker`、通道常量、墓碑 handler
- store `hireCoworker` 暂时改为返回错误占位（C5 接新通道），或本 commit 一并删 UI 调用点防死链

**验证**：typecheck 全绿（引用清干净）；现有 resume 测试不再触发 spawnCoworker mock

## C3 — R5：dismiss 降级链（Main + worker `dismiss-coworker` 命令）

**文件**：`src/shared`（命令类型+解析）、`src/agent/supervisor.ts`（case）、`src/agent/worker 协议解析`、`src/main/services/agentHost.ts`、`src/main/ipc/agent.ts`、测试

- shared 命令类型 + 白名单解析器（三方一致，解析失败 warn）
- supervisor `case 'dismiss-coworker'`：`mustCurrent(parent)` → 现有 `dismissCoworker`
- Main handler 降级链：ChildSessionIdentity → dismiss-child；parent.coworkers 命中 → dismiss-coworker；否则 not-found

**测试**：
- handler 三分支（含 exact parent generation 拒绝旧代）
- supervisor：旧 parent generation 的 dismiss-coworker 被拒；正常路径发 coworker-update dismissed
- 解析器负向：未知字段/缺字段被拒且 warn

## C4 — R3 核心：Main 级联恢复

**文件**：`src/main/services/agentSessionIndex.ts`（reserveChildResume）、`src/main/services/agentDispatchService.ts` 或新 service（restoreChildren）、`src/main/ipc/agent.ts`（parent-ready 挂钩）、`src/agent/supervisor.ts`（`resume-coworker` case + typed 容量豁免）、shared 命令类型、测试

顺序（每步先测后码）：
1. `reserveChildResume`：metadata 驱动、容量/撞名失败返回码、新 generation
2. supervisor：`spawn-child` 容量检查加 `!resumeFile` 豁免；`resume-coworker` case → spawnCoworker(resumeFile)
3. `restoreChildren`：读持久化 → 筛选（ended/dismissed/已活跳过）→ 形状分派 → 逐个尽力恢复；幂等（parent generation 键）
4. parent-ready 挂钩（agent.ts:302 特判处）；注意与 dispatchService.ensureParentReady 的 parent-ready 并发（派发触发的 parent-ready 也会进来——restoreChildren 幂等即可）

**测试**：
- restoreChildren 筛选矩阵：ended 跳过 / 已活跳过 / typed 类型已删跳过 / legacy 走 resume-coworker / typed 走 reserve+spawnChild(resumeFile)
- 幂等：同 generation 二次 parent-ready 不重复 spawn
- sessionFile 只从 persistedConversation 取（恶意渲染层字段不采信）
- Enso locked：模型取恢复后 parent 模型

## C5 — R4：手动雇佣接 dispatch

**文件**：`src/shared/types/ipc.ts`、`src/main/ipc/agent.ts`、`src/preload/index.ts`、`src/renderer/stores/sessions/index.ts`、`CoworkerTabs.tsx`、测试

- `AGENT_HIRE_COWORKER` 三点式；handler 来源校验（isMainWebContents + root/active 会话）
- store `hireCoworker` 改调新通道；tab 选中逻辑沿用（child-ready 回流建会话）

**测试**：handler 拒绝非 main webContents / 非 root 会话；正常路径转 dispatchService.hireCoworker

## C6 — 真机验证 + spec 沉淀

- `pnpm typecheck && pnpm vitest run` + Biome 全量
- enso-cdp 真机脚本：
  1. 工具雇 coworker + @派发一个 child → 对话几轮 → 优雅退出 → 重启 → 父会话打开：coworker 活着可对话（AC1），已结束派发 child 只读（AC2）
  2. 未恢复 tab 关闭（AC3）；活 (c) 类 coworker 关闭 → 主 agent 收通知（AC3）
  3. UI `+` 雇佣 → typed child tab 出现（AC4）
- 视发现沉淀 spec（trellis-update-spec）：Main 权威 resume 的口径、双形状过渡命令的登记

## 风险与回滚点

- **C4 是风险集中区**：parent-ready 并发触发（用户 resume vs 派发 ensureParentReady）——幂等键必须是 parent generation；测试要覆盖两路同时到达
- reservation 容量：resume 与新派发抢容量的边界（恢复中用户立刻 @派发）——reserveChildResume 与 reserveChild 共用 occupied 计数即可，无需额外锁
- worker 协议改动需三方一致（shared/types.md 教训）：解析器白名单漏字段会静默丢命令
- 每 commit 独立回滚；C4 回滚后 C1-C3 仍成立（死 tab 可关、dismiss 可用，只是不自动恢复）

---

## 执行记录（2026-08-30）

全部完成，6 个 commit：

| Commit | 内容 |
|---|---|
| ca96deb | C1 死 tab 可关闭 + ended 落盘 |
| 241fd72 | C2 删死通道与级联遗留 |
| 5cd4575 | C3 dismiss 降级链 + dismiss-coworker 命令 |
| 46fe22d | C4 Main 级联恢复（reserveChildResume + restoreChildren + resume-coworker） |
| 68d09a1 | C5 手动雇佣接 dispatch（AGENT_HIRE_COWORKER） |
| 0e8fc11 | C6 真机发现的修复：resume 撞名自撞 |

### 真机验证结果（隔离 userData + fake provider）

- AC1 ✓ typed + 工具直雇 coworker 优雅退出重启后均恢复为活会话，历史完整（6/2 条），可继续对话
- AC3 ✓ 活 legacy coworker UI 解雇成功（修复前必然失败）；文件丢失的死 tab 本地移除成功（修复前永远关不掉）
- AC4 ✓ UI `+` 雇佣走 dispatch，雇出 typed child 并选中 tab
- AC2/AC5/AC6 由单元测试覆盖（ended 筛选矩阵、类型已删跳过、路径全 Main 侧）
- AC7 ✓ typecheck / vitest 769 全绿 / biome 干净

### 真机踩坑记录

- reserveChildResume 撞名自撞（usedNames 扫持久化，恢复者自己的名字必然在盘上）——单测夹具没带自身持久化条目所以没抓到；已补真机形状回归测试
- CDP 验证时多次被残留 electron 实例误导（9222 被旧实例占用，`Cannot start http server for devtools` 出现即说明连的是旧代码）——验证前必须确认 9222 归属
