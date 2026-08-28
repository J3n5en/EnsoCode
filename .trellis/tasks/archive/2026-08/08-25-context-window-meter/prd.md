# PRD: 上下文占用表

父任务: 08-25-chat-render-upgrade

## 需求

1. composer 区域显示当前会话上下文占用:百分比(已用 token / contextWindow)。
2. 形态参考 ref-chat-a `ContextWindowMeter.tsx`:小型环形表(或紧凑百分比 pill),hover 弹层显示「已用 X tok / 窗口 Y tok」明细。
3. >90% 时变红警示。
4. 数据源:pi 每条 assistant 消息的 usage(input+cacheRead+cacheWrite 近似当前上下文水位);contextWindow 当前 spawn 时写死 200_000,需从模型注册处取。

## 不做(本任务)

- 「Compact」按钮与自动压缩(pi compaction 能力接入另立项)。

## 验收

- 对话若干轮后表盘数值随 usage 增长;>90% 红色。
- 无 usage 数据(新会话)时不显示,不占位跳动。
