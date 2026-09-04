# 修复主 agent 发送消息静默无响应

## 现象
发送消息后乐观回显上屏，但无 loading、无回复、无报错；只能重启 app 恢复。

## 根因（代码链路分析，见 session）
发送链路上存在多处静默失败，任一触发即表现为上述症状：

1. **僵尸轮**（`src/agent/supervisor.ts` `case 'prompt'`）：pi `isStreaming` 为 true 但投影 status 已 idle
   （abort 为 fire-and-forget，工具/流未真正结束），新消息被 `steer()` 塞进永不结束的旧轮。
2. **worker 内会话缺失**（gate catch）：`must()` 抛错后 `managed` 为空直接 return，不发任何事件；
   renderer 仍 `started:true`，后续 prompt 永远不走 spawn。
3. **会话串行门无超时**：任何 await 挂住即阻塞该会话后续所有命令。
4. **renderer 吞掉 `{ok:false}`**（`sessions/index.ts send()`）；worker 退出后 main 不自动重启。

## 方案
1. supervisor `prompt`：僵尸轮 → 再 abort + 限时 waitForIdle；仍不空闲则 `failTurn`，绝不静默 steer。
2. gate catch：会话缺失时对 prompt/steer 发 `parent-rejected`，renderer 清 `started` 并显示错误。
3. renderer `send()`：prompt/steer 失败写 `status:'failed'+error`；worker 不在/generation 过期时清 `started`。
4. main：worker 退出后下次 spawn 自动 `startAgentWorker()`。

每项独立 commit，TDD。

## 结果
- 0894763 fix(agent): 僵尸轮限时等空闲 / 超时 turn-failed；会话缺失发 parent-rejected
- a939420 fix(renderer): prompt/steer 失败显式报错、退回草稿、清 started
- b524761 fix(main): worker 退出后下次 spawn 自动重建，未 spawn 窗口命令入队
