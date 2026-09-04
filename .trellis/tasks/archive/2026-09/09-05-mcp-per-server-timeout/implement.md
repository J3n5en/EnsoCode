# 实现清单

## TDD

逻辑面小（归一化 + manager 用配置超时）：主会话 inline Red-Green，不拉 coworker。
理由：用例 < 10，测试预计 < 80 行。

顺序：

1. RED：`src/shared` 或 `src/agent` 侧 `resolveMcpTimeoutMs` 用例（缺省 / 非法 / 上限 / 正整数秒→ms）。
2. RED：`src/agent/mcp.test.ts` —— 配置了 `connectTimeoutMs` / `callTimeoutMs` 时，`withTimeout` 使用该值（可用 fake timer 或把解析结果接到 execute/connect）。
3. GREEN：类型 + spawn 映射 + manager + 对话框 + i18n。
4. `pnpm typecheck && pnpm test`。

## 改动文件

| 文件 | 为什么 |
|------|--------|
| `src/shared/types/assets.ts` | `McpServerEntry` 可选秒字段 |
| `src/shared/types/agent.ts` | `McpServerSpawnConfig` 可选毫秒字段 |
| 新或就近模块（优先 `src/shared` 纯函数，worker 与 main 都能用） | `resolveMcpTimeoutMs` + 默认/上限常量 |
| `src/main/services/agentHost.ts` | `toMcpSpawnConfig` 透传已解析毫秒 |
| `src/agent/mcp.ts` | connect / listTools / callTool 读 server 超时 |
| `src/renderer/components/settings/McpEditDialog.tsx` | 两个可选秒输入，保存时清洗 |
| `src/shared/i18n.ts` | 中文 |

测试：

- 归一化函数同目录 `*.test.ts`
- 扩展 `src/agent/mcp.test.ts`（不测 React）

## 校验命令

```bash
pnpm typecheck && pnpm test
```

聚焦：

```bash
pnpm exec vitest run src/agent/mcp.test.ts src/shared/mcpTimeout.test.ts
```

（实际路径以落地的测试文件名为准。）

## 回滚点

只加可选字段与读侧兜底，删字段即可回退；无需 settings migrate。
