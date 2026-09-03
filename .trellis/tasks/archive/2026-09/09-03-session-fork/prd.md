# 会话分叉

## Goal

idle root 从某条用户消息（或压缩点）开平行会话：源线不动，新线停在锚点。

## Requirements

- 仅 idle、已 spawn 的 root。running / coworker / historyOnly 不做。
- 走 `SessionManager.createBranchedSession(leafId)` 出新 jsonl；不要对源会话调 `AgentSessionRuntime.fork`。
- 权威：`createConversation` 后写 `forkedFrom: { conversationId, entryId }`；失败回滚权威行。
- 默认共用 cwd/worktree，不新建 worktree。标题 `原标题 (分支)`。默认打开新会话。
- UI：用户消息 Rewind 旁「从此处开平行会话」；Inspector 压缩点旁可分叉。

## Acceptance

- ≥4 轮 idle 会话中间用户消息分叉：源消息数不变，新会话停在锚点可续聊；重启双线可 resume。

## Out

- 自动合并、分叉时新 worktree、从 coworker 分叉、running 中分叉。
