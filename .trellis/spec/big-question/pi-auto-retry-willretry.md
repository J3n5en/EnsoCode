# pi 自动重试期间误报轮次完成

## 症状

上游 503（瞬态错误）时：UI 冒红色错误、弹「回复完成/会话失败」通知、
输入框解锁——但几秒后 agent 又自己跑起来了，与用户输入冲突。
另外重启 resume 后，一次失败轮回放出多条重复红错。

## 根因

pi SDK（AgentSession）**内置瞬态错误自动重试**（指数退避），并通过三个信号
暴露状态，supervisor 起初一个都没消费：

1. `agent_end` 事件带 `willRetry: boolean` —— true 表示 pi 马上要自动重试，
   这**不是终态**。supervisor 无差别 settle（置 idle + 发 turn-completed）
   把非终态当成了终态。
2. `auto_retry_start` / `auto_retry_end` —— 重试的开始（attempt/maxAttempts/
   delayMs/errorMessage）与收尾。**取消重试（abortRetry）后没有后续
   `agent_end`**，必须在 `auto_retry_end(success:false)` 收口，否则投影永远卡
   running。
3. pi 的 session 文件会记录**每次尝试**的错误 assistant 消息，resume 回放
   会全部重现——投影层截断只救活体，救不了回放。

## 修法（本仓实现，src/agent/supervisor.ts + timeline.ts）

- `agent_end.willRetry === true`：不 settle，状态保持 running，投影里截掉
  末条瞬态错误消息（pi 稍后也会从自身状态删掉它重发）。
- `auto_retry_start` → 投影 `turn-retry` 事件（renderer/phone 显示横幅）；
  `auto_retry_end(success:false)` 且仍 running → failTurn 收口。
- 终态错误轮（末条 assistant `stopReason === 'error'`）发 `turn-failed`
  而非 `turn-completed`。
- **回放与实时统一在渲染层解决**：`buildTimeline` 两条规则——错误项后面
  紧跟另一条 assistant（已重试过）或末条且 running（重试倒计时中）都不渲染。

## 通用教训

1. **上游 SDK 的事件字段要全量看一遍再消费**。`willRetry` 就在 `agent_end`
   的类型定义里（`agent-session.d.ts`），漏看一个 boolean 导致整条轮次语义错乱。
2. **瞬态内容要从源头不渲染，不能先渲染再删**——message_end 先画红错、
   agent_end 再截掉，用户看到的是屏幕抽搐。判定放在 `buildTimeline` 纯函数里，
   桌面与手机（复用同一函数）一并生效。
3. 验证工具：`scripts/fake-provider-issue-27.mjs` 的 `GET /__fail?count=N&status=503`
   可模拟连续 N 次 5xx，配合隔离 userData 真机复现重试链路。
