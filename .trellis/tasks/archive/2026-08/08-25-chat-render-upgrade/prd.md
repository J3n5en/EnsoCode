# PRD: 会话渲染增强 — 对齐 ref-chat-a 关键能力

## 背景

对 `~/project/ref-chat-a`(apps/web)会话渲染做了调研,enso-code 在长会话可用性与消息 chrome 上有明显差距。用户逐项拍板了要做的范围。

参考实现(ref-chat-a 关键文件):
- `apps/web/src/components/chat/MessagesTimeline.tsx` / `.logic.ts` — 行模型、虚拟化、折叠
- `apps/web/src/components/chat/timelineScrollAnchoring.ts` — 滚动跟随三态
- `apps/web/src/components/ChatMarkdown.tsx` — markdown 增强与高亮缓存
- `apps/web/src/components/chat/ContextWindowMeter.tsx` — 上下文占用表
- `apps/web/src/session-logic.ts` — WorkingTimer / formatElapsed

## 范围(用户已确认)

| # | 项 | 子任务 |
|---|---|---|
| 1 | 列表虚拟化 + 滚动跟随策略 | 08-25-timeline-virtualization |
| 2 | 工具行分组折叠(折中方案,用户已选) | 08-25-tool-group-folding |
| 3 | 运行中轮次计时器 | 08-25-chat-polish |
| 4 | 代码块复制按钮 | 08-25-markdown-enhancements |
| 5 | 上下文占用表 | 08-25-context-window-meter |
| 9 | markdown 增强(文件 chip/表格复制/alerts) | 08-25-markdown-enhancements |
| 10 | 渲染错误边界 | 08-25-chat-polish |
| 13 | 高亮 LRU 缓存(流式不写缓存) | 08-25-chat-polish |

明确不做(本批):
- 消息级 retry/edit/fork、checkpoint 回退(依赖 pi branch 能力,另立项)
- Timeline Minimap(成本高,观察虚拟化后是否仍需要)
- plan/todo 渲染(pi 无此工具;如要需先经 customTools 注入 todo 工具,另立项)
- 权限审批 UI(依赖 pi 权限门,M 计划内)

## 关键决策(用户拍板)

工具行折叠采用**折中方案**:
- 运行中(流式):工具行全部实时展示,不折。
- 轮结束后:连续 ≥3 条工具调用收拢为组头(「N 个工具调用 · 跑了 X 条命令 · 读了 Y 个文件」),点击展开;**edit 的 diff 卡片保留在组外不折**(改动是核心产物,不能黑盒)。
- resume 回来的历史轮次默认全收拢。

## 跨子任务验收

- 长会话(500+ 消息)滚动流畅,流式时贴底跟随,用户上滚后不抢滚。
- 现有能力零回退:edit diff、bash 终端样式、read 视图、hover 操作条、底部统计条、i18n。
- `pnpm typecheck && pnpm lint && pnpm test` 全绿;实机(CDP)验证每个子任务的可见效果。
- 小步提交,每个子任务独立可交付。

## 推进顺序

virtualization → tool-group-folding → chat-polish → markdown-enhancements → context-window-meter
(折叠依赖虚拟化的行模型;polish 独立可穿插)
