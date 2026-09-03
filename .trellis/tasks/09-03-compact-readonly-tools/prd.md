# Compact read-only tool calls

## Goal

时间线里 read/grep/find/ls（及同属搜索类的 glob）默认像 Cursor 一样是可展开的一行摘要，而不是带框卡片；进行中的一轮也把连续工具收成组。该行为可关，默认开。

## Background

现状（`src/renderer/stores/sessions/timeline.ts` `foldTimeline`、`src/renderer/components/chat/TimelineRow.tsx` `ToolRow`）：

- 单条 **output 已默认折叠**；仅 live 的 edit/write 默认展开。
- 折叠态仍是 `rounded-lg border bg-muted/30` 卡片，视觉比 Cursor/DeepChat 的一行/pill 重。
- 连续非 pinned 工具 ≥3 才收成 `tool-group`；**running 时最后一个 user 之后的段不折**（探索最吵的时候每条 read 都是一张卡）。
- edit/write/todo 钉在组外，不进组。

对照：Cursor 只读一行；DimAgent 连续 thinking+tool ≥2 折组（组默认收、running 组头 shimmer）；DeepChat pill 默认折叠，read 永不 auto-expand。

## Requirements

- **R1** 设置项（renderer `enso-settings`，与 `openChangesOnFileEdit` 同类，不进主进程 `SETTINGS_STATE_FIELDS`）：开关默认 **true**。关 = 恢复当前卡片 +「live 最后一轮不折组」。
- **R2** 开关在设置 → 通用，紧挨「文件改动时打开 Changes」。文案走 `t()` + `src/shared/i18n.ts`。
- **R3** 开关开时，只读工具（`read` / `grep` / `find` / `ls` / `glob`）折叠态为无框一行：状态点 + 工具名 + 截断摘要；点行展开结果（read 仍用 `ReadFileView`）。error 仍用 destructive 摘要。bash / edit / write / todo / subagent / MCP 等仍用现有卡片。
- **R4** 开关开时，`foldTimeline` **live 最后一轮也折组**（门槛仍 ≥3 非 pinned 工具）。edit/write/todo 仍钉组外；**`state === 'running'` 的工具行也钉在组外**（组头收已完成的，下面露出当前在跑的那一行）。
- **R5** 开关关时：`foldTimeline(..., running=true)` 行为与现测例一致（历史段折、最后一轮平铺）；ToolRow 只读也走卡片。

## Acceptance Criteria

- [ ] AC1 新安装 / 无该字段的旧 settings：开关视为开启。
- [ ] AC2 开：连续 3 条 read（无 edit）在 `running=true` 的最后一轮收成 `tool-group`；点组头展开为原始行。
- [ ] AC3 开：只读折叠态无 border/muted 卡片底；点开仍能看到完整 output。
- [ ] AC4 关：live 最后一轮 3 条工具不平铺进组（与现 `foldTimeline` 测例一致）；只读行恢复卡片。
- [ ] AC5 开：edit 的 diff 仍不进组、live 默认展开。
- [ ] AC6 开：live 段内 3 条已完成 + 1 条 running → `tool-group(count=3)` 后跟 running 行。

## Out of scope

- 不改 FOLD_MIN_TOOLS（仍为 3）。
- 不把 bash/MCP 收成只读一行。
- 不做 DimAgent 那种「整段 assistant work 再套一层总开关」。
- 不改工具审批 / 只读子代理工具集。

## Decisions

- running 行钉组外（用户已确认）。
