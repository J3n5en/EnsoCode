# MCP OAuth 授权与连接状态可见

## 背景

用户手动添加了 Notion MCP（http, https://mcp.notion.com/mcp），开关已开，但会话中拿不到任何 notion 工具。

排查结论：Manual 条目入链正常（`agentHost.ts:enabledMcpServers` 只按 enabled 过滤，不看 source）。
真正原因是 `https://mcp.notion.com/mcp` 返回 `401 + www-authenticate: Bearer realm="OAuth"`，
而 `src/agent/mcp.ts:110` 建 transport 时没有 authProvider，连接失败后仅 `console.error`（mcp.ts:71），
UI 上开关照亮、会话里静默无工具。

## 目标

1. 远程 MCP（http/sse）支持 OAuth 授权（DCR + PKCE + loopback 回调），可连上 Notion 这类托管 MCP。
2. MCP 连接状态对用户可见：connecting / ready(工具数) / unauthorized / error(原因)。

## 方案要点

- **OAuth 编排放 main**（有 `shell.openExternal`、`safeStorage`、`startOauthCallbackServer`）；
  worker 只消费 token、自动 refresh，不发起交互授权。
- worker 侧遇到需要交互授权 → 上报 `unauthorized`，用户去设置页点「授权」。
- token 由 main 加密持久化，spawn 时随 `McpServerSpawnConfig.oauth` 下发；
  worker 内 SDK 自动 refresh 后经 `mcp-tokens-refreshed` 事件回传 main 持久化。
- 状态事件走独立 IPC channel（`MCP_STATUS_EVENT`），不污染 sessions store / notifications / pairHost。

## 验收标准

- [ ] 设置页 MCP 列表每行显示连接状态徽标；未授权行有「授权」按钮
- [ ] 点击授权 → 系统浏览器打开授权页 → 回调后状态转为 ready 并显示工具数
- [ ] 授权后新建会话可用 notion 工具
- [ ] token 加密落盘，重启后仍有效；过期由 refresh_token 自动续期
- [ ] stdio server 行为不回归；无 OAuth 的 http server 失败时显示 error 而非静默
- [ ] `pnpm typecheck && pnpm test` 通过

## 非目标

- 手填 Bearer token / 自定义 headers（后续可加）
- deep-link（自定义 protocol）回调，本期用 loopback
