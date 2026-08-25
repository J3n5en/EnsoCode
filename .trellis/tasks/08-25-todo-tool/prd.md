# PRD: todo 工具注入与进度行渲染

## 背景

pi 无内置 plan/todo 工具;官方 `examples/extensions/todo.ts` 示范了「工具 + toolResult.details 存状态」的路线。enso 用已有的 `customTools` 通道注入,渲染层画进度行。

## 需求

1. **工具**:注册 `todo` 工具(Claude Code TodoWrite 语义:**整表替换**),参数 `{ todos: [{ content, status: pending|in_progress|completed }] }`;execute 返回文本摘要 + `details.todos` 快照。整表替换意味着渲染层只需读**最后一条** todo toolResult,无需重放历史。
2. **注入**:spawn 时默认注入(与 MCP 工具同通道);工具 description 引导模型在多步任务中维护清单。
3. **投影**:`ProjectedMessage` 给 todo 的 toolResult 白名单透出 `todos`(结构校验,脏数据丢弃)。
4. **渲染**:todo 工具行专属 UI——进度摘要(`2/5`)+ 列表(✓ 完成 / ● 进行中 / ○ 待办);默认展开;**不进工具分组折叠**(计划是核心产物,同 edit 例外)。
5. resume 后状态正确(details 在 jsonl 里,免费获得)。

## 验收

- 新会话让 agent 执行多步任务,todo 行实时更新勾选状态;resume 后仍显示最终状态。
- foldTimeline 单测:todo 行不进组。
- 全绿 + CDP 实机验证。
