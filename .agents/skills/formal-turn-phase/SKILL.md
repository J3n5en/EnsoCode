---
name: formal-turn-phase
description: >
  有界穷举验证 worker 轮次相位：每个用户轮次恰好收到一个终态、终态之后 pi 不再为这一轮自行续跑、被中断的轮次终态带
  aborted、每条 prompt 恰好进入 pi 一次或收到一次未送达回执。改动 src/agent/supervisor.ts 的 case 'prompt' / 'abort' /
  'abort-retry'、onSessionEvent 的 agent_end / agent_settled / auto_retry_* / compaction_*、completeTurn、failTurn、
  promptFresh、interruptRetryIfAny、waitPromptable，或升级 @earendil-works/pi-coding-agent 时使用；也用于"提前标完成或失败"
  "输入解锁后 agent 自己又跑起来""排队消息重复或丢失""compaction in progress""中断后队列仍被泵"类问题。
---

# worker 轮次相位的形式化验证

属性：pi 的每一次运行（一个用户轮次）恰好收到一个 `turn-completed` 或 `turn-failed`，终态之后 pi 不再为这一轮发出 `agent_start` 或 `auto_retry_start`，用户中断的轮次终态带 `aborted`；每条发给 worker 的 prompt 恰好进入 pi 一次，否则收到一次带它 deliveryId 的 `delivery-rejected`，且只在它发出后有过叫停（中断、取消重试、新 prompt 打断重试、僵尸时限到点）时才收；被 pi 预检拒收（没有 key、input hook 抛错）的 prompt 也收一次回执，没有活轮时先收一个失败终态、回执排在它之后，有活轮时只收回执；全部静止后 worker 不停在 running。

终态按消费者的视角数：bots、headless、Main 和 renderer 都按会话、不按 turnId 把任何 `turn-*` 当作本轮结束，所以观察者把 worker 发出的每个 `turn-*` 都记到 pi 当前这一轮。未送达回执不是终态，不能借用 `turn-*`。

危害：违反时输入框提前解锁、agent 随后自己又跑起来，或者一直卡在 running；用户中断后其他窗口和 headless 照常泵队列、续跑 goal；排队消息被重复发送、静默丢失，或报 `Cannot submit a prompt while compaction is in progress`。

## 运行

```bash
pnpm test:formal
```

`pnpm test:formal`（`ENSO_FORMAL_FULL=1`）跑完整界限，约 3 万个状态，空载约 20 秒（CI 约 23 秒）。`pnpm test` 日常跑小界限，约 1400 个状态，空载约 1 秒；机器满载时两者都会慢一个数量级以上。只跑本模型：

```bash
ENSO_FORMAL_FULL=1 npx vitest run src/agent/turnPhase.formal.test.ts
```

工具是 vitest 内的有界穷举，不用额外安装。`src/agent/turnPhase.formal.test.ts` 起真实的 `SessionSupervisor`，把 pi 的 `AgentSession` 换成按 1.5.1 源码写的 `Pi` 类，再把全局 `setTimeout` 换成虚拟时钟。客户端命令、pi 的每一步、计时器到点按任意顺序交错。真实代码的闭包无法克隆，所以每条分支从头回放；回放后状态与第一次到达时不一致就抛 `回放不确定`。

## 怎么读结果

失败消息就是最短反例：编号步骤加一行 `=> 违反了什么`。步骤分三类：

- `客户端 prompt pN`、`客户端 abort`、`客户端取消重试`：`supervisor.handleCommand` 的 `prompt`、`abort`、`abort-retry`。
- `pi ...`：`Pi.actions()` 的一步，对应 `agent-session.js` 里一段之间没有宏任务的代码。`收尾` 表示 `agent_end` 之后 `_handlePostAgentRun` 到 `_emitAgentSettled` 一口气跑完。
- `计时器到点：僵尸时限 / 让一拍 / 记忆压缩触发 / 150ms`：分别是 `waitIdleBounded` 的 5 秒、`waitPromptable` 的 `setTimeout(0)`、`compaction-trigger.ts` 的 `setTimeout(0)`、`flushPendingReminders`。

违反类别：`第 N 轮收到 2 个终态`、`终态 X 之后 pi 仍为第 N 轮发出 agent_start`、`pN 进入 pi 两次`，以及静止时的 `第 N 轮没有终态`、`第 N 轮被中断，终态却是 turn-completed`、`worker 停在 running`、`pN 没进 pi，未送达回执 M 次`。回执类：`pN 没被叫停却收到 delivery-rejected`、`pN 进了 pi 又收到 delivery-rejected`、`pN 收到 2 次 delivery-rejected`、`未知投递 X 收到 delivery-rejected`。

判断真 bug 还是模型错：

