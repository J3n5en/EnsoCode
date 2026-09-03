# Context Inspector

## Goal

点状态栏 `context` 段打开拆账单：当前即将送给模型的构成按桶估算。不重拼 system prompt。

## Requirements

- 桶：系统、指令、Skill、工具定义、对话正文、压缩摘要、项目记忆（本期恒 0）、reminder/goal。
- Worker 用 `buildSessionContext` + `estimateTokens` / `getLatestCompactionEntry` 出 `ContextOccupancy`；系统/指令/Skill/工具按字符/4。
- 随 `session-meta` 下发；Renderer 只渲染。窗口未知显示已用 + `?`。
- 压缩过的会话写清「N 条旧消息已不在窗口」。
- 压缩模型家族与当前不一致时顶部静态提示，不自动重压。

## Acceptance

- 启用指令 + 至少一个 skill + 至少一次压缩：三个非零桶；各桶之和与状态栏已用同一量级。
- 项目记忆桶存在且为 0（D 再接）。

## Out

- 可编辑拼装、按桶摘 Skill、自动重压、手机第二屏、官方 tokenizer、`project_memory` 写入。
