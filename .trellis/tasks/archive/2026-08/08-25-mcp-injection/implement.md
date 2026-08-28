# Implement: MCP servers 注入 agent 会话

## 执行清单（按序）

### 1. 依赖与可行性探针
- [x] `pnpm add @modelcontextprotocol/sdk`
- [x] 写临时 node 脚本验证：sdk 在项目 ESM 环境可 import；StdioClientTransport 连
      `npx -y @modelcontextprotocol/server-everything`（官方测试 server）能 listTools
- 验证：脚本打印工具列表；验后删脚本

### 2. 协议与 main 侧下发
- [x] `src/shared/types/agent.ts`：spawn 命令加 `mcpServers?: McpServerSpawnConfig[]`
      （name/transport/command/args/env/url，全部可选字段按 transport 校验从宽）
- [x] `src/main/services/agentHost.ts`：`enabledMcpServers()` 从 settings 取
      enabled 条目，spawnSession 组装下发（照 enabledSkillPaths 模式）
- 验证：`pnpm typecheck`

### 3. worker McpManager
- [x] `src/agent/mcp.ts`：
  - `toolsFor(servers): Promise<ToolDefinition[]>`：按配置签名缓存 client；
    连接+listTools 带 10s 超时；失败 console.error + 跳过该 server
  - 工具转换：名字 `mcp__<slug(server)>__<tool>`；inputSchema 透传为 parameters；
    execute 代理 callTool（text 拼接 / image 转 pi 格式 / isError → 错误结果）
  - `closeAll()`：断开全部连接
- [x] `src/agent/supervisor.ts`：spawn 里 `customTools: await mcpManager.toolsFor(mcpServers)`；
      worker 退出路径调 closeAll
- 验证：`pnpm typecheck && pnpm lint && pnpm test`

### 4. 真机验证（CDP，参考 docs/dev-debugging.md）
- [x] 设置里加一条 stdio server（server-everything 或 filesystem）
- [x] 重启 `pnpm dev`（worker 不热重载）
- [x] 新会话发消息让模型调用 MCP 工具（如 everything 的 echo），确认调用成功、结果显示
- [x] 禁用该 server → 新会话无其工具
- [x] 配置坏 command 的 server → spawn 正常、对话可用、console 有错误留痕
- [x] 退出 app → `ps` 无残留 MCP 子进程
- [x] 清理测试 server 条目与测试对话

### 5. 收尾
- [x] 全量 `pnpm typecheck && pnpm lint && pnpm test`
- [x] 小步提交（协议+main 下发 / worker McpManager / 修正项 分开）
- [x] 若实现期学到可沉淀的契约（sdk 在 utilityProcess 的坑等），更新 spec

## 回滚点

每步独立提交；整链路以「不传 mcpServers 即现状」为安全缺省，revert 任意一步不伤现有功能。