1. 把反例里每个 `pi ...` 步骤发出的事件，对照 `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` 的同名函数（见覆盖表）。对不上是模型错，修 `Pi` 类，不要改断言。
2. `回放不确定` 说明有异步越过了虚拟时钟（真实文件或网络 I/O），去补 mock，不要加 flush 次数。
3. 对得上，就按反例写一个确定性单测复现（`supervisor.silentTurn.test.ts` 的 `spawn` 加 `parentSession.emit` 写法），再修 supervisor。
4. 绝不为了变绿放宽 `safetyViolation` / `quiescentViolation`，也不缩小 `core` 配置。`states` 下限断言保护探索规模，跌破下限先确认没有误删动作。

## 覆盖与同步

最后确认模型与代码一致的提交：`10360d2f9`（2026-11-22），pi 为 `@earendil-works/pi-coding-agent@1.5.1`、`@earendil-works/pi-agent-core@1.5.1`。

| 模型部分 | 代码 |
| --- | --- |
| 客户端命令 | `src/agent/supervisor.ts` `handleCommand` 的 `case 'prompt'`（`interruptRetryIfAny`、`waitPromptable`、`promptFresh`、`promptTracked`）、`case 'abort'`、`case 'abort-retry'` |
| 收口 | `onSessionEvent` 的 `agent_end`（`willRetry`、`settlePending`）、`agent_settled`、`auto_retry_start`、`auto_retry_end`；`completeTurn`、`failTurn` |
| 僵尸时限与让一拍 | `waitPromptable`、`waitIdleBounded`、`ZOMBIE_TURN_WAIT_MS`、`activityNonce`，超时走 `emitDeliveryRejected` |
| `Pi` 的 prompt / abort / abortRetry | `agent-session.js` `prompt`、`_preparePrompt`（流式中要求 `streamingBehavior`，排进 followUp）、`_startRun`、`abort`（只在运行活跃时记 `_agentRunAbortRequested`，不清 followUp 队列）、`abortRetry`、`isStreaming` / `isCompacting` / `isRetrying` / `isIdle` |
| `Pi` 的收尾一步 | `_willRetryAfterAgentEnd`、`_handlePostAgentRun`、`_prepareRetry`、`_finishCancelledRetry`、`_checkCompaction`（溢出压缩续跑）、`_runBeforeSettleBoundary`、`_emitAgentSettled`（延后的 prompt 在公开 `agent_settled` 之后执行） |
| 撤回排队 prompt | `src/agent/sessionAdapter.ts` `withdrawFollowUps`：pi 没有只清 followUp 的公开接口，靠 `getFollowUpMessages()` 返回的标签数组原地清空、`agent.clearFollowUpQueue()`、私有 `_emitQueueUpdate`；`sessionAdapter.test.ts` 的真实 SDK 测试锁定这些形状，并断言 pi 的 `abort()` 不清 followUp。supervisor 在 `promptFresh` 收到 `queued` 时记下 pi 队尾文本，撤回时据此对上 deliveryId |
| 回复 error / aborted 不取排队消息 | `@earendil-works/pi-agent-core` `dist/agent-loop.js` |
| 记忆压缩 | `src/agent/continuousMemory/vendor/hooks/compaction-trigger.ts`：`agent_settled` 时排 `setTimeout(0)`，到点不空闲就放弃 |
| `agent_before_settle` 续跑 | `src/agent/oauthAccountPool.ts` |
| 桌面发送时机（`sendWhileRunning: false`） | `src/renderer/stores/sessions/index.ts` 发送时 `running` 或压缩中进本地队列 |

检查改动是否触及覆盖代码：

```bash
git diff --stat 10360d2f9..HEAD -- src/agent/supervisor.ts src/agent/continuousMemory/vendor/hooks/compaction-trigger.ts src/agent/oauthAccountPool.ts src/renderer/stores/sessions/index.ts package.json patches/
```

有改动时对照上表重读相关函数；`package.json` 里 pi 版本变了就逐个重读表中 `agent-session.js` 的函数。确认模型仍然描述代码、`pnpm test:formal` 通过后，才把本节的提交号和日期前移。有意改轮次协议（新事件、新收口点）时，在同一提交里更新 `Pi` 类、`observeWorker` 和本表。

## 自检：改坏代码，模型必须失败

下面每条在 `src/agent/supervisor.ts` 上临时改动，跑 `npx vitest run src/agent/turnPhase.formal.test.ts` 必须变红并给出所列反例，`git checkout -- src/agent/supervisor.ts` 后恢复全绿。改了模型或配置后至少重做前两条。

