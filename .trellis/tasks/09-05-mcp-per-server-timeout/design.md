# 设计：每 server MCP 超时

## 行为差距

现在：所有 MCP 共用硬编码 10s 连接 / 120s 调用。
应该：每个 `McpServerEntry` 可选覆盖这两项；缺省不变。

行为真正住在 `src/agent/mcp.ts` 的 `withTimeout`。设置页只负责采集；main 只负责把字段打进 spawn 配置。

## 字段

持久化（秒，整数，可选）——用户可读、与 UI 一致：

```ts
// McpServerEntry
connectTimeoutSec?: number;
callTimeoutSec?: number;
```

运行时（毫秒，已归一化，可选）——worker 只认这个：

```ts
// McpServerSpawnConfig
connectTimeoutMs?: number;
callTimeoutMs?: number;
```

缺省常量仍留在 worker：`CONNECT_TIMEOUT_MS = 10_000`、`CALL_TIMEOUT_MS = 120_000`。

## 归一化

抽出纯函数（可单测、shared 或 agent 侧导出）：

```ts
resolveMcpTimeoutMs(sec: unknown, fallbackMs: number): number
```

规则：

- `undefined` / `null` / `''` / 非有限数 / `<= 0` / 非整数秒 → `fallbackMs`
- 上限：连接 `600` 秒，调用 `3600` 秒（防误填把会话钉死）
- UI 保存时：能解析为正整数则写入秒；否则 `undefined`（不写脏字段）

不改 `SETTINGS_VERSION`：新增可选字段，读侧兜底即可（见 shared/types.md 持久化演进）。

## 数据流

```
McpEditDialog
  → settings.mcpServers[].connectTimeoutSec / callTimeoutSec
  → agentHost.toMcpSpawnConfig
       仅当 resolve 结果 ≠ 默认 才带 connectTimeoutMs / callTimeoutMs
  → spawn / warm-mcp
  → McpManager.connect / toToolDefinition.execute
```

`parseAgentCommand` 对 `mcpServers` 元素只要求 `isRecord`，加字段不会被白名单丢掉。
`capabilityGateway` 的 `mcp.list` 继续只回 id/name/transport/enabled/source。

## 连接缓存

`connectionFor` 的 key 今日含 `id, transport, command, args, env, url`。
超时**不进 key**：改超时不应拆掉已连上的 server（与「会话工具集 spawn 定格」一致）。
`callTimeoutMs` 在 `execute` 时从本次 spawn 的 server 配置读取有困难（tools 在 connect 时闭包生成），因此：

- 把解析后的 `callTimeoutMs` 存进 `Connection`
- `toToolDefinition` 从 connection 读，而不是捕获模块常量
- 同一缓存连接上，**首次 connect 时的超时**跟工具一起定格

若后续 warm-mcp 带着新超时命中缓存，不重建连接、不改已发出的 tool 闭包。

## Occupancy

`mcpOccupancy.ts` 的 `PROBE_TIMEOUT_MS = 8_000` 保持独立。设置页探测不能跟用户填的 10 分钟连接超时绑在一起。

## UI

`McpEditDialog` 在 transport 字段后加两行可选数字输入：

- `Connection timeout (seconds)`
- `Tool call timeout (seconds)`

placeholder 写默认值 `10` / `120`。空 = 默认。stdio 与 http/sse 都显示。

中文补进 `src/shared/i18n.ts`。

## 明确不改

- OAuth `AUTHORIZE_TIMEOUT_MS`
- supervisor `toolsFor(..., 3000)` 的 spawn 等待预算
- MCP 去重指纹（超时不是身份）
