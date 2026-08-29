# 重启后回放 coworker child 历史

## 来源

从 `08-28-model-center-default-agent` 的真机验证中拆出。父任务已修复「纯派发父容器不落盘」
（commit `a0e78cb`），父会话的派发/完成通知现在能跨重启恢复；但 child TAB 的正文仍然回放不出来。

## 问题

重启后打开一个曾派发过的父会话：

- 父会话本身恢复正常，`agent-dispatch` / `agent-completed` 通知与 `receiptSummary` 都在 ✅
- child TAB 出现在 tab 条上 ✅
- **child 的正文是空的** ❌：没有任务、没有回复、没有 receipt

数据没有丢，磁盘上完整存着（`agent/sessions/enso-<parent>__cw-<child>-<gen>.jsonl`）：

```
enso-safe-session       (头，含 child/parent identity、cwd、createdAt)
safe-user-text          把应用主题改成暗色（dark）…
enso-operation
safe-model-result
capability-receipt
safe-assistant-text     已完成：应用主题已从 system 改为 dark。
```

缺的是**回放路径**：

- 切换到 child TAB 不触发任何恢复
- 直接 `resumeConversation(childId)` 被身份守卫拒绝（`invalid spawn request`）——
  child 不是持久化根会话，**这个拒绝是正确的**，不应为了回放而放宽它

## 与父任务验收项的关系

父任务 R10 要求「重启后打开同一父会话，仍能切到未销毁的 coworker child TAB 并看到此前回复与
完整已脱敏 receipt」。目前只做到通知那一半，本任务负责补齐 child 正文这一半。

## 待定的设计问题（进入 design.md 前需拍板）

1. **谁读 safe journal**：Main 读取并投影给 Renderer，还是 worker 恢复成一个真实 child session？
2. **恢复成什么形态**：只读历史视图，还是可继续对话的活 session？
   后者要重新走 reserveChild / capability 授权注册，牵涉 generation 语义与容量计数。
3. **保真度**：safe journal 是脱敏投影，`safe-assistant-text` 只有文本，工具调用细节与 thinking
   不在其中。回放出的 TAB 与原始 TAB 会不一致——这个差异是否可接受？
   若要求完全一致，需要让 child 另写 pi 的完整 session 文件，那是另一套持久化策略。

## 约束

- 不得放宽 child 的身份守卫（`persistedRootSpawn` 对直接 child spawn 的拒绝要保留）
- 不得新增 audit 文件或第二事实源
- 不得让 Main 直接写 jsonl

## 验收标准（草案，待 design 收敛后细化）

- [ ] 重启后打开曾派发过的父会话，切到 child TAB 能看到当时的任务与回复
- [ ] 危险操作的 receipt 在回放后仍可见，且仍为已脱敏形态（不含 raw params / 密钥）
- [ ] 回放不改变容量计数语义，也不复活已结束实例的可执行权限
- [ ] child 身份守卫未被放宽：直接对 child 发 spawn 仍被拒
