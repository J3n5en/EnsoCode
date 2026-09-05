# 对比 oh-my-pi 差异化能力

## Goal

从 `/Users/j3n5en/project/oh-my-pi` 找出 EnsoCode（本仓库）没有、但值得关注的黑科技 / 好用功能 / 有意思机制，产出模块化差距清单，供后续产品取舍。本任务只做调研，不改产品代码。

## Requirements

- 以 oh-my-pi 源码 + `docs/` + README 为准，不靠宣传文案臆测。
- 与 EnsoCode 对照：`src/agent/`、`src/renderer/`、`packages/`、README 已宣传能力。
- 按模块拆分分析：工具面、代码智能、会话协同、记忆/规则、运行时/原生、产品表面。
- 每条差距必须标明：对方有什么、我们有什么近似物、为什么有趣、引入难度（粗估）。
- 明确排除：纯 CLI/TUI 包装、我们已有且同级的能力（subagent/coworker、内置浏览器、手机伴侣、worktree、审批、checkpoint）。

## Acceptance Criteria

- [x] 每个模块有独立分析笔记，落到本任务目录
- [x] 主会话汇总一份按「值得抄 / 可观望 / 我们更强」分层的结论
- [x] 不改 EnsoCode 产品代码
