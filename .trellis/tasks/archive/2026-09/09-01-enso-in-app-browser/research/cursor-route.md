# 依据（不重复调研）

完整对照见 `.trellis/tasks/08-31-cursor-codex-browser/research/browser-architecture.md`。
Cookie/partition 细节：Cursor 用 `persist:${appName}[-dev]-browser`，落在
`Application Support/Cursor/Partitions/cursor-browser`，关 view 时 flush。

Enso 现状：

- Agent：`utilityProcess`，`agentHost` postMessage
- 特权回跳先例：`capability-invoke` / `capability-result`（不要复用其 requestId）
- 窗口工厂只管 Enso UI，不管 guest 页
- 工具注入：`supervisor.buildCoreTools` + 可选 MCP

本任务抄：独立 persist partition + 内置 `browser_*` + a11y `ref`。
不抄：`browser_cdp`、origin 企业策略、Chrome 扩展。
