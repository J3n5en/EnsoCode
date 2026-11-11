# 完整模式打断发送，排队消息被发两次

## 症状

桌面窗口开着，在 PWA 完整模式里对排队消息点「打断并发送」。消息先作为新一轮发出；
几十秒后同一条又以插话（steer）出现在下一个工具边界。看起来像「退出 PWA 再打开又发了一次」，
jsonl 里同文 user 两条、间隔恰好是一次工具调用的时长。

## 根因

`abortRequested` 是 renderer 本地运行态（在 `RUNTIME_CONVERSATION_KEYS` 里，不随多窗口补丁同步）。
队列泵和目标续跑只在 leader 窗口执行，桌面窗口在线时 leader 是桌面而不是 PWA。
PWA 发起中断，桌面不知道；被中断那一轮的 `turn-completed` 到达桌面时，它照常 `flushQueue`。
此时 PWA 的出队补丁还没到，桌面队列里仍有这一条，于是再发一次。
worker 正在跑 PWA 发出的新轮，`prompt` 被转成 steer。

## 修法

以 worker 为准：`abort` 命令打断运行中的轮次时记 `turnAborted`，该轮的 `turn-completed` 带
`aborted: true`。所有窗口见到它都不泵队列、不续跑目标。本地 `abortRequested` 仍保留，
兼容中断在途时的判断。新轮起点和失败收口都会清掉这个标记，避免它带到下一轮。

凡是只在 leader 执行的副作用，判断条件不能只读本窗口的运行态。

## 回归防线

- `src/agent/supervisor.silentTurn.test.ts`：中断轮带 `aborted`，下一轮不沿用
- `src/renderer/stores/sessions/index.test.ts`：无本地中断标记、收到 `aborted` 也不泵队列

## 相关代码

`src/agent/supervisor.ts`（`abort` / `completeTurn`）、`src/renderer/stores/sessions/index.ts`（`turn-completed` 收口）、
`src/renderer/stores/sessions/persistSnapshot.ts`
