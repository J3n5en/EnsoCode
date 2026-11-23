# 子代理把命令转到后台后 Run 立刻收口，报告只有「等待 X」

## 症状

- 子代理的 bash 超过前台时限，命令转为后台任务。子代理随即结束回合，父会话的 `wait` 立刻返回 succeeded，报告只有一句「等待 X 完成」，没有结果。
- task 和 coworker 模式都会出现，Opus、grok 等不同厂商的模型都会出现，所以不是某个模型不听话。
- 任务跑完之后，子代理也没有再动：子代理 tab 里看不到新的一轮。
- 在 brief 里加「跑完再结束」只能减少发生次数，没法根除：模型照着工具回执做，结果还是一样。

## 根因

三处行为互相矛盾，没有哪一处单独看是错的：

- bash 回执和系统提示都告诉模型「结束回合，后台命令跑完会唤醒你」（`src/agent/shell/receipts.ts`、`src/agent/backgroundTasks.ts`、`src/shared/shellHints.ts`）。
- 子会话的后台任务完成时只会搭在下一条工具结果上，不会唤醒子代理（#369）。这条规则本意是不打扰父会话，同时避免在 Run 已经收口后又把子代理叫醒。
- `AgentService.observe` 收到 `turnId === runId` 的终态，就把 Run 收口。

所以子代理照着回执结束回合后，Run 当场收口，之后也不会再有人唤醒它。

另外，子代理当时根本没有 `task_output` / `task_stop` / `task_settle`：回执让它用 `task_output` 查结果，它做不到。

## 修法

- #394：子代理 Run 的某一轮结束时，如果它自己起的后台任务还在跑、且没有表态，worker 就持有这次 Run（`ManagedSession.agentRun`），这一轮的 `turn-completed` 带 `awaitingTasks`。任务完成时如果子代理空闲，就唤醒它；之后每一轮的终态都带 `continues` 指回原 Run。`AgentService` 同时认 `turnId` 和 `continues`，遇到 `awaitingTasks` 不收口。持有期间：
  - 子代理空闲时被 abort，单独发一个 aborted 终态。
  - 子代理空闲时收到插话，开新的一轮。pi 对空闲会话的 steer 只会入队，不开回合。
  - 持有满 `AGENT_RUN_HOLD_LIMIT_MS`（10 分钟），唤醒子代理，要它表态并交报告。
  - Run 被叫停或子代理被回收时，停掉它在等的任务。
- #395：非只读子代理挂上只管自己任务的 task 工具。第一次因某批任务进入持有时，唤醒子代理一次，交给它 `awaitChecklist`，这样常驻服务不用干等到时限。
- 只有 Main 带 `requestBudget` 发起的 AgentService Run 才会持有；Bot 成员和派发服务不受影响。

## 回归防线

- `src/agent/supervisor.childBackgroundTask.test.ts`：持有与唤醒、空闲 abort、空闲插话、时限、回收停任务、第一次持有的提醒、只读子代理没有 task 工具。
- `src/main/services/agentService.formal.test.ts`：有界穷举里加了三个动作，回合结束仍有任务、任务完成、空闲 abort。新增不变量：持有中的 Run 不会提前收口，也不会永远挂着。去掉时限后，模型会报「Run 停在未终结状态」。
- 修改工具回执或提示里关于唤醒的文案时，先确认子会话也真的会被唤醒。

## 相关代码

- `src/agent/supervisor.ts`：`completeTurn` / `failTurn` / `holdRun` / `onCompletionNotify` / `case 'steer'` / `case 'abort'`
- `src/main/services/agentService.ts`：`observe` 的 `continues` / `awaitingTasks` 分支
- `src/agent/taskHygiene.ts`：`awaitChecklist`
- `src/shared/childProfileTools.ts`：子代理工具档推导，与 worker 装配一致
