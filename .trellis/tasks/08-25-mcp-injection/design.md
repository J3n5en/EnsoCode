# Design: MCP servers 注入 agent 会话

## 架构位置

MCP client 全部落在 **agent worker**（`src/agent/`）——工具执行发生在 worker 的 AgentSession 里，
main/renderer 不参与调用链。settings 里的 `McpServerEntry[]` 沿 spawn 链路下发（与 skillPaths 同模式）：

```
settings.json (main 读)
  └─ agentHost.spawnSession：取 enabled 的 McpServerEntry → spawn 命令带 mcpServers
       └─ worker supervisor.spawn：McpManager.toolsFor(servers) → customTools 注入 createAgentSession
```

## 关键决策

### 1. 连接策略：worker 级共享，按配置签名缓存

同一 server 配置只建一条连接，多会话共享（stdio server 起子进程，per-session 连接会造成
N 个子进程）。`McpManager` 以 `JSON.stringify(entry 去 id)` 为 key 缓存 client。
引用计数不做——连接保活到 worker 退出，worker 退出时统一 `close()`。
（会话数量少、server 子进程轻量，简单优先；泄漏面由 worker 生命周期兜底。）

### 2. 传输

`@modelcontextprotocol/sdk`：
- stdio → `StdioClientTransport`（command/args/env；env 需 merge process.env，否则 PATH 都没有）
- http → `StreamableHTTPClientTransport`
- sse → `SSEClientTransport`（旧协议，导入条目可能存在）

### 3. 工具名与 schema 转换

- 名字：`mcp__<serverName>__<toolName>`（serverName 做 slug 化），防跨 server 冲突，
  与 Claude Code 惯例一致，模型见过这种形状
- `parameters`：MCP 的 `inputSchema` 是 JSON Schema；TypeBox 的 TSchema 结构上就是
  JSON Schema，用 `Type.Unsafe`（或直接 as TSchema）透传，不做逐字段重建
- `execute`：转发 `client.callTool`；结果 content 里 `text` 拼接为输出文本，`image`
  转 pi 的图片结果格式；`isError` 映射为 pi 工具错误
- `label` 用 `<serverName>: <toolName>`；`description` 透传

### 4. 失败降级

- spawn 时连接/`listTools` 失败：该 server 的工具不注入，`console.error` 留痕，
  不阻塞会话创建。整体加超时（10s）防慢 server 卡 spawn
- `callTool` 失败/超时：返回 pi 工具错误结果（模型可见错误文本），不抛崩会话

### 5. UI

零改动。渲染层 ToolRow 对未知工具已有通用展示（名字+参数摘要+输出）。
`mcp__` 前缀名会直接显示——够用，美化不在本期。

## 文件改动

| 文件 | 改动 |
|---|---|
| `src/agent/mcp.ts`（新） | McpManager：连接缓存、listTools→ToolDefinition 转换、callTool 代理、closeAll |
| `src/agent/supervisor.ts` | spawn 接 `mcpServers`，await manager.toolsFor(...)，customTools 注入；worker 退出钩子 closeAll |
| `src/shared/types/agent.ts` | spawn 命令加 `mcpServers?: McpServerSpawnConfig[]`（只带 transport/command/args/env/url/name，不带 id/source） |
| `src/main/services/agentHost.ts` | spawnSession 取 enabled 的 McpServerEntry 组装下发（同 enabledSkillPaths 模式） |
| `package.json` | 新增 `@modelcontextprotocol/sdk` |

## 待实现期验证的假设

1. `@modelcontextprotocol/sdk` 在 utilityProcess（ESM bundle）里可加载、stdio 子进程可 spawn
2. MCP inputSchema 直接当 TypeBox TSchema 用，pi 的参数校验不炸（含空 schema 的工具）
3. AgentToolResult 的具体形状（text/image 字段名）——写码时对齐 d.ts

## 回滚

单 feature 链路，出问题时 revert 提交即可；不注入 mcpServers 时行为与现状完全一致。
