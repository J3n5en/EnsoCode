# 无界面 goal 收到完成信号后仍继续烧轮次

## 症状

手机或 `enso-server` 在没有桌面窗口时跑 `/goal`，模型已经调用 `goal_complete`，会话却继续自动发「继续做」直到 25 轮。`enso-server run --goal` 如果只听 worker 事件、不处理 `goal-signal`，表现一样：进程不退出，或者最后以自动轮数用尽收场。

## 根因

goal 工具只负责发 `goal-signal`。把 goal 标成 completed / blocked / waiting 并决定要不要续跑，是渲染层和 headless 队列的事，不在 worker。`pairSessionHost` 原先不读这个事件，goal 状态一直是 `active`，每轮 `turn-completed` 都会再投一条 continuation。另外 `status: idle` 总是先于 `turn-completed` 到达，两边都泵队列时同一轮会续跑两次。

## 修法

`applyHeadlessGoalSignal` 在信号到达时改 goal 状态。headless 只在非中断的 `turn-completed` 上泵一次队列；`turn-failed` 暂停 goal。`enso-server run` 使用同一套判断，并加上与桌面一致的三次无进展暂停。

## 回归防线

`src/shared/pair/headlessQueue.test.ts` 覆盖信号之后不再续跑。`src/main/services/pairSessionHost.test.ts` 覆盖每轮只泵一次，以及 `goal_complete` 之后不再 `prompt`。`src/server/run/goalDrive.test.ts` 覆盖轮数上限和无进展。

## 相关代码

- `src/agent/goal.ts`
- `src/shared/pair/headlessQueue.ts`
- `src/main/services/pairSessionHost.ts`
- `src/server/run/goalDrive.ts`
