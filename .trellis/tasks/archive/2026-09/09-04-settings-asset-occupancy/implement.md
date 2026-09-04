# Implement

Inline TDD：估算纯函数；MCP 探测用 mock，不连真 server。

1. RED/GREEN：`src/shared/occupancy.ts` + 测试（charsToTokens、skill、tool schema、instruction 正文、空串 0）。`contextOccupancy.ts` 改用它。
2. RED/GREEN：Main — skill id 读 `SKILL.md`；instruction id 走 instructionStore；builtin 6 项 factory 快照求和；未知 id / 缺文件 → null。
3. RED/GREEN：MCP 探测 mock listTools 求和、单失败不拖垮、未启用不连、close。
4. IPC 四点通道 + preload + `IPC_PRODUCT_COVERAGE`；handler 入参 `unknown`。
5. 四个设置列表行尾数字 + 已启用合计；i18n。
6. `pnpm test` 相关 + `pnpm typecheck`。

验证：Skills/Instructions/Built-in 打开即有 K 数；MCP 已启用从 `…` 变成数字或 `—`。
