# 乐观回显挡住冷会话的快照补回

## 症状

刷新/离开超过 5 分钟后回到一个**正在运行**的会话，先发一句话。之后聊天区只有
这一句，中间没有助手回复、没有 bash 工具卡；底下计时器（`lastOutputAt`）却一直
在走，输入框锁着「消息将排队」。磁盘 jsonl 与 `settings.json` 里的工具输出都在
往前推进——worker 是好的，坏的只是 renderer 投影。

极易误判为「又卡死了」或「刷新没刷出来」。

## 根因

三处各自合理的设计叠在一起：

1. 桌面故意不落盘正文（`partialize` 剥 `messages`），`evictColdMessages` 在 TTL 后
   清空内存正文，靠 worker `snapshot` 补回。补回的门写死 `messages.length === 0`。
2. `send()` 先本地插入 `optimistic: true` 的用户回显。长度变 1，门关了。
3. worker 推来的 `message-upsert` 带原 index（一百多）。reducer 里
   `index > 权威区长度` 时只推 `seq` + `lastOutputAt` 并丢正文（这本是为了防
   稀疏空洞崩溃），且**没有任何人再去要快照**。此后每条 upsert 都在续命计时器、
   却一条都进不了时间线。bash stdout 走 `tool-output` 另一条路进 `toolOutputs`，
   但没有工具卡可绑，同样不可见。

判据：落盘里该会话最后一条消息的时间戳 = 那条本地回显，而 jsonl 里已有更晚的
助手回合。

## 修法

`src/renderer/stores/sessions/`：

- `messageCache.hasAuthoritativeMessages()`：只有非 optimistic 消息算「有正文」；
  切会话时的快照门用它，不再用 `length === 0`。
- `reducer.upsertOutOfRange()`：store 在 `message-upsert` 进 reducer 前检测越界，
  越界即 `resyncSnapshot(id)` 向 worker 补要该会话快照（2s 去抖）。
- reducer 的 `snapshot` 分支不再整段替换：快照里已有同文本 user 消息的乐观回显
  视为已送达消费掉，其余在途回显保留浮在尾部。否则补回来的快照会把用户刚发的
  那句抹掉，又是另一种「消息凭空消失」。

## 教训

- **「丢弃事件」必须配「重新同步」**。任何为了防崩溃而静默丢弃权威事件的分支，
  都要想清楚：丢了之后谁来把状态追回来？只推 `seq` 不补数据 = 永久脱节。
- **本地乐观状态不能参与「是否需要拉权威数据」的判断**。`length`、`isEmpty` 这类
  门控要区分权威/乐观两种来源，否则乐观写入会把拉取门关死。
- 时间线为空但计时器在走，先 dump `conversation.messages` 看是否只剩
  `optimistic: true` 的条目，再看 jsonl 尾部时间戳——两者错位即此坑。
