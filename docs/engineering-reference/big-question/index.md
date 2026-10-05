# 高代价陷阱

这里只收录**本仓库真实踩过、排查耗时明显超出预期**的问题。每条都有具体症状、
根因和修法。新踩到同类坑请补充进来。

| 文件 | 症状 |
|------|------|
| [preload-externalization.md](preload-externalization.md) | 应用启动即失败，报找不到 Electron |
| [traffic-lights.md](traffic-lights.md) | macOS 红绿灯遮标题 / 弹窗后位置偏移 |
| [ui-component-classname.md](ui-component-classname.md) | 输入框左侧一大片留白、图标不见了 |
| [dialog-layering.md](dialog-layering.md) | 弹窗内的下拉点开没反应 |
| [ios-pwa-header-blur.md](ios-pwa-header-blur.md) | Safari 正常，独立 PWA 顶部标题模糊；透明遮罩又留下灰色状态栏 |
| [dedupe-identity.md](dedupe-identity.md) | 去重没生效，同一个东西导入了三份 |
| [agent-end-run-scoped-messages.md](agent-end-run-scoped-messages.md) | 多轮对话后历史消息消失，只剩最近一轮 |
| [checkpoint-cross-session-wipe.md](checkpoint-cross-session-wipe.md) | 「回退+文件」不还原文件，无报错 |
| [rewind-optimistic-anchor.md](rewind-optimistic-anchor.md) | 回退未确认的“继续”却撤掉上一轮，任务进度归零 |
| [pi-auto-retry-willretry.md](pi-auto-retry-willretry.md) | 503 报错解锁输入后 agent 又自己跑起来；resume 回放重复红错 |
| [image-context-request-body-limit.md](image-context-request-body-limit.md) | 长工具轮读图后持续 CF 502；同轮 / 压缩后图片累积，整包超过约 32 MiB（预算守卫及状态栏已双厂商真机验收） |
| [queued-prompt-vs-compaction.md](queued-prompt-vs-compaction.md) | 排队消息 / 打断后发送报 Cannot submit a prompt while compaction is in progress |
| [worktree-move-races.md](worktree-move-races.md) | 会话切到隔离 worktree 后，文件仍写进主工作树；新命令被 worker 静默丢弃 |
| [cdp-hidden-window-input.md](cdp-hidden-window-input.md) | CDP 拖拽/点击时好时坏，eval/截图全正常，极易误判为产品 bug |
| [optimistic-echo-blocks-snapshot.md](optimistic-echo-blocks-snapshot.md) | 冷会话回来先发一句后，聊天区只剩这一句、计时器在走、工具卡不出现；worker 其实在正常干活 |
| [enso-compact-token-limit-fallback.md](enso-compact-token-limit-fallback.md) | Smart Compact 开着仍报 Auto-compaction failed: Summarization failed: Input token limit exceeded |
| [responses-compaction-routing-key.md](responses-compaction-routing-key.md) | 普通对话可用，默认压缩却报 invalid codex request / invalid_responses_request |
| [responses-sse-eof-terminal-event.md](responses-sse-eof-terminal-event.md) | 新开对话可用，旧会话反复报 OpenAI Responses stream ended before a terminal response event |
| [tool-prepare-arguments-schema-drift.md](tool-prepare-arguments-schema-drift.md) | 工具单测全绿，真机上模型每次调用都被判参数不合法 |
| [hashline-stale-recovery.md](hashline-stale-recovery.md) | 文件远处变动使旧 TAG 失效；恢复必须证明上下文唯一且不改变行号坐标系 |
| [session-before-compact-return-and-eviction-range.md](session-before-compact-return-and-eviction-range.md) | 持续记忆压缩：overflow 轮直接失败 / 走了原生摘要；memory#2 起静默丢旧史、split-turn 前缀无覆盖 |
| [electron-builder-platform-files.md](electron-builder-platform-files.md) | 安装包 asar 里出现 src/packages，体积比应用代码大出一两百 MB |
| [main-cjs-shim-regex.md](main-cjs-shim-regex.md) | 构建报 i18n 某条译文 Unterminated string literal，后面紧跟 CommonJS Shims |
| [history-paging-stuck-at-top.md](history-paging-stuck-at-top.md) | 长会话上滑翻一两页就停，顶部钉着「上下文已压缩」；或每翻一页跳回底部 |
| [coworker-adopt-phantom-run.md](coworker-adopt-phantom-run.md) | subagent 雇的 coworker 回复完了 Run 仍一直「进行中」，send 带 wait:true 永远不返回；单测全绿 |
| [coworker-restart-adopt.md](coworker-restart-adopt.md) | 重启后 coworker 的 tab 还在，subagent list 却是空的，给原 agentId 发消息报 not-found |
| [pi-project-trust-default.md](pi-project-trust-default.md) | 无报错；打开带 `.pi/extensions` 或项目包的仓库，其代码即在 worker 里运行、缺包还会自动安装 |
| [koffi-view-electron-sandbox.md](koffi-view-electron-sandbox.md) | Windows `ax()`/`getState` 报 AX_WORKER_EXITED；单测和 Node 探针全绿，只在 Electron 里崩 |
| [macos-window-focus.md](macos-window-focus.md) | 系统设置已在前台，computer 仍报窗口无法置于前台；浮窗被误判为输入焦点 |
| [macos-ax-identity.md](macos-ax-identity.md) | AX 树中有亮度滑块但 find 返回空，setValue 无可见效果、actions 为空 |

## 共同教训

这几个问题有个共性：**症状出现的位置和根因所在的位置隔了一层**。
输入框留白的根因在组件封装的 DOM 结构，下拉看不见的根因在 z-index 令牌，
去重失效的根因在"什么算同一个"的定义。

所以排查时先问：**我看到的现象，是我改的那层造成的，还是下面某层的默认行为？**
用真机验证（CDP 读计算样式、读 IPC 返回值）比盯着代码猜快得多，
方法见 [../shared/conventions.md](../shared/conventions.md) 的"本地调试真机验证"。
