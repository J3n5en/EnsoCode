# 审查并合并 PR #2

## Goal

在不扩大 PR 范围、不夹带本地未跟踪产物的前提下，对 `J3n5en/EnsoCode#2` 执行合并前门禁并在结论放行后合并到 `dev`。

## Background

- PR：`https://github.com/J3n5en/EnsoCode/pull/2`
- 基分支：`dev`
- 头分支：`feature/model-ui-and-status-line`
- GitHub 当前报告：OPEN、非 Draft、merge state CLEAN。
- 主检出已位于 PR 头分支；本地仅有未跟踪的 `.trellis/workspace/imhuso/` 与 `out-qa-9333/`，二者不得进入 PR 或合并提交。
- PR 涉及 68 个文件，跨 main、preload、renderer、shared 和 tooling，属于复杂、高影响面变更。

## Requirements

- 合并前并行执行完整静态门禁与安全/质量复审，结论必须基于 PR 当前头提交。
- 对门禁失败区分本 PR 引入问题与目标分支存量问题；本 PR 引入的 P0/P1 必须清零。
- 不修改业务代码，不扩大 PR 范围；若发现阻塞问题，停止合并并报告证据。
- 不提交或删除用户现有未跟踪目录 `.trellis/workspace/imhuso/`、`out-qa-9333/`。
- 仅在门禁放行后执行 GitHub PR 合并；不直接向 `dev` 推送本地合并提交。
- 合并后读取远端 PR 状态，确认状态为 MERGED 并记录合并提交。

## Acceptance Criteria

- [ ] 静态门禁完成，命令、退出码与关键结果可复核。
- [ ] 安全/质量复审完成，P0 为 0；本 PR 引入的 P1 为 0。
- [ ] 合并前再次确认 PR 仍为 OPEN、头提交未变化、merge state 可合并。
- [ ] PR #2 通过 GitHub 合并到 `dev`。
- [ ] 远端 PR 状态为 MERGED，合并提交 SHA 可查。
- [ ] `.trellis/workspace/imhuso/` 与 `out-qa-9333/` 未被提交、删除或修改。

## Out of Scope

- 修复与本 PR 无关的存量 lint/类型问题。
- 实现 PR 正文中已拆分到其他 Issue 的后续需求。
- 清理用户本地未跟踪产物或切换/删除当前分支。
