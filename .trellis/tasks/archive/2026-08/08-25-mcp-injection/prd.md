# PRD: MCP servers 注入 agent 会话

## 背景

设置里已能从本地 AI 应用（Claude Code / Codex / Cursor 等）扫描导入 MCP server 条目（`McpServerEntry`：stdio/http/sse 三种传输），但只是登记展示，没有真正接入 agent 会话。

pi（`@earendil-works/pi-coding-agent`）**有意不内置 MCP**（官方文档明示），提供的接入口是
`AgentSessionConfig.customTools?: ToolDefinition[]`。需要我们在 agent worker 里自建 MCP client，把 server 的 tools 转换成 pi 的 ToolDefinition 注入。

## 目标

启用状态的 MCP server 的工具，在新开的 agent 会话中可被模型调用，调用结果正确回传。

## 需求

1. **连接**：spawn 会话时，为每个 `enabled` 的 McpServerEntry 建立 MCP client 连接
   - stdio：spawn command+args+env 子进程
   - http / sse：对应 transport（@modelcontextprotocol/sdk 支持）
2. **工具注入**：`listTools` 结果转换为 pi `ToolDefinition[]`（name/description/inputSchema），经 `customTools` 注入会话；工具名需带 server 前缀防冲突（如 `mcp__<server>__<tool>`）
3. **调用代理**：模型调用工具时转发 `callTool`，结果（text/image content）转回 pi 工具结果格式
4. **生命周期**：
   - 连接失败不阻塞 spawn——降级为无该 server 的工具，错误可见（会话内或日志）
   - 会话结束 / worker 退出时断开连接、杀 stdio 子进程，不留僵尸
   - 多会话对同一 server 的连接策略（共享 vs 每会话独立）在 design 阶段定
5. **UI 最小化**：本期不做工具级开关/状态面板；设置里现有的 server 级 enabled 开关即生效边界

## 非目标（本期不做）

- 工具级粒度的启用/禁用
- MCP resources / prompts 的接入（只做 tools）
- 权限门（设计文档 M1 项，另行实现；做完权限门后 MCP 工具应自动纳入）
- server 健康状态 UI、重连策略打磨

## 验收标准

1. 启用一个真实 stdio MCP server（如 `@modelcontextprotocol/server-filesystem`），新会话中模型能列出并成功调用其工具，结果正确显示在对话里
2. 禁用该 server 后新会话不再出现其工具
3. 配置一个无法启动的 server（错误 command），spawn 不失败，会话可正常对话
4. 关闭会话/退出 app 后无残留 MCP 子进程（`ps` 验证）
5. `pnpm typecheck && pnpm lint && pnpm test` 全绿

## 风险与注意

- **安全**：MCP 工具当前无权限门，模型可直接调用任意已启用 server 的工具。本期接受（与 bash/edit 现状一致），权限门任务落地后统一收口
- worker 是 utilityProcess：验证 @modelcontextprotocol/sdk 及 stdio 子进程 spawn 在其中可用
- dev 模式 worker 不热重载，验证需重启 `pnpm dev`；真机验证后清理测试数据
