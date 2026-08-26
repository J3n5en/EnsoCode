# 会话回退(仅对话)— P0

## 背景

pi 会话 jsonl 是 parentId 树,SDK 原生提供 `AgentSession.getUserMessagesForForking()`(列出可回退点)与 `AgentSession.navigateTree(targetId)`(把 leaf 移到早前 entry,历史保留为分支,若目标是 user 消息返回 `editorText` 供重编辑)。参考实现 pi-rewind 扩展的对话回退也是同一 API。本期只做「仅对话」回退;文件 checkpoint(git 快照)为 P1,另起任务。

## 需求

1. 用户可在聊天时间线上任一 user 消息处触发「回退到这里」。
2. 回退后该 user 消息及之后的消息从时间线消失(历史仍留在 jsonl 分支中,不删数据)。
3. 被回退的 user 消息文本预填回输入框,用户可编辑后重发(Claude Code esc-esc 体验)。
4. 仅 idle 且已 spawn 的会话可回退;running 中不提供入口(或置灰)。
5. coworker 会话同样支持(链路同构)。

## 约束

- 沿既有 AgentCommand/AgentWorkerEvent 命令链路,不引入新通信机制。
- 渲染层投影复用既有 `message-upsert` + `messages-truncated` 回放,不新增投影逻辑。
- 消息定位用「第 N 条 user 消息」序号,worker 侧经 `getUserMessagesForForking()[n].entryId` 换真实 id(投影消息不含 entryId)。
- 不调 `summarize` 选项(不生成 branch_summary,避免额外一次模型调用)。

## 验收标准

- [ ] 时间线 user 消息 hover 出现回退入口,点击后其后消息消失、文本预填输入框。
- [ ] 回退后继续发消息,新轮次正常;jsonl 内旧分支 entry 仍在。
- [ ] running 会话无回退入口;未 spawn(待 resume)会话无入口。
- [ ] 回退后 app 重启 resume,回放的是新分支(leaf 路径)。
- [ ] typecheck / lint / 既有测试通过。
