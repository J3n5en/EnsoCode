# 大历史打开：先尾窗、再全量

## 行为差距
现在：resume 必须整卷 parse + 全量投影 + 一条巨型 snapshot 后才有正文；其间第一条 `status` 已清 `spawning`，转圈结束却是空白。
应该：首包只推最近一段（条数+字节双预算），马上可看可滚；全量稍后覆盖。worker 内存仍是整卷，upsert 绝对下标经 `baseIndex` 对齐。

## 层
- 纯函数：`takeSnapshotTail`（与手机 pair 同预算）
- 协议：`SessionSnapshot.baseIndex` 桌面也走（parser 白名单补字段）
- worker：resume 先 emit 尾窗，再 emit 全量
- reducer：尾窗落地 + upsert 减 `historyBaseIndex`；无 baseIndex 的全量快照整段替换

## 不做
- 桌面上滑分页 IPC（本轮全量仍会补上）
- 拆 SessionManager.open / 延后 skill·MCP
- `readChildHistory` 移出 Main
