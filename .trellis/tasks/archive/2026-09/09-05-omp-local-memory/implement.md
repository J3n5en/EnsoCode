# 实现切片

每刀可单测逻辑优先 TDD。切片超 10 例再拆。

## 1. learned 文件契约（替换 `localMemory.ts` 追加语义）

- `encodeProjectPath` / `getMemoryRoot(agentDir, cwd)`
- `neutralizeInjection` / `normalizeLearnedText` / `saveLearnedLesson` / `readLearnedLessons`
- newest-first、cap 100、手写 heading 保留
- **删除**对 `{cwd}/.enso/learned.md` 的 read/append

测：`src/agent/localMemory.test.ts` 改写或 `src/agent/memory/learned.test.ts`

## 2. 关掉每轮抽取

- 删除 `maybeLearnFromTurn` 及其 idle 调用
- spawn 不再 `readLearnedFile(cwd)` 进 agentsFiles
- 测：supervisor 相关断言若有则改；没有则加「idle 不写 cwd/.enso/learned.md」

## 3. `learn` 工具

- `createLearnTool`，父 spawn 且 `localMemoryEnabled` 时挂上
- 描述对齐 OMP learn.md
- 可选 skill 写入 `managed-skills`（本刀可先不做 skill，下刀补）
- approval = file-write

## 4. Phase 1 选择器 + JSON

- 列出 agent sessions 目录本项目 jsonl 元数据
- skip：current / coworker 文件名模式 / idleHours / ageDays / caps
- `parseStageOneResponse`：只要合法 JSON 三字段
- 提示词常量

本刀不接真实模型：选择器 + parser 单测即可。

## 5. Phase 2 apply + parser

- `parseConsolidationResponse` / `applyConsolidation(memoryRoot, parsed)`
- 不写 `learned.md`；修剪未点名的 `skills/*`
- 落盘前 redact

## 6. Job 队列

- claim stage1 / lease / retry / exclude current
- global watermark + phase2 lease
- json sidecar 足够就用 json；并发测用假钟

## 7. 注入

- `buildMemoryGuidance({ summary, learned })`
- spawn 父会话拼进 resource loader / system
- token cap
- 设置 i18n 文案

## 8. 接线

- `runMemoryStartup` 在父 spawn 后 `void` 触发（失败静默）
- 模型：`completeSimple` + AbortSignal
- 远程 / child / coworker 跳过

## 顺序

1 → 2 先止血复读；3 恢复「有意义的写入」；4–6 管线纯逻辑；7 注入；8 接线。
