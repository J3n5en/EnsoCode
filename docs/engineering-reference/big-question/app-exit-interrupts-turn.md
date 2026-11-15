# 应用被关掉/杀掉时，正在跑的回合被当成模型错误

## 症状

安装脚本 `pkill` 掉正在运行的应用后覆盖安装并重启，之前正在等流式响应的会话：

- 状态变成 `idle`（不是 `error`，也不是 `failed`），最后一条消息停在半路；
- 秘书以为它还在跑，不报中断；
- 用户看到一句莫名其妙的模型 API 错误：

```text
OpenAI Responses stream ended before a terminal response event
```

## 根因

进程被杀时，worker 和会话都没有机会收口，三件事同时缺失：

1. 退出时没有记下「谁正在跑」，重启后无从判断哪些会话是被打断的；
2. 模型层只看到连接断掉，报出来的是断流/断连错误，被当成普通会话失败；
3. 会话状态落成 `idle`，上层（秘书、看板）按「空闲」判定，看不出它是被中断的。

注意与 `responses-sse-eof-terminal-event.md` 区分：那条是网关省略末帧空行，同一会话重试必挂；
这条是**应用退出窗口内**才会出现，重启后同一请求能正常跑。

## 修法

- 退出路径（`before-quit` + `SIGTERM`/`SIGINT`）同步写
  `userData/agent/running-at-exit.json`：conversationId、turnId、开始时刻、最后一条消息下标。
  被 `SIGKILL` 时来不及写，靠 20 秒心跳把「退出时刻」框住（心跳只在有回合在跑时写盘）。
- 启动时读这份记录（进程已不在、且不超过一天才采信），把会话标成 `interrupted`，
  并在时间线钉一条系统提示：几点被关、什么原因（安装更新 / 正常退出）、
  哪些工具调用没有结果（可能只执行了一半）、可以点重试。
- 退出窗口是 `[退出时刻 - 30s, 启动时刻 + 10s]`。窗口内的断流/断连错误在 Main 统一改判成
  `interrupted`（`turn-failed` 带 `interrupted` 字段），会话正文不再落红，秘书回传按
  `interrupted` 而不是 `failed`；窗口外的同类错误仍按真实失败处理。
- 判定与文案都在 `@shared/exitInterrupt`，读写文件在 `main/services/runningAtExit.ts`，
  启动恢复在 `main/services/interruptedTurns.ts`（同时留 `interrupted-turns.log` 审计行）。

## 回归防线

- `src/shared/exitInterrupt.test.ts`：窗口边界、错误归类（鉴权/限流不吞）、提示文案。
- `src/main/services/runningAtExit.test.ts`：退出写入、空列表删文件、心跳、tmp+rename。
- `src/main/services/interruptedTurns.test.ts`：正常退出、SIGKILL（只有心跳）、进程还活着、
  过旧记录、窗口内外、事实文件只描述本次启动。
- `src/main/services/exitWindow.test.ts`、`reducer.test.ts`、`timeline.build.test.ts`：
  窗口内改判成 `interrupted` 且不落红，窗口外仍失败。
- `secretary/results.test.ts`、`secretary/host.test.ts`、`shared/secretary/commands.test.ts`：
  回传带原因、看板/进行中显示「已中断」。

## 相关代码

- `src/shared/exitInterrupt.ts`
- `src/main/services/runningAtExit.ts`、`interruptedTurns.ts`、`exitWindow.ts`、`exitInterruptHost.ts`
- `src/main/index.ts`（退出记录 / 心跳 / 启动恢复）
- `src/main/ipc/agent.ts`（`markExitInterrupted`、`agent:take-interrupted-turns`）
- `src/renderer/stores/sessions/interrupted.ts`、`timeline.ts`、`components/chat/TimelineRow.tsx`