| 临时改动 | 对应历史 | 预期反例 |
| --- | --- | --- |
| `agent_end` 删掉 `willRetry` 分支，并在 `settlePending = true` 后直接调用 `this.onSessionEvent(managed, { type: 'agent_settled', aborted: false } as never)` | `11f05a9ef` 之前 | 503 后 `终态 turn-failed 之后 pi 仍为第 1 轮发出 auto_retry_start` |
| 只保留上一条的"`agent_end` 即收口"，留着 `willRetry` 分支 | `b760acc37` 之前 | 溢出或 before_settle 续跑：`终态 ... 之后 pi 仍为第 1 轮发出 agent_start` |
| `case 'prompt'` 的 `waitPromptable(...)` 换回 `isStreaming && !(await waitIdleBounded(...))`，并让 `promptFresh` 不再接住 `compaction is in progress` | `5e1dcf984` 之前 | 记忆压缩中发 p2，被拒后 `failTurn`：`第 1 轮收到 2 个终态：turn-completed、turn-failed` |
| `case 'abort'` 里 `const retrying = false` | `9985bae34` 之前 | 重试倒计时中中断：`第 1 轮没有终态` |
| `case 'prompt'` 在 `let activityAt` 前加 `if (managed.session.isStreaming) { await this.steerTracked(...); return; }` | idle 投影但 pi 仍在跑时插话 | p1 还在准备时发 p2：`p2 没进 pi，未送达回执 0 次` |
| `case 'prompt'` 僵尸超时分支的 `emitDeliveryRejected(...)` 换成 `this.failTurn(managed, 'zombie')` | 已知发现 3 修复之前（当时还带 `undelivered`） | 中断后工具 5 秒内没停、期间发 p2：`第 1 轮收到 2 个终态：turn-failed(aborted)、turn-completed` |
| `case 'abort'` 删掉 `withdrawQueuedPrompts` 那一行 | 已知发现 1 修复之前 | 随时发送时 p2 排进活轮后中断：`p2 没进 pi，未送达回执 0 次` |
| `cancelRetry` 删掉 `withdrawQueuedPrompts` 那一行 | 已知发现 2 修复之前 | p2 排进活轮、p1 遇 503 后取消重试：`终态 turn-failed 之后 pi 仍为第 1 轮发出 agent_start` |
| `promptFresh` 的 `reject` 里把 `emitDeliveryRejected` 挪到 `failTurn` 前面 | #392 review 前 | 空闲时发预检拒收的 p1：`p1 的拒收回执先于它的失败终态` |
| `promptFresh` 的 `reject` 无条件 `failTurn`（`ENSO_FORMAL_FULL=1`） | #392 review 前 | p1 在跑时 p2 排队、p3 被预检拒收，p1 遇 503 后取消重试：`第 1 轮没有终态` |

## 范围

验证范围：一个父会话；最多 3 条 prompt、1 次中断、1 次取消重试；pi 的意外各有上限（503 最多 2 次、上下文溢出 1 次、记忆压缩 1 次、`agent_before_settle` 续跑 1 次），`maxRetries = 1`。五组核心配置：桌面发送（running 时不发）、随时发送（bots、定时任务、`enso-server run`、跨窗口竞态）、僵尸时限可先到点、中断落在压缩与续跑上、预检拒收（客户端可发 1 条会被 pi 拒收的 prompt，随时发送且僵尸时限可先到点）。

建模假设：

- `agent_end` 到 `_emitAgentSettled` 之间只有微任务，算一步。依据是 `agent_settled` 只有 `compaction-trigger.ts` 一个同步扩展回调，`agent_end` 只有 `pluginEvents.ts` 的同步通知。新增异步的 `agent_end` / `agent_settled` 扩展回调，或 `agent_before_settle` 在 error 结局里走网络（`oauthAccountPool.ts`），都会打开这段窗口，模型需要拆步。
- `Pi.prompt` 同步进入运行中，不建模 `_preparePrompt` 的异步 input hook 窗口。所以 `already processing` 竞态和"记忆压缩在 preflight 窗口启动"不在验证范围内。
- 去重时用"僵尸计时器登记后 pi 是否发过事件"近似 `stillLive` 的 `activityAt`。这可能少探索一些状态，不会报出假反例。

不覆盖：`steer`、`steerActive`、`withdraw-steer`；`retry` 命令（`continueSessionActivity`）；`rewind`、`compact` 命令与 `pendingCompact`；子代理与 coworker、请求预算、自适应降级、拒答重试、空轮次恢复、优雅重启、闲置回收、`shutdown`；renderer 的队列泵与 headless goal 续跑（只验证 worker 发出的终态和 `aborted` 标记）；Main 侧把退出窗口内的错误改判成 `interrupted`。

通过只说明上述范围内成立，不代表整条链路无误。

## 已知发现

暂无。曾报出的三条（僵尸超时清掉中断标记、排进活轮的 prompt 遇上中断、取消重试后同轮续跑）已修，触发条件已并入 `core`，确定性复现在 `src/agent/supervisor.turnFindings.test.ts`，自检表最后三行对应它们。

再报出真 bug 又不能当场修时：从 `core` 拿掉触发条件，另加一条断言该配置恰好只有这一类反例的测试，并记在本节；修好后并回 `core`、删掉那条测试。
