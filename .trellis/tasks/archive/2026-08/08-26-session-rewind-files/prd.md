# 会话回退 P1 — 文件 checkpoint

## 背景

P0 已实现仅对话回退(navigateTree)。P1 补文件维度:回退对话时可选把工作树一并还原到该轮开始前的状态。参考 pi-rewind(MIT,git-refs 快照,vendor 其 core.ts;npm 包只发 TS 源无构建产物,不作依赖)。

## 需求

1. 顶级会话的 write/edit/bash 工具首次执行前自动打工作树快照(每轮最多一次,git repo 项目才生效)。
2. 回退入口提供两种模式:「仅对话」(P0 行为)与「对话+还原文件」。
3. 还原文件 = 恢复到目标 user 消息那一轮的首个写操作之前的状态;该轮无快照时取其后最早的快照;完全无快照则仅回退对话(静默降级)。
4. 还原前先打一个 before-restore 安全快照(误操作可手工找回)。
5. 快照存 git refs(`refs/enso-checkpoints/`),不动 HEAD/index/分支;重启存活;每会话上限 50 自动裁剪;spawn 时清理老会话的 refs。
6. 安全过滤:跳过 node_modules/.venv 等目录、>10MiB 文件、≥200 文件的未跟踪目录;还原不删这些内容。

## 约束

- vendor `pi-rewind/src/core.ts` 至 `src/agent/checkpoint/core.ts`,文件头保留 MIT 出处;ref 前缀改 `refs/enso-checkpoints`。
- 快照与 user 消息的关联用 **entry id + 时间戳**(不用序号——回退产生分支后序号会歧义)。
- MVP 仅顶级会话的工具打快照;coworker/subagent 的写操作不打(共享工作区,父快照仍整树覆盖,局限记录在 design)。
- 非 git 项目零行为变化。

## 验收标准

- [ ] git 项目里让 agent 改文件 → `git for-each-ref refs/enso-checkpoints` 出现快照。
- [ ] 「对话+还原文件」回退后文件内容恢复到该轮之前;「仅对话」不动文件。
- [ ] 非 git 项目两种回退均不报错,行为同 P0。
- [ ] node_modules 等被过滤;还原不删除它们。
- [ ] core 的 create/restore 有 vitest 覆盖(临时 git repo)。
- [ ] typecheck / lint / 既有测试通过。
