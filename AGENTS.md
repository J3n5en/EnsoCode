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

### TDD 的角色分离（可选，大改动推荐）

TDD 纪律最容易坏在两处：「红」造假（测试和实现同一个脑子写，
测试贴着既定实现走形式）和「绿」自证（实现者自己宣布通过）。
逻辑面大的改动（跨模块、用例多、协议/解析器类），推荐用 coworker
做角色分离，在结构上防住这两点：

- **测试先行者**（coworker，`agent_type: tester`）：只读 PRD 与接口契约，产出失败测试并确认红灯；
  tester 类型的 edit/write 被硬限制在 `*.test.ts` / `*.spec.ts` / `test/**`，写不了实现；
- **实现者**（主会话或另一 coworker）：只许改实现，不许动测试文件让灯变绿；
  **红灯到手前不要开写实现**，否则 tester 能读到实现，红灯就不独立了；
- 验收用 `gate: "pnpm test"`，以退出码为准，不采信文字汇报；
- 等 coworker 用 `coworker wait {name}`，不要 `sleep` 轮询；回报被截断时用 `coworker report {name}` 取全文。

小的纯函数改动不必拉 coworker，inline Red-Green 即可——判断标准：
测试文件预计 < 50 行，或用例 < 10 个，直接 inline。

## 小步提交

每完成一个**可独立描述**的改动就 commit——一个 fix、一个 feat、一次重构，
各自独立成提交。判断标准：commit message 里不需要用「和」「顺便」连接
两件事。禁止把一整天的工作攒成一个大提交。

提交前自查：`pnpm typecheck && pnpm test` 通过、`biome check` 干净。
