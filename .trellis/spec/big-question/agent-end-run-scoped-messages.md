# pi 的 agent_end.messages 只含本轮消息

## 症状

多轮对话时,第二轮结束后 UI 消息列表**只剩第二轮的两条**,历史轮次全部消失。
agent 本身记忆正常(能答出第一轮告诉它的信息),坏的只是投影。

## 根因

supervisor 在 `agent_end` 用事件携带的 `messages` 做全量对齐(reconcile + 截断)。
但 pi 的 `agent_end` 事件里 `messages` 是**本次 agent run 的消息**,不是会话全量。
第二轮结束时拿 `[user2, assistant2]` 从 index 0 开始覆盖,再截断到 2 条,
把第一轮抹掉了。M0 与早期验证都是单轮,没暴露。

## 修法

对齐的权威源用 `session.messages` getter —— pi 文档明确它是
*"All messages including custom types"*(全量):

```ts
case 'agent_end': {
  this.reconcileMessages(sessionId, managed, managed.session.messages as unknown[]);
  ...
}
```

见 `src/agent/supervisor.ts`。

## 判别方法

多轮对话后消息条数不增反减、且第一条变成了最近一轮的 user 消息,就是拿
run-scoped 列表当全量对齐了。验证方式:连发两轮再 dump `conversation.messages`,
应当是 4 条而不是 2 条。
