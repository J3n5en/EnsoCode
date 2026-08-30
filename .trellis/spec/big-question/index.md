# 高代价陷阱

这里只收录**本仓库真实踩过、排查耗时明显超出预期**的问题。每条都有具体症状、
根因和修法。新踩到同类坑请补充进来。

| 文件 | 症状 |
|------|------|
| [preload-externalization.md](preload-externalization.md) | 应用启动即失败，报找不到 Electron |
| [traffic-lights.md](traffic-lights.md) | macOS 红绿灯遮标题 / 弹窗后位置偏移 |
| [ui-component-classname.md](ui-component-classname.md) | 输入框左侧一大片留白、图标不见了 |
| [dialog-layering.md](dialog-layering.md) | 弹窗内的下拉点开没反应 |
| [dedupe-identity.md](dedupe-identity.md) | 去重没生效，同一个东西导入了三份 |
| [agent-end-run-scoped-messages.md](agent-end-run-scoped-messages.md) | 多轮对话后历史消息消失，只剩最近一轮 |
| [checkpoint-cross-session-wipe.md](checkpoint-cross-session-wipe.md) | 「回退+文件」不还原文件，无报错 |
| [pi-auto-retry-willretry.md](pi-auto-retry-willretry.md) | 503 报错解锁输入后 agent 又自己跑起来；resume 回放重复红错 |

## 共同教训

这几个问题有个共性：**症状出现的位置和根因所在的位置隔了一层**。
输入框留白的根因在组件封装的 DOM 结构，下拉看不见的根因在 z-index 令牌，
去重失效的根因在"什么算同一个"的定义。

所以排查时先问：**我看到的现象，是我改的那层造成的，还是下面某层的默认行为？**
用真机验证（CDP 读计算样式、读 IPC 返回值）比盯着代码猜快得多，
方法见 [../shared/conventions.md](../shared/conventions.md) 的"本地调试真机验证"。
