# 排队消息撞上下文压缩

## 症状

轮次结束后排队消息 / goal 续跑 / 「打断并发送」偶发报
`Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.`，
或压缩较久时报 `The previous turn is still running and could not be interrupted`；
修掉报错后，压缩结束又会把下一条排队消息并发发出去。

## 根因

- 持续记忆扩展在 pi 的 `agent_settled` 后用 `setTimeout(0)` 才调 `ctx.compact()`；
  supervisor 早在 `agent_end` 就发了 turn-completed，renderer 已泵出下一条 prompt，
  到 worker 时手动压缩正在跑，pi `prompt()` 直接抛错。
- pi 自动压缩在 `agent_end` 之后、`_isAgentRunActive` 仍为 true 时进行，
  prompt 被当成僵尸轮只等 5 秒就失败。
- 排队 prompt 等到 5 秒仍见 `isStreaming` 就 `failTurn`。活轮还在产出（工具输出、
  token）时投影可能已是 idle，这次失败不打断原轮，横幅一直盖着正常输出；
 若 `agent_end` 已把 `settlePending` 记下，失败还会清掉它，随后的 `agent_settled`
 不再收口，横幅不会自己消失。
- `waitForIdle()` 在 `agent_settled` 发出后同步唤醒，早于扩展的 `setTimeout(0)`：
  若醒来立刻起新轮，随后启动的压缩会 `abort()` 掉这轮。
- renderer 在压缩 end 时泵队列，不知道上一条 prompt 还在 worker 里等压完。

## 修法

- worker `prompt` 走 `waitPromptable`：`isCompacting` 不限时 `waitForIdle`（不计僵尸时限），
  只对纯 streaming 限时；超时后若本窗仍有会话事件或投影已回到 running，继续等，
  静默挂死才按僵尸失败。已经记下 `agent_end` 时，失败不吃掉随后的 `agent_settled`。
  每次等过之后让一拍 `setTimeout(0)` 再复查，给延后压缩先启动的机会。
- renderer 压缩 end 时若时间线里还有 optimistic 回显（投递在途），不泵队列、不续跑 goal，
  交给那一轮 turn-completed 泵。

## 回归防线

- `src/agent/supervisor.agentDispatch.test.ts`：压缩中 prompt 等压完、自动压缩超僵尸时限不失败、
  空闲后下一个宏任务才启动的压缩、活轮仍在产出时不失败、误判失败后原轮收束清掉横幅。
- `src/renderer/stores/sessions/index.test.ts`：压缩结束时已有投递在途不再泵下一条。

## 相关代码

- `src/agent/supervisor.ts`：`case 'prompt'`、`waitPromptable`
- `src/agent/continuousMemory/vendor/hooks/compaction-trigger.ts`
- `src/renderer/stores/sessions/index.ts`：`compaction` 事件处理、`flushQueue`
