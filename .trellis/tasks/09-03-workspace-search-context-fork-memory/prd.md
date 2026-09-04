# 工作区搜索 / Inspector / Fork / 项目记忆

## Goal

桌面工作台补上可找回、可检查、可平行试探、项目级有界记忆。不改 agent 哲学。

## Requirements

- 四项独立交付，顺序 A 搜索 → B Inspector → C Fork → D 项目记忆。
- 会话身份只由 Main `SourceAuthorityRegistry` 创建。
- 逻辑改动走 TDD；一项一个 commit。
- 产品规格原文：`docs/plans/2026-09-03-workspace-search-context-fork-memory.md`（gitignore，不入库）。

## Child map

| 子任务 | 交付 |
|---|---|
| `09-03-workspace-search` | `mod+k` 工作区搜索 + 冷索引 |
| 未建 | Context Inspector |
| 未建 | 会话 Fork |
| 未建 | 项目记忆 + 内置工具开关 `project_memory` |

## Acceptance Criteria

- [ ] A：`mod+k` 能搜到未打开会话的用户原话并跳转高亮；`mod+f` 不变。
- [ ] B：状态栏 context 可打开拆账单；压缩会话能看出旧消息已折叠。
- [ ] C：从中间消息分叉后源线完整、新线可续、重启双线仍在。
- [ ] D：`MEMORY.md` 2200 字硬上限；内置工具关掉则不注入、不注册写工具。

## Notes

父任务不做实现。先 start / 实现当前子任务 A。
