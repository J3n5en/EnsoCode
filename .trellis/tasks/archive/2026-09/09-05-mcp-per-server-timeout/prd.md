# MCP 每 server 可配连接与工具调用超时

## 背景

worker 里 MCP 超时目前写死：

- 连接 + `listTools`：`CONNECT_TIMEOUT_MS = 10_000`
- 单次 `callTool`：`CALL_TIMEOUT_MS = 120_000`

慢启动或长任务 MCP（浏览器自动化、大检索、本地子进程）会被提前掐掉；用户无法按 server 调整。

## 目标

每个 MCP server 可单独配置：

1. **连接超时**：覆盖 `connect` 与 `listTools`（同一预算）。
2. **工具调用超时**：覆盖该 server 每次 `callTool`。

未填写时行为与现在完全一致（10s / 120s）。旧 `settings.json` 无需迁移即可继续用。

## 需求

- 设置页「添加 / 编辑 MCP」可填两个可选超时（单位：秒）。
- 空值、非法值、`<= 0` 一律回落到默认；不提供「无限等待」。
- 超时随 `McpServerEntry` 持久化，经 `toMcpSpawnConfig` 下发到 worker。
- 已运行会话的工具集仍在 spawn / 首次 connect 时定格（与现有 MCP 行为一致）；改超时后新建会话或重建连接后生效。
- stdio / http / sse 同一套字段。

## 验收标准

- [ ] 编辑对话框能保存、回显每 server 的连接超时与工具调用超时（秒）。
- [ ] 未填或旧条目：连接 10s、调用 120s。
- [ ] 有效正数秒：worker 用对应毫秒做 `connect`/`listTools` 与 `callTool` 超时。
- [ ] 非法输入（空、0、负数、非数字）保存时按未设置处理，不把脏值写进运行配置。
- [ ] 导入的本地 MCP 不带超时字段时仍走默认。
- [ ] occupancy 探测超时仍用现有短预算（约 8s），不被用户填写的长连接超时拖死设置页。
- [ ] `pnpm typecheck && pnpm test` 通过。

## 非目标

- 全局一条超时覆盖所有 MCP。
- 单工具级超时（只到 server）。
- 0 / 无限超时。
- occupancy / OAuth 授权超时。
- 改超时后强制拆掉 worker 里已缓存的连接（沿用现有缓存语义）。
- 能力网关 `mcp.list` 暴露超时字段。
