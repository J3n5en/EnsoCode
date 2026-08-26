# 执行计划 — 文件 checkpoint

1. [ ] vendor `src/agent/checkpoint/core.ts`(pi-rewind core,MIT 头注释,ref 前缀改
       `refs/enso-checkpoints`,裁掉未用的 diff/label 部分)
2. [ ] `src/agent/checkpoint/manager.ts`:CheckpointManager + withCheckpoint 包装器
3. [ ] core/manager 的 vitest(临时 git repo:create→改文件→restore→内容断言;过滤与非 git 降级)
4. [ ] shared 类型:rewind.restoreFiles / rewind-done.filesRestored
5. [ ] supervisor:manager 接线(buildBaseTools 包装、agent_start 重置轮标志、
       rewind 分支还原、spawn 时 pruneOldSessions)
6. [ ] IPC/preload/store:rewind 透传 restoreFiles
7. [ ] TimelineRow:第二个按钮「回退+还原文件」+ i18n
8. [ ] `pnpm typecheck && pnpm lint && pnpm test`;手动:git 项目验证快照/还原,非 git 项目验证降级

每步一个 commit。
