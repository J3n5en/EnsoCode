# 技术设计 — 会话回退(仅对话)

## 数据流

```
UserMessage hover「回退」
  → sessions store.rewind(conversationId, userIndexFromEnd)
  → preload agent.rewind → main ipc 转发 AgentCommand
  → worker supervisor case 'rewind'
      guard: status === 'idle'
      entryId = 当前分支 user entry(从末尾数第 N 条)
      result = await session.navigateTree(entryId)   // 不带 summarize
      reconcileMessages(session.messages)            // 既有 message-upsert + messages-truncated 回放
      emit { type:'rewind-done', editorText }
  → renderer reducer 截断消息;store 收 rewind-done 把 editorText 预填输入框
```

## 关键决策

1. **消息定位:从末尾数的 user 序号(`userIndexFromEnd`,0 = 最后一条 user 消息)**。
   投影 `session.messages` 经 `buildSessionContext` 处理过 compaction(老消息可能被摘要合并),
   绝对序号会错位;而 compaction 保留的是尾部消息,从末尾对齐在两侧恒成立。
   worker 侧从 `sessionManager.getBranch()` 过滤 `type==='message' && message.role==='user'`
   的 entry,取倒数第 N 条的 id。不用 `getUserMessagesForForking()`(其范围含全树/语义不明,
   getBranch 明确是当前路径,与投影同源)。

2. **回放零新逻辑**:navigateTree 后直接复用 `reconcileMessages`,它已处理截断
   (`messages-truncated`,含 timings 平行数组同步截断),renderer reducer 已支持。

3. **新增事件 `rewind-done`**:携带 `editorText?`(navigateTree 对 user 目标返回被回退
   消息文本)。renderer store 收到后写入 per-conversation 草稿,ChatInput 消费一次。
   navigateTree 返回 `cancelled/aborted` 时不发 truncate 之外的副作用,发 `rewind-done` 不带文本即可。

4. **守卫**:
   - worker:非 idle 拒绝(抛错走既有 status failed 通路?否——回退失败不该把会话标 failed,
     改为静默忽略 + `rewind-done` 无 editorText;设计上 UI 已在非 idle 时不给入口,这是竞态兜底)。
   - renderer:`status !== 'idle' || !started` 不渲染入口;spawning 同理。

5. **coworker**:命令带的 sessionId 即 coworker 会话 id,supervisor 的 sessions map 天然覆盖,无需特判。

## 类型变更(src/shared/types/agent.ts)

- `AgentCommand` += `{ type: 'rewind'; sessionId: string; userIndexFromEnd: number }`
- `AgentWorkerEvent`/`RendererAgentEvent` += `{ type: 'rewind-done'; sessionId; seq; editorText?: string }`
- parse/校验函数(`parseAgentWorkerEvent` 附近 switch)同步补 case。

## 兼容与回滚

- 纯增量:新命令/新事件,不动既有分支。回滚 = 移除新增 case 与 UI 入口。
- jsonl 格式不变(navigateTree 是 pi 原生 append-only 语义),老版本 app 打开回退过的
  会话文件也只是沿 leaf 路径回放。
