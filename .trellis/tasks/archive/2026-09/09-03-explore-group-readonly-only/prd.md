# Explore-group only folds read-only tools

## Goal

对齐 Cursor：`compactReadOnlyTools` 开时，折叠组只收 read/grep/find/ls/glob（「探索」），bash 等其它工具留在组外自己一行；live 时组头显示「Exploring <当前项>」而不是静态计数。

## Background

上一任务（09-03-compact-readonly-tools）把 live 也折组，但组仍沿用旧逻辑收所有非 pinned 工具，出现「4 个工具调用 · 跑了 1 条命令 · 读了 2 个文件」——bash 被吃进探索组，与 Cursor 不符（Cursor：`Explored 2 files, 2 searches`；bash 单独展示）。

## Requirements

- R1 开关开：`foldTimeline` 的分段只把只读工具视为可折的连续段；bash / subagent / MCP / 其它工具像 edit 一样打断段并平铺。thinking 仍收进段内。
- R2 开关开：组头文案「Explored N files, M searches」（无命令/其它计数）；组内有 running 行时（running 行仍钉组外）组头改为「Exploring …」并 shimmer/加载态。
- R3 开关关：完全恢复旧行为（收所有非 pinned 工具、`{{count}} tool calls · …` 文案、live 不折）。
- R4 门槛不变：≥3 只读工具（不含 running）才折。

## Acceptance Criteria

- [ ] AC1 开：`[read, read, grep, bash, read]`（idle）→ `tool-group(3, reads 2 searches 1)`, `bash`, `read`。
- [ ] AC2 开：live `[read, read, grep, read(running)]` → `tool-group(3)` + running `read` 行；组头显示 Exploring。
- [ ] AC3 关：`[read, read, grep, bash]` idle → 单个 `tool-group(4)`（含 command 1）。
- [ ] AC4 开：组头文案不出现「跑了 N 条命令」。

## Out of scope

- 不改单条 ToolRow 样式。
- 不做 Cursor 的「Searching files * in enso-code」逐条动词摘要。
