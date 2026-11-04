---
name: formal-delivery-echo
description: >
  有界穷举验证用户消息的乐观回显协议：每条发出的消息在时间线上恰好显示一次，事件流静止后正文等于 worker、
  只剩被拒收的回显。改动 sessions reducer 的 message-upsert / delivery-* / turn-failed / snapshot 分支、
  retainedOptimisticTail / sameUserText，或 supervisor 的 prompt / steer 投递与 takeDelivery 时使用；
  也用于"消息重复""消息消失""发出去的气泡一直挂着"类问题。
---

# 乐观回显投递协议的形式化验证

属性：用户发出的每条消息，在任一时刻最多显示一次；所有命令与事件处理完、worker 空闲后，权威正文逐条等于 worker 的消息列表，乐观尾巴只剩被拒收（可撤回）的回显，且按发送顺序排列。

危害：违反时用户会看到消息重复，或看到一个已发出却永远停在"发送中"的气泡，或刷新前后时间线不一致。

## 运行

```bash
pnpm vitest run src/renderer/stores/sessions/deliveryEcho.formal.test.ts
```

约 4 秒，`pnpm test` 也会跑它。工具是 vitest 内的广度优先状态探索，直接调用真实的 `applyAgentEvent`，无需额外安装。

## 怎么读结果

失败时断言消息就是最短反例：编号步骤加一行 `=> 违反了什么`。步骤分三类：`renderer 发送 / 请求 snapshot / 应用 <事件>`、`worker 处理 dN: <结局>`、`worker 投递 steer / 回复 / 结束本轮`。

逐步对照代码判断是真 bug 还是模型错：

1. 每个 `worker ...` 步骤发出的事件序列，必须能在 `src/agent/supervisor.ts` 找到同样的 emit 顺序（见下方覆盖表）。对不上就是模型错，修 `successors()`，不要改断言。
2. 对得上，就用反例里的事件序列在 `reducer.test.ts` 写一个确定性单测复现，再修 reducer 或 supervisor。
3. 绝不为了变绿而放宽 `violation()` 或缩小 `core` 配置。

`states` 下限断言保护探索规模。模型改动让它跌破下限时，先确认不是误删了动作。

## 覆盖与同步

最后确认模型与代码一致的提交：`f32fa5e95bc4`（2026-11-04）。

| 模型部分 | 代码 |
| --- | --- |
| 回显形状与追加到尾部 | `src/renderer/stores/sessions/index.ts` `optimisticUserMessage` |
| 渲染层归并 | `src/renderer/stores/sessions/reducer.ts` `applyAgentEvent` 的 `message-upsert`、`delivery-settled`、`delivery-rejected`、`status`、`turn-failed`、`turn-completed`、`snapshot`；`retainedOptimisticTail`、`sameUserText`、`authoritativeLength`、`dropOldestOptimistic`、`upsertOutOfRange` |
| store 越界补快照 | `src/renderer/stores/sessions/index.ts` 中 `upsertOutOfRange` 触发 `resyncSnapshot` |
| idle 收到 prompt：accepted / rejected / timeout / handled | `src/agent/supervisor.ts` `case 'prompt'`、`promptTracked`、`failTurn` |
| running 收到 prompt：queued / handled | `steerTracked` |
| user 消息落地后发 `delivery-settled` | user `message-upsert` 处的 `takeDelivery` |
| snapshot 不排在在途 prompt 之后，但与事件同一 FIFO 发出 | `handleCommand` 开头的 `command.type === 'snapshot'` 分支走 `this.options.emit` |

检查改动是否触及覆盖代码：

```bash
git diff --stat f32fa5e95bc4..HEAD -- src/renderer/stores/sessions/reducer.ts src/renderer/stores/sessions/index.ts src/agent/supervisor.ts
```

有改动时，对照上表重读相关函数，确认模型仍然描述代码，跑通检查后才把本节的提交号和日期前移。有意改协议（新事件、新结局）时，同一提交里更新 `successors()` 和本表。

## 范围

验证范围：一个会话、一个 generation；最多 3 次发送，文本取自 `a`、`b`（含重复文本）；1 次主动 snapshot 加 store 越界触发的 snapshot；每段轮次一次 assistant 回复；投递按发送顺序结算。

不覆盖：worker 退出与重建（seq 归零）；图片、`<role>` 前缀、skill 块、截断头等 `sameUserText` 变体；尾窗 `baseIndex` 与分页；冷缓存清正文；rewind 与压缩；IPC 失败本地回滚；`steerActive` 与 `delivery-deferred`；steer 抛错路径。模型里文本匹配总先于 `delivery-settled` 消费回显，所以只靠 `delivery-settled` 按 id 收回的路径未被独立验证。

通过只说明上述范围内成立，不代表整条链路无误。

## 已知发现

`已知发现：input hook 消费（handled）的投递留下永不收回的回显` 断言反例存在。`promptTracked` 与 `steerTracked` 遇到 disposition `handled` 时不发任何回执，回显永远是 pending，snapshot 也会保留它。按代码推断（未单独跑反例），之后一次 `turn-failed undelivered` 会经 `dropOldestOptimistic` 先删掉这个旧回显，而不是本次的。修复后这条测试会变红，届时把 `handled` 并入 `core` 配置并删掉这条测试。
