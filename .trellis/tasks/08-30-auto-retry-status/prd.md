# 自动重试状态贯通：503 瞬态错误重试期间不再误报终态失败

## 背景 / 问题

pi SDK（AgentSession）内置瞬态错误自动重试（指数退避，默认开启）。上游 503 时：

1. pi 产出带 `errorMessage` 的 assistant 消息 → renderer 冒红色错误块；
2. pi 发 `agent_end`（带 `willRetry: true`），但 `src/agent/supervisor.ts` 的
   `agent_end` 处理忽略 `willRetry`：置 `idle` + 发 `turn-completed` →
   输入框解锁、Main 弹「回复完成」系统通知；
3. 几秒后 pi 发 `auto_retry_start` 并自动重发 → `agent_start` 又把状态拉回
   `running`，与用户输入冲突。

用户体验：「报错了、能输入了，结果又自己跑起来了」。

## 目标（方案 A：完整贯通）

1. **重试期间不 settle**：`agent_end.willRetry === true` 时不发 `turn-completed`、
   不置 idle、不弹通知；状态保持 running。
2. **重试可见**：消费 pi 的 `auto_retry_start`，向 renderer 发新事件
   `turn-retry`（attempt / maxAttempts / delayMs / error），UI 显示黄色
   「自动重试中 (n/m)，Xs 后重试 · 取消」提示条（带倒计时）。
3. **重试可取消**：新命令 `abort-retry` → `session.abortRetry()`；
   用户在重试期间发送消息 = 先 abortRetry 再发送（打断重试，以用户为准）。
4. **终态语义修正**：`agent_end.willRetry === false` 且末条 assistant
   `stopReason === 'error'` 时，发 `turn-failed`（status failed）而非
   `turn-completed` —— 红错 + 「会话失败」通知只在真正终态出现。

## 非目标

- 不改 pi 的重试策略（次数/退避在 pi settings）。
- 不做 503 错误消息在时间线中的样式弱化（保留原样，本任务只管状态贯通）。
- 快照恢复重试横幅（reload 期间横幅丢失可接受，下一个 status 事件自愈）。

## 改动面

| 层 | 文件 | 内容 |
|---|---|---|
| shared | `src/shared/types/agent.ts` | `AgentWorkerEvent` 加 `turn-retry`；`AgentCommand` 加 `abort-retry`；narrowing 同步 |
| agent | `src/agent/supervisor.ts` | `agent_end` 尊重 willRetry + 终态 error → turn-failed；处理 `auto_retry_start`；prompt/steer 前 abortRetry；新命令 `abort-retry` |
| renderer | `stores/sessions/reducer.ts` | 投影 `retry` 字段：`turn-retry` 设置、`status`/`turn-completed`/`turn-failed` 清除 |
| renderer | ChatView（或状态区组件） | 黄色重试横幅 + 倒计时 + 取消按钮 |
| main | `pairPolicy.ts` | `ALWAYS_FORWARD` 加 `turn-retry` |
| shared | `i18n.ts` | 横幅文案 |

## 验收标准

- [ ] 503 瞬态错误 + 将重试：不发 turn-completed、不弹通知、状态保持 running；
- [ ] renderer 收到 `turn-retry`，横幅显示 (n/m) 与倒计时；
- [ ] 重试成功后横幅消失（agent_start 的 status running 清除），轮末正常 turn-completed；
- [ ] 重试耗尽/被取消后走 `turn-failed`：status failed + 红错 + 「会话失败」通知；
- [ ] 重试倒计时期间点「取消」→ 立即落终态失败；
- [ ] 重试倒计时期间发送消息 → 重试被打断，用户消息正常开新轮；
- [ ] `pnpm typecheck && pnpm test` 绿，`biome check` 干净；
- [ ] TDD：agent.ts narrowing（turn-retry / abort-retry）与 reducer（retry 设置/清除）先写失败测试。
