# bash 运行中实时输出

## 背景

工具行（`ToolRow`）在 bash 运行中只显示命令 + spinner + 耗时，没法看到已经产生的 stdout。
长命令（如 `pnpm test` 跑 5 分钟）期间用户完全瞎等。

pi SDK 的 bash 工具**本身已经**流式采集 stdout/stderr，并按节流通过 `onUpdate`
发出 `tool_execution_update` 事件（`@earendil-works/pi-coding-agent/dist/core/tools/bash.js:250-289`）。
enso 从未订阅该事件，所以数据在 supervisor 处就断了。

## 目标

工具运行中，若已有增量输出，用户可以展开工具行查看实时内容。

## 范围

- 打通 `tool_execution_update` → renderer 的链路（通用，不限 bash；UI 优先保证 bash）
- 运行中的工具行在有增量输出时**可展开**（默认仍折叠，不打扰）
- 工具结束后由真实 toolResult 覆盖，partial 状态清除

## 非目标

- 不改 pi SDK 的节流策略
- 不做输出内容的搜索/复制增强
- 不改后台任务（background=true）的既有展示

## 验收标准

1. 运行 `sleep 1; echo a; sleep 1; echo b` 期间展开工具行，能看到逐步出现的 `a` / `b`
2. 命令结束后展示的是最终完整输出，与改动前一致
3. 无增量输出时运行中工具行行为不变（不可展开）
4. turn 中断/失败时 partial 状态不残留
5. `pnpm typecheck && pnpm test` 通过，`biome check` 干净

## 实现要点

| 环节 | 改动 |
|---|---|
| `src/agent/supervisor.ts` | 新增 `case 'tool_execution_update'`，提取 toolCallId + 文本并 emit |
| `src/shared/types/agent.ts` | `AgentWorkerEvent` 新增 tool 增量分支 |
| main / preload | 复用既有 `AGENT_EVENT` 广播；pair 侧补白名单与 guest 投影 |
| `src/renderer/stores/sessions/` | 维护 `Map<toolCallId, string>` partial 输出，turn 结束/收到 toolResult 时清除 |
| `src/renderer/stores/sessions/timeline.ts` | `buildMessageTimeline` 接受 partial map，填充 running 态 `item.output` |
| `TimelineRow.tsx` `ToolRow` | running + 有 output 时允许展开 |

## TDD

`timeline.ts` 为纯函数，按 Red-Green：先写「running 工具带 partial output」失败测试。
