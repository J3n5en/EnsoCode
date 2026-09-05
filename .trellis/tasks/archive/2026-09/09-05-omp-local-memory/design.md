# 设计：OMP local 记忆对齐

## 行为差距

- **现在**：每轮 idle 抽子弹 → `{cwd}/.enso/learned.md` → 下次整文件 `agentsFiles`。
- **应该**：`learn` → `<agentDir>/memories/<encoded-cwd>/learned.md`；启动扫历史 jsonl → raw → `MEMORY.md` + `memory_summary.md` + `skills/`；spawn 只注入 Guidance + summary + learned。

行为住在 **agent worker**（会话 jsonl、工具、注入）+ **设置开关**（已有 `localMemoryEnabled`）。不新开 IPC，除非二期做 `/memory` UI。

## 明确不做什么

Hindsight/Mnemopi；把 `.enso/learned.md` 当课程源；给子代理自动 `learn`；抄 OMP 整份 SQLite schema 到字节级（语义对齐：thread 登记、stage1 job、global watermark、lease）。

## 存储

```
{userData}/agent/pi-agent/memories/--{encoded-cwd}--/
  MEMORY.md
  memory_summary.md
  learned.md
  skills/<name>/SKILL.md
  .jobs.json          # 或 memories.sqlite；单测不依赖 Electron
```

`encoded-cwd` 对齐 OMP：`--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`。

Job 库最低字段：

- threads: `threadId`, `cwd`, `sessionFile`, `mtime/updatedAt`, `lastExtractedMtime`
- stage1 jobs: `threadId`, `leaseUntil`, `retryAt`, `status`
- global: `cwd`, `watermark`, `leaseUntil`, `ownershipToken`

实现优先 **json sidecar + 文件锁**（少依赖、worker 可写）。若 claim/lease 并发难测再上 `better-sqlite3`（主进程已有，worker 需确认 native 可用性）——选一条写进 implement，不要两条并存。

## 管线触发

- 父会话 `spawn` / worker 空闲且 `localMemoryEnabled`：异步 `runMemoryStartup`（不挡首 token）。
- 排除：当前 `sessionFile`、`coworkerName` / `childIdentity`、mtime 距今 &lt; 12h、&gt; 30d。
- Phase 1 并发默认 2（OMP 8；桌面单 worker 先保守，常量与 OMP 同名可配默认）。
- Phase 1 模型 = 会话模型（OMP `default` role）。Phase 2 = 标题总结模型，缺则会话模型（OMP `smol` 回退）。
- `completeSimple`，超时 Phase 1 60s / Phase 2 120s；失败 mark retry。

## `learn`

新工具 `src/agent/learn.ts`，描述抄 OMP `prompts/tools/learn.md`。  
`saveLearnedLesson` 从 `localMemory.ts` 重写成 OMP `appendLearnedLine` 语义（保留手写非列表行）。  
`withApproval`：本地写文件 → `file-write`。

可选 `skill`：写入 `{agentDir}/managed-skills/<name>/SKILL.md`，name `[a-z0-9][a-z0-9-]{0,63}`，64k cap。与 settings 导入的 authored 重名则 lesson 已写、skill 报错（`shadowed`）。

## 注入

删 `readLearnedFile(cwd)` 进 `agentsFiles`。  
`createSessionResourceLoader` 增加一段 system 文本：`buildMemoryGuidance({ summary, learned })`，模板对齐 `read-path.md`。  
`summaryInjectionTokenLimit = 5000`（粗算 4 字符/token 或按现有 title 截断习惯）。

`learn` 成功不 `refreshBaseSystemPrompt`（对齐 OMP）。

## 提示词

把 OMP 四份记忆 prompt **原文语义**落到 `src/agent/memory/prompts.ts`（可微调产品名 Enso，JSON schema 不变）：

- `STAGE_ONE_SYSTEM` / `stageOneUser(threadId, itemsJson)`
- `CONSOLIDATION_SYSTEM` / `consolidationUser(raw, summaries)`
- `MEMORY_GUIDANCE` 模板

不要再用 `LOCAL_MEMORY_SYSTEM_PROMPT`（3–8 bullets）。

## 会话语料

Phase 1 输入：该 jsonl 的 user/assistant **文本** + toolCall 名与摘要（无图片、无密钥）。截到 `phase1InputTokenLimit`≈4000。  
当前活跃会话不入队（OMP `excludeThreadIds`）。

## 设置 / i18n

`SkillsSettings` 开关说明改为「跨会话记忆（learn + 启动合并）」。  
key 可复用，改英中文案。无需新 settings 字段即可落地；默认值保持 `localMemoryEnabled: true`（行为从「每轮复读」变成「learn + 后台合并」，需在文案说清）。

## 测试主阵地

纯函数：normalize/save learned、guidance 渲染、stage1/2 JSON parse、claim 跳过规则、encoded path。  
supervisor：`maybeLearnFromTurn` 删除或变成 no-op；spawn 注入断言改路径。
