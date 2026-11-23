# 未确认消息导致回退多撤一轮

## 症状

断流后发送“继续”未生效，再回退该消息，之前一轮的任务进度也消失；选择“对话＋文件”时还可能撤掉上一轮文件修改。

## 根因

Renderer 的消息列表包含乐观回显，worker 的当前分支只包含实际持久化记录。两边各自解析 `userIndexFromEnd=0` 时，前者指向未确认的“继续”，后者却指向上一条执行指令。Todo 和 Plan 按回退后的记录重建，进度归零是错误锚点的后果，不是 Plan 主动清空。

## 修法

桌面回退使用持久化 user `entryId`，无 ID 或仍为 optimistic 的消息不允许回退。确认框和冷唤醒等待期间都保留同一 ID；worker 只在当前分支查找该 ID，缺失时拒绝，不能降级为倒数位置。消息投影从源 entry 绑定 ID，不按正文匹配，避免重复“继续”串号。

回退被拒时恢复权威投影，IPC 投递失败时撤销界面乐观裁剪。旧手机协议仍保留数字锚点兼容，本次不改变手机协议或断流重试机制。

未送达消息的「撤回」是独立本地操作：本地队列可撤回；乐观气泡只有收到 worker 的 `delivery-rejected` 回执才可撤回，不能根据会话 failed 或缺少 entryId 推测未送达。worker 依据 SDK 公共 `preflightResult` 判定拒收：pi 0.87 在 preflight 抛错前回调 `false`；pi 0.99 起只在接受后回调 disposition（`handled` / `queued` / `started`），被拒绝时不回调直接抛错，因此「`prompt()` 抛错且从未回调」即拒收。SDK 升级需复检接受路径的回调仍发生在消息提交之前。撤回仅移除精确 deliveryId/队列 ID，将文字和附件追加回草稿，不导航会话树或还原文件；等待中断后发送的队列项在真正发送前须再次检查是否仍存在。

已拒收的气泡不能被另一条同文消息的 upsert/snapshot 匹配吞掉。结果不明、仍在发送或已进入 worker 队列的消息不开放本地撤回。

乐观气泡也不能充当运行态或新的权威轮次：否则 idle/failed 会话会一直显示「生成中」却没有停止按钮，后发消息确认上屏后还会被旧乐观尾巴排到前面。`chatTimelineActivity` 只以 running 判断生成中；`buildTimeline` 单独标注未确认/拒收气泡，仅在展示层按发送时间插到较晚用户轮次前，保留消息绝对 key 和 reducer 的「权威前缀 + 乐观尾巴」。流式、工具状态、计时和轮次折叠均须忽略本地气泡的轮次边界；不要为修展示顺序直接排序 messages。

## 回归防线

- `conversationRewind.test.ts`：未确认消息、确认框目标消失、分页位移。
- `sessions/index.test.ts`：保留已有进度、冷恢复期间目标变化、投递拒绝和异常。
- `supervisor.compact.test.ts`：缺失 ID 不裁剪、不恢复文件；worker 投影与分支数量不同仍定位同一 ID。
- `transcript.test.ts` / `sessionHistoryTail.test.ts`：重复正文、压缩、冷热投影的 ID 一致且不污染原消息。

## 相关代码

- `src/renderer/stores/sessions/conversationRewind.ts`
- `src/renderer/stores/sessions/index.ts`
- `src/agent/supervisor.ts`
- `src/agent/transcript.ts`
- `src/main/services/sessionHistoryTail.ts`
