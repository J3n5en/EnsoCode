# Release idle worker sessions to bound agent memory

## Goal

Agent worker 的 `SessionSupervisor.sessions` 只进不出：点开过的会话（含 `AgentSession`
全量 jsonl 上下文）常驻到 app 退出；删除会话时 parent 本体不 release，成为孤儿。
目标：让 worker 驻留的会话集合有界，且删除会话立即释放。jsonl 是事实来源，
release 不丢数据，renderer 已有 `!started && sessionFile → 自动 resume` 的透明恢复。

## Requirements

1. **删除即释放**：`removeConversation` 对已 `started` 的 parent 调 `agent.release`。
2. **闲置回收（worker 侧）**：定期扫描，满足以下全部条件的 parent 会话走 `release-parent`
   同一路径并发 `parent-ended`（reason `evicted`）：
   - 非 pinned（pinned = 桌面正在查看 + 手机订阅中，由 main 下发 `pin-sessions` 命令）
   - `status === 'idle'`，无 `currentTurnId`
   - 无挂起 approval / ask / capability 请求，无 `pendingTaskReminders`
   - 无运行中的后台任务、无 coworker / subagent / 子会话
   - 距最近一次活动（收到命令或产生事件）≥ 30 分钟
3. 回收在该会话的串行门内执行，执行前重新校验条件（避免与刚入队的 prompt 竞态）。
4. worker 重启后 main 需重发 pinned 集合。

## Acceptance Criteria

- [x] 删除一个已启动、空闲的会话后，worker `sessions` 中不再有它（含其子会话）。
- [x] `selectEvictableSessions` 纯函数单测：pinned / running / pending / 子会话 / 未到期 均不回收；到期空闲回收。
- [x] 被回收的会话在 renderer 变为 `started:false`，再次点开自动 resume 并回放历史。
- [x] `pnpm typecheck && pnpm test && pnpm lint` 干净。

## Notes

- renderer 侧 goal 续跑 / 排队消息只在 turn-completed 触发，被回收的会话点开即恢复，不额外 pin。
- TTL 30 分钟 vs renderer 正文缓存 5 分钟：worker resume 需数秒（runtime/skill/MCP/回放），定得更长。
