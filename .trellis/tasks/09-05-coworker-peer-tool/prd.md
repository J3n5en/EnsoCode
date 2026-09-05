# 同事点对点消息工具

## Goal

同事可以自己发给同父会话下的另一个具名同事，不必经主管 `coworker message` 代投。主会话 LLM 默认不吃这段对聊。

## Requirements

- 同事会话挂独立工具 `message_coworker`（`to` + `text`），与 `message_main_agent` 并列。
- 只能发给同父下、且不是自己的具名同事；未知对象报错，回执带现有 roster。
- 投递复用现有 notifier：对方 idle 唤醒，busy 搭下一轮，不打断当前轮。
- 主会话 `session.prompt` / 合成通知 **不**因这次点对点被调用。
- 接收方 Tab 时间线能看到这条（走对方会话的 notification 注入）。
- 父级 `coworker message` 保留，供主管偶发代投。
- 不给同事完整 `coworker`（不能 spawn / dismiss）。

## Acceptance Criteria

- [x] `message_coworker` 文案说明回信走对方自己的 `message_coworker`，不是主管 `send`
- [x] 发给存在的同事会 `notify` 对方，文案含 from + body
- [x] 未知 `to` / 发给自己：不 `notify`，回执含 roster
- [x] supervisor：同事 extraTools 含该工具；调用后目标被唤醒，父会话不被 prompt
- [x] 父级 `coworker message` 原行为保持
