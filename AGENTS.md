<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->

# 开发纪律（所有贡献者，含 AI）

## TDD：逻辑改动必须测试先行

凡是改**可单测的逻辑**（纯函数、解析器、协议校验、store reducer——见
`.trellis/spec/testing.md` 的覆盖范围），按 Red-Green 循环走：

1. 先写失败测试，**运行并确认它因缺功能而失败**（不是因为拼写错误报错）；
2. 写最小实现让它通过；
3. 全量测试保持绿色后才能提交。

UI 组件、Electron 窗口行为等 spec 中「暂未覆盖」的范围不强制，但新增的
纯逻辑若刻意绕开测试（塞进组件里躲避），审查会要求拆出来。

## 小步提交

每完成一个**可独立描述**的改动就 commit——一个 fix、一个 feat、一次重构，
各自独立成提交。判断标准：commit message 里不需要用「和」「顺便」连接
两件事。禁止把一整天的工作攒成一个大提交。

提交前自查：`pnpm typecheck && pnpm test` 通过、`biome check` 干净。
