# Design

## 层

- 估算纯函数：`src/shared/occupancy.ts`（从 `contextOccupancy.ts` 抽出 `charsToTokens` / skillText / toolText）。renderer 只展示 IPC 返回的数字。
- 读盘 / 探测：`src/main/services/`。
- UI：`SkillsSettings` / `McpSettings` / `BuiltinToolsSettings` / `InstructionsSettings` 行尾 `tabular-nums`。

## 估算来源

| 类别 | 数据 | 启用与否 |
|---|---|---|
| Skill | settings id → path → `SKILL.md` | 关着也读盘 |
| Instruction | settings id → `instructionStore.readInstruction`（local/sourcePath 由 Main 自 settings 推导） | 关着也读盘 |
| MCP | 短生命周期 connect/`listTools`/close；进程内按配置签名缓存 | 只探测 enabled |
| Builtin | 用与会话相同的 tool factory 取 `name/description/parameters`（stub execute，不发浏览器/不雇子代理） | 关着也算 |

Builtin 映射（与 `supervisor` 注入一致）：

- `browser` → `createBrowserTools`
- `todo` → `createTodoTool`
- `ask_user` → `createAskTool`（stub manager）
- `subagent` / `coworker` → 对应 factory；description 里的模型列表用当前 settings 的 subagent models（尽量贴近会话）
- `background_tasks` → `createTaskTools`

不把 inputSchema 或文件正文返回渲染层。

## IPC

请求一律 `string[]` ids（builtin 可无参返回 6 项）：

- `ASSETS_SKILL_OCCUPANCY`
- `ASSETS_INSTRUCTION_OCCUPANCY`
- `ASSETS_MCP_OCCUPANCY`（只对 enabled id 连进程）
- `ASSETS_BUILTIN_TOOL_OCCUPANCY`

返回 `{ id, tokens: number | null, error?: string }[]`。MCP 可带 `toolCount`。

三点式 + `IPC_PRODUCT_COVERAGE`。路径不收渲染层。

MCP：不要复用 worker `McpManager` 长连接。10s 超时，失败隔离，close 必做。

## UI

- 探测中 `…`，成功 `formatTokens`，失败/未探测 `—`（失败可用 title）。
- 表头已启用合计。
- Skills / Instructions / Built-in：分类挂载时拉一次。
- MCP：分类挂载拉已启用；关→开再拉该 id。
- 不 persist。

## 明确不做

Inspector 分项、MCP 单工具展开、探测未启用 MCP、始终开启的 read/bash 等新行、goal。
