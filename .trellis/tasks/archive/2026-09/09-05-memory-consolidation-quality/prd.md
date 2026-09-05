# Memory pipeline: durable consolidation instead of episodic rewrite

## Superseded — user-requested removal (2026-09-05)

The user rejected the generated memory quality and explicitly requested removal of the entire project-memory feature, not only these improvements, followed by a commit. Remove extraction/consolidation, learn and managed-skill writing, automatic injection, memory URI mapping, GUI/IPC/worker commands, and settings. Preserve existing on-disk artifacts and unrelated work, including the SDK upgrade. Migrate settings v5/v6 to v7 without memory fields. Retain only the old zero-valued context-occupancy bucket for persisted snapshot compatibility, hidden from UI. The user separately authorized test-only typing fixes in messageCoworker.test.ts and stallTimeout.test.ts, in their own commit.

The historical requirements below are cancelled, not acceptance criteria for the removal.

## Goal

`memory_summary.md`（每次开会话注入的唯一记忆）现在是"最近几个会话的情节压缩"，
对下一次会话几乎没有价值。目标：让 stage 1 / phase 2 产出的是**跨会话持久的项目知识**
（用户偏好、工作流约定、架构不变量、踩坑及原因、未完成线索），并且旧知识不会因为
rebuild 而蒸发。

## Background / confirmed facts（repo 与磁盘证据）

- 管线：`src/agent/memory/pipeline.ts` — stage 1 每线程抽取 → `stage1_outputs.json`；
  phase 2 用 artifacts 合并写 `MEMORY.md` / `memory_summary.md` / `skills/`。
- 注入：`src/agent/memory/startup.ts` + `guidance.ts` 只内联 `memory_summary.md`
  （预算 20k 字符）+ `learned.md`；`MEMORY.md` 只能靠 agent 主动 `read memory://root/MEMORY.md`。
- 缺陷 1 — `prompts.ts:41-61` phase 2 prompt 没有任何取舍标准 / 结构 / 长度目标，
  只有 "memory_md: long-term memory document / memory_summary: prompt-time memory guidance"。
- 缺陷 2 — `pipeline.ts:167-195` phase 2 输入只有 artifacts，不读现有 `MEMORY.md`；是覆盖重生成，不是增量合并。
- 缺陷 3 — `pipeline.ts:34-42,173-187` `truncateByApproxTokens` 60% 头 + 40% 尾；
  实测 55 artifacts raw 共 209k 字符（≈52k tokens）> 20k tokens 上限，按时间倒序后中段线程整体丢失。
- 缺陷 4 — `pipeline.ts:30,118-122` stage 1 输入仅 4000 tokens（16k 字符）头尾；
  `threads.ts:extractPersistableMessages` 放行 bash/eval/read/grep 单条 ≤32k 的 tool result。
  实测一个 623k 字符会话：toolResult 615k、assistant 文本 7.5k、user 244。stage 1 看到的几乎全是工具输出。
- 缺陷 5 — summary 实际 2.6k 字符（预算 20k），内容偏代码事实（guidance 规则 3/6 自己都说以 repo 为准），
  缺用户偏好 / 工作流 / 坑。guidance 规则 1 "Read memory_summary.md first" 与已内联的内容冗余。
- `learned.md` 独立于管线，已有测试要求 pipeline 不改动它（`pipeline.test.ts`）。
- phase 1 / 2 分别可配置模型，超时 60s / 120s（`supervisor.ts:2912-2960`）。

## Requirements

### R1 Phase 2 prompt 重写（缺陷 1、5）
- 明确分类：用户偏好与沟通习惯 / 工作流与提交约定 / 架构不变量与"别再做" / 坑 + 原因 / 未完成线索。
- 明确排除：单次事件（"用户这次想要 X"、单次拒绝、单次审批）、可从 repo 直接读到的代码事实（除非它是"曾经错过"的教训）。
- `memory_summary`：面向 prompt，按上述分类分节，给出字数目标区间；每节先写最影响下一次行为的条目。
- `memory_md`：结构化 Markdown（标题分节），可以更详细；保留 file:line / commit 锚点。
- 冲突处理：新线程与旧记忆矛盾时以新的为准，并在 memory_md 标记已过期的旧说法被替换。
- 输出契约（JSON 三键）不变。

### R2 增量合并（缺陷 2）
- phase 2 输入加入 "Prior memory" 段：现有 `MEMORY.md` + `memory_summary.md`（各自有 token 上限）。
- prompt 明确：prior memory 是基线，只用新 artifacts 修订 / 追加 / 删过期，不能因为 artifacts 里没提就丢掉。
- 首次运行（无 prior）行为不变。

### R3 截断改为 per-artifact 配额（缺陷 3）
- 替换整段 head/tail 截断：每个 artifact 的 raw_memory 有单条上限；超出总预算时，
  按时间倒序优先保留新线程的 raw，其余线程降级为只用 rollout_summary。`MAX_RAW_MEMORIES_FOR_GLOBAL`
  只限制 raw 候选集（`rawCandidates = sorted.slice(0, maxRawCandidates)`），**不影响 summaries**；
  summaries 遭历全量 `sorted` artifacts，仅受 `PHASE2_SUMMARY_TOKEN_LIMIT` 单一预算约束（新到旧填充，
  超出该预算才丢最旧），保证的是**尽量多线程有 summary 出现**，不是无条件对所有历史 artifacts 的绝对覆盖保证。
- `truncateByApproxTokens` 保留给 stage 1 与 prior memory，不删。

### R4 Stage 1 输入重排（缺陷 4）
- tool result 单条上限从 32k 降到约 1.5k 字符（头尾各半），并在 stage 1 输入序列化时保留 role 顺序。
- stage 1 总预算从 4000 tokens 提到 12000 tokens。
- stage 1 prompt 与 phase 2 同一套分类标准，raw_memory 要求写"为什么"而不只是"做了什么"。

### R5 Guidance 规则精简（缺陷 5）
- 删规则 1；改为"summary 已内联；做 summary 里提到的领域前先 `read memory://root/MEMORY.md` 对应章节"。
- 其余规则保留。

## Acceptance Criteria

- [ ] AC1 `consolidationUser` 输出包含分类清单、排除清单、长度目标、冲突规则（单测断言关键词）。
- [ ] AC2 memoryRoot 已有 `MEMORY.md` / `memory_summary.md` 时，phase 2 userText 包含其内容；不存在时不包含 "Prior memory" 段。
- [ ] AC3 给定 N 个 artifacts 且总 raw 超预算但仍在 summary 预算内，phase 2 输入中每个 threadId 都出现；
  最新线程保留 raw，最旧线程只剩 summary。当 artifacts 数量/总量超出 summary 预算本身时，
  最旧的线程会从 summaries 中被逐出，不做无界覆盖承诺（见 design.md「Lease clock」上方段落）。
- [ ] AC4 `extractPersistableMessages` 对 32k 的 read 结果输出 ≤ ~1.5k 字符且含截断标记；stage 1 输入对 60k 字符会话的截断阈值为 12000 tokens。
- [ ] AC5 `buildMemoryGuidance` 不再输出 "Read `memory://root/memory_summary.md` first"，改为按需读 MEMORY.md 的指引。
- [ ] AC6 现有 `pipeline.test.ts` / `guidance` / `threads` 测试全绿，`learned.md` 仍 byte-identical。
- [ ] AC7 真机：`/memory rebuild`（即 `/memory enqueue`，见 `memoryCommand.ts` 的 alias）只是把
  `.jobs.json` 标记为 `dirty`，不会同步产出新记忆；UI 回显的 "Merging now…" 提示是误导性文案，
  实际合并发生在**下一次触发 `runMemoryPipeline` 的时机**（当前只有 `supervisor.ts` 的会话启动路径会跑管线，
  没有独立的手动即时触发）。人工验收步骤改为：执行 `/memory rebuild` 标记 dirty 后重启会话（或直接用
  `npx tsx scripts/memory-run.ts` 手动跑一次），再读新 `memory_summary.md`，确认不含单次情节句式、分节可读。
  （人工验收，不阻塞合并；后续如需要「点击即刷新」的即时体验，需单独立项在 `slash.ts`/UI 层接入同步触发，
  这不在本任务范围内。）

### R6 管线可独立运行（后补，用户要求）
- 模型调用胶水从 supervisor 抽到 `memory/runner.ts`（`createMemoryCompleteSimple`）。
- `scripts/memory-run.ts`：`npx tsx` 直接跑管线，默认写 `<cwd>/.enso/memory-debug/`，`trace/` 落每次 prompt/response；
  支持 `--phase2-only --reuse-artifacts --seed-prior --limit --idle-hours --max-age-days --provider --model --phase2-model --dev`。
- `runMemoryPipeline` 新增 `stageOneSelect` 透传（仅调试用）。
- 顺带修复：phase 2 失败（超时/解析不了）不再卡在 running 租约且丢失 dirty；phase 2 超时 120s → 300s（实测 38k 字符回复 113s）。
- [ ] AC8 `npx tsx scripts/memory-run.ts --phase2-only --reuse-artifacts` 在 enso-code 上跑通并产出分节 summary。

## Out of scope

- 不把 `learned.md` 喂进 phase 2（保持独立，已有测试约束）。
- 不改 stage 1 候选筛选（idle 12h / 30d / 64 per startup）。
- 不改 phase 1/2 的模型选择与超时。
- 不改 `/memory` 命令与 UI。

## 真实验证证据（非阻塞，人工复核用）

全部路径相对仓库根。`.enso/` 下所有目录都只写 `--out`，从未覆盖正式记忆根
(`~/Library/Application Support/enso-code/agent/pi-agent/memories/--Users-j3n5en-project-enso-code--/`)。

- `.enso/memory-quality-validation-20260905-153731/` — fresh 跑（`--limit 20 --concurrency 4`，cfbot/gemini-3.7-flash），
  20 领取 / 13 有效抽取 / 5 无持久信号 / 2 stage1 超时，phase2 55.9s 成功。
- `.enso/memory-quality-validation-20260905-153731-gen2/` — 同一批 artifacts 重跑 phase2（非真实 prior-only 证据，
  仅证明重建不扔知识）。
- `.enso/memory-quality-validation-20260905-153731-priorcheck/` — **合成测试夹具，目录内有 README.md 明确标注**：
  手工种入一条虽构但真实语料中不存在的先验知识 (`PRESERVATION_PROBE_7f3a2`)，验证对新语料沣默时的
  prior-only 信息真实能存活（实测：成功存活，带完整来源引用）。cfbot 上 gemini-3.7-flash 与
  claude-sonnet-4-6 连续超时，改用 `bed36597.../Max` provider 才跑通。**绝不作为真实项目记忆使用**。
- `.enso/memory-quality-final-20260905-161614/` — **干净最终验证**：`--reuse-artifacts --seed-prior --phase2-only`，
  真实 stage1_outputs.json（262KB，商业项目历史全量 artifacts）+ 真实 prior MEMORY.md/memory_summary.md，
  bed36597/claude-sonnet-4-6。第一次调用（277s，36433 字符）因模型输出中有未转义的 `"` 导致严格 JSON 解析失败，
  `.jobs.json` 正确释放租约并保留 `dirty:true`，原始种子文件未被覆盖（安全机制生效）。第二次调用
  （286s，37485 字符）成功：`phase2Ran: true`，`status: 'done'`，MEMORY.md 25504 字节 / memory_summary.md 7835 字节，
  category 1 正确收窄为 agent-interaction/communication habits。

## 残留限制（不阻塞，待后续跟进）

1. **`redactSecrets` 误报敏感词正则**（`src/agent/memory/sanitize.ts:15`）：`(?:sk|pk|rk|tok|key|secret|token|password)[-_A-Za-z0-9]{12,}`
   的 `rk` 分支只需 2 个字符即可命中，导致普通英文词被误删：实测 `workspaceMigrating` 被改写成 `wo[REDACTED]`，
   `workspace-search-...` 被改写成 `wo[REDACTED] cluster`（见 `.enso/memory-quality-final-20260905-161614/memory_summary.md`
   第 5 节、MEMORY.md 第 3 节）。本任务未修复（范围外，`sanitize.ts` 同时被 `learned.md` 存储复用，改动需单独评估），
   建议后续任务跟进：至少要求 `rk`/`pk`/`sk` 前后有分隔符（`-`/`_`/边界）才命中，避免直接嵌入英文单词。
2. **feature/UI 决定误归入 category 1**：已加强 prompt 约束，实测改善但不保证完全一致（同一次调用中 memory_summary 正确
   重分类但 MEMORY.md 未同步的情况在早期验证中出现过，本轮最终验证中无此现象但不能保证回归）。LLM 判断上限，
   非确定性约束。
3. **memory_summary 长度目标 (1500–4000 字)**：不强制。实测 7835 字节（真实商业项目全量历史），仿旧依然远低于 20k 注入预算，
   按主代理指示不截断。
4. **strict JSON 输出容错性**：大语料（实测 36k+ 字符）下模型偶尔会在 JSON 字符串值内写未转义的 `"`，导致整次
   合并被丢弃（安全但浪费一次完整调用）。未改 `parsePhaseTwoResponse`；候选方案：提示模型用单引号包裹引用、
   或引入宽容 JSON 修复尝试（jsonrepair 类）。
5. **cfbot proxy 不稳**：gemini-3.7-flash 与 claude-sonnet-4-6 在 cfbot 上多次连续超时，外部基础设施问题，未做代码处理。

## 第二轮评审后的强化（prompts.ts 新增约束，均已真机验证）

- prior memory 明确标记为“unverified historical baseline”，不得因保留而隂称已重新验证。
- memory_summary **完全不含任何 open lead**（之前规则只需有来源就保留，现改为无论有无来源/时间都彻底不进 summary，只进 MEMORY.md）。
- open leads 禁止写成可直接复制执行的具体命令（无论有无反引号），只能用文字描述待核实情况。
- memory_summary 每一条都不得夹带“not yet fixed / not shipped / not committed / uncommitted / in progress / pending / unverified / TBD / verify”类措辞（不仅限 category 3，所有分类都适用）。
- memory_summary category 3（架构不变量）最多 8 条；category 4（坑）需去重。
- 损坏/被打码的标识符要省略，只保留因果结论（不碰 sanitize.ts，纯 prompt 级规则）。

### 新的干净验证（无旧 prior，真实 artifacts）

- `.enso/memory-quality-clean-20260905-164507/` — 第一次验证（211.8s）29976 字符，phase2Ran:true。memory_summary 无 open leads、无 hedge 词，category 1 未混入 feature/UI；但 MEMORY.md 仍包含一条可直接执行的 `git branch -D enso/24caf15d`（破坏性命令规则还未写入时），
  且 memory_summary category 4 混有 "(fix written, not committed)" 这类 hedge 词（当时规则只列了 5 个固定词，没覆盖这个变体）。据此再次强化 prompts.ts（禁止字面命令 + 拓宽 hedge 词表）。
- `.enso/memory-quality-clean-20260905-165425/` — **强化后重跑，最新干净样本**（212.3s，29976 字符）：`git branch -D` 命令消失，改为“Manual verification needed — do not run a delete command unattended”；memory_summary 无任何 hedge 词；category 3 恰好 8 条；category 1 正常。注意：这一轮 memory_summary 完全省略了 category 1（机型选择，未强制修复，见下方残留限制）。

### redactSecrets 邮件核实（不是 LLM 限制，是确定性代码 bug）

对比 `.enso/memory-quality-clean-20260905-165425/trace/*/001-phase2.response.txt`（模型原始输出，**零** `REDACTED` 字样，`workspaceMigrating` 完整）与磁盘上的 `MEMORY.md`/`memory_summary.md`（
含 6 处 `wo[REDACTED]`）——确诊损坏发生在 `applyConsolidation()` 写盘时调用的 `redactSecrets()`（`sanitize.ts:15` 的 `rk` 分支），与
模型输出质量无关。prompt 层的“省略损坏标识符”规则**无法修复这个问题**（没有机会，因为模型返回时还没被打码）。

### 后续获授权：窄范围修复 `sanitize.ts`（已完成）

- 根因：`(?:sk|pk|rk|tok|key|secret|token|password)[-_A-Za-z0-9]{12,}` 无边界限制，只需 2 字符 (`rk`) + 后续 12+ 字符即命中，
  不区分“作为完整 token 开头”与“嵌入英文单词中间”。
- 修复：加 `(?<![A-Za-z])` 前置零宽回看断言——前缀前一个字符不能是字母（开头/空格/引号/标点/`-`/`_`/`=` 都算边界）。
  只处理本任务实测的“前缀嵌入单词中间”类型，不扩大检测语义（不新增 `key=value`/`key:value` 形式的识别）。
- `src/agent/memory/sanitize.test.ts` 新增 2 个测试（RED 确认后实现）：不误伤 `workspaceMigrating` / `09-03-workspace-search-context-fork-memory` /
  `marketplace networking token allocation`；真实密钥格式（`sk-proj-...`、`tok_...`、`PASSWORD_...`、`rk_live_...`、紧趿引号/括号的
  `secret...`）仍被脱敏。
- **残留限制**：若标识符本身以 `key`/`tok`/`sk` 等字样开头且后接 12+ 字符英文单词（如 `keystrokeMonitoringDisabled`），仍与真实
  密钥无法区分——子串启发式检测的固有限制，未进一步追求（需英文词典或更精确的密钥格式匹配才能完全解决）。
- 验证：把 `.enso/memory-quality-clean-20260905-165425/trace/*/001-phase2.response.txt`（真实干净样本的原始模型响应，
  未产生新 LLM 调用）重新回放经 `applyConsolidation` 写入新目录 `.enso/memory-quality-clean-20260905-165425-sanitizer-fixed/`：
  `MEMORY.md`(21217 字节)/`memory_summary.md`(4757 字节) 均 0 处 `REDACTED`，3 处 `workspaceMigrating` 全部完整保留。
- 回归：`pnpm exec vitest run src/agent/memory/ src/agent/localMemory.test.ts` → 14 文件/115 测试全绿；`pnpm test`（全量）仍只有同样 3 个
  预存在与记忆无关的文件失败（未因 sanitize.ts 改动新增任何失败）；`pnpm typecheck` 仍与 HEAD 基线字节相同的 12 个预存在错误。
- **未重写正式记忆根或 `learned.md`**：本轮所有验证只写入 `.enso/` 调试目录，从未写入
  `~/Library/Application Support/enso-code/agent/pi-agent/memories/--Users-j3n5en-project-enso-code--/`。

本任务依指示未改动 `sanitize.ts` 以外的任何其他代码。

## R7 GUI 诊断日志（用户新提，支持 GUI 重试排查）

背景：用户在实机 dev 环境发现 `.jobs.json`/`stage1_outputs.json` 处于 `global.status: failed` 且 `dirty: true`，
但无任何诊断信息可以看出上一次失败在哪一阶段、为什么。需要一个与正式记忆目录分开、
不计入 `/memory` 面板 dirSize 统计的持久日志。

- 日志路径：`getMemoryDiagnosticLogPath(agentDir, cwd)` = `<agentDir>/memory-logs/<encodeProjectPath(cwd)>.log`，
  与 `memories/` 平级，不在 `dirSize(root)` 扫描范围内。单项目单文件、追加写 JSONL，每行 `{ ts, ...event }`。
- 事件类型（`src/agent/memory/diagnosticLog.ts` 的 `MemoryDiagnosticEvent`）：
  - `run-start`/`run-end`：`run-start` 在 `executeMemoryPipeline` 任何 await 之前写入（覆盖 `getRuntime`/
    `resolveBaseModelOrRefresh` 的失败也留痕迹，不只记成功走到 `runMemoryPipeline` 之后的部分），含
    provider/model 身份（不含 apiKey/baseUrl）与 concurrency；`run-end` 在 `try/finally` 级别包住整个
    执行，outcome 为 success（phase2Ran）/skipped（无变化）/failure（抛错，附带经 `sanitizeDiagnosticError`
    脱敏的错误摘要后重抛原始错误）。
  - `stage-start`/`stage-end`（candidateCount/claimedCount/elapsedMs）。
  - `stage1-item`：每线程 outcome 四选一：`success`（正常产出）、`skip-empty`（抽取成功但无可持久化
    内容，唯一的“无操作成功”）、`model-failure`（模型/网络调用抛错）、`invalid-json`（模型输出不合规，
    **不是 no-op**，与 `model-failure` 同样经 `onStageOneError` 上报为失败）。
  - `phase2-result`（outcome: success/model-failure/empty-result/invalid-json）、`pipeline-skip`（reason:
    no-changes/forced-empty）、`model-response`（只记 length/stopReason/ok，不记正文，在 `runner.ts` 里发出）。
- 错误文本统一经 `sanitizeDiagnosticError`：先将任意 `https?://` URL 整个换成 `[URL]`（不只换查询串，
  因为查询参数里的凭据不一定符合 key-style 正则），再把 `Bearer \S+` 整段换成 `Bearer [REDACTED]`（比
  `redactSecrets` 内嵌的 Bearer 正则字符集更宽），最后再跑一遍 `redactSecrets` 补充覆盖，最后 500 字符截断。
- `createFileDiagnosticSink` 写失败（目录不可写、磁盘满等）内部吸错，绝不向上抛，不影响记忆管线本身：
  `pipeline.ts` 的 `emit()`、`runner.ts` 的 `emitResponse()` 都同时包住同步抛错（try/catch）与异步 rejected
  promise（`?.catch(() => {})`）两种形式，防止假 sink 打断管线或产生未处理 rejection。
- `runId`：复用已有的 `formatTraceRunId(now, pid)`（原本只给 `scripts/memory-run.ts` 用），由
  `supervisor.executeMemoryPipeline` 生成一个 runId 同时传给 `runMemoryPipeline` 与 `createMemoryCompleteSimple`，
  使两边事件可关联。
- 验证：`diagnosticLog.test.ts`（日志路径/URL+Bearer+key 脱敏/截断/写入/写入失败不报错）、`runner.test.ts`
  （8 个用例：成功记 model-response、传输层异常也记一次 ok:false、缺失 runId 时不记、sink 同步抛错/异步拒绝
  都不影响调用方）、`pipeline.test.ts` 的 `describe('runMemoryPipeline 诊断事件')`（10 个用例：各种 outcome 分支 +
  敏感信息不进日志 + sink 同步/异步抛错都不打断管线）、`supervisor.memoryDiagnostics.test.ts`（3 个用例：记忆专用
  模型解析失败时仍先记 run-start 再记 run-end(failure)、成功/无变化分别记 run-end(success/skipped)）。

### AC9

- [ ] 真实/tmp 路径写入日志文件，JSONL 每行可解析且无完整 prompt/回复正文、无 apiKey/baseUrl。
- [ ] 模拟 stage1 非法 JSON、model 调用抛错（含敏感字符串）、phase2 空结果、日志写入失败（目录不可写），
  均不导致管线报错/中断，且不将敏感字符串写入日志。
- [ ] `pnpm exec vitest run src/agent/memory/ src/agent/supervisor.memoryModel.test.ts` 全绿，`pnpm typecheck` 无新增错误（仍为
  既有与记忆无关的基线错误），`pnpm test` 全量仅既有 3 个与记忆无关的预存在失败文件（`supervisor.agentDispatch.test.ts`、
  `supervisor.coworkerWait.test.ts`、`productCapabilityCoverage.test.ts`，都不引用任何 memory/diagnosticLog 代码、
  单独跑也失败，确认为本任务无关的预存在 WIP 缺口）。

### 人工验证步骤（重启应用后多试 GUI 管线）

纠正：上一轮误以为“/memory rebuild 只标 dirty，必须重启会话才能触发真正合并”（旧 AC7 描述）。实际上
**MemoryPopover 的 “Merge now” 按钮** 会直接调 `action: 'enqueue'` → `src/main/ipc/agent.ts` 的 `memory` handler，
同时干两件事：标 dirty **并** 用 `requestMemoryPipeline()`（`agentHost.ts`）直接向 worker 发 `run-memory-pipeline`
命令，进 worker 的 `supervisor.runMemoryPipelineCommand` → `executeMemoryPipeline`（本轮接线诊断日志的同一个入口）。
无需重启会话。

1. 重启应用（加载新代码）。
2. 打开 enso-code 项目的任何会话，点聊天输入框旁边的记忆图标（`MemoryPopover`），点 “Merge now”/“立即合并”。
   （命令行等价方式：`/memory rebuild` 也行——同样走 `enqueue`，同样直接触发，不需重启）。
3. 弹窗里有进度条（stage1/phase2 百分比），完成后状态变 Ready。
4. `tail -f "~/Library/Application Support/enso-code-dev/agent/pi-agent/memory-logs/--Users-j3n5en-project-enso-code--.log"`
   （打包版把 `enso-code-dev` 换成 `enso-code`）看实时事件：`run-start` → `stage-start(stage1)` → 每线程
   `stage1-item` → `stage-end(stage1)` →（有变化时）`stage-start(phase2)` → `model-response(phase:2)` →
   `phase2-result` → `stage-end(phase2)` → `run-end`（outcome: success），或 `pipeline-skip` + `run-end(skipped)`。
   若运时/模型解析本身就失败（如记忆专用模型不可用），日志仍会有 `run-start` 开头、`run-end(outcome:failure)`
   收尾，不会因为失败发生在模型解析阶段而完全无痕迹。

## 第三轮重设：memory_summary 架构重写（取消 hedge 词黑名单，改为“只写未来行动指引”）

因 hedge-word 黑名单本身会诱导模型把不确定声明改写得更笃定而不是真正降级，已按指示完全取消，改用结构性约束：

- `memory_summary` **只写稳定的未来行动指引**：每条都必须是前瞻性规则，不得是状态报告/历史叙事/当前实现声明。
- 总计最多 12 条不重复要点（跨全部分类合计，不是每类 8 条）。
- 坑要点只写预防动作+原因（如“Render error state independently of whether the timeline is empty”），不叙述历史 bug，
  不声明当前是否已实现（历史框架只留在 memory_md）。
- 不得包含具体分支/文件级的临时性 WIP 或当前测试失败状态。
- 用户明确例外指令（如“开干”）要保留当时适用条件，不能剮离上下文变成无条件通用规则（EXCLUSIONS 新增共享条目，stage1/phase2 都适用）。
- 不确定/未验证的表述不得被改写得更笃定去避开黑名单词，而应降级移出 summary 进 memory_md（保留不确定性）。

### 真机验证：`.enso/memory-quality-gen1small-20260905-173024/`

- 输入：复用 gen1 小样本（`memory-quality-validation-20260905-153731` 的 `stage1_outputs.json`，13 个非空提取），
  无 prior，提供方 bed36597/claude-sonnet-4-6。116.8s，18496 字符，phase2Ran:true。
- `memory_summary.md`：11 条（category 3：7、category 4：4），均在 12 条上限内；**零** open leads；**零** hedge 词；
  所有坑要点均为纯前瞻性预防规则，无一处 “Previously” 历史叙事。
- `MEMORY.md`：第 5 节 open leads 三条均无可直接执行命令，改为“Verify and clean up manually if present”类描述。
- Category 1（agent-interaction）在 memory_md 与 memory_summary 中均为空（因为本轮语料确实无此类内容，现有“空分类不写”规则正确生效）。
  译注：不声称这是“完美”——只是本次语料碦巧没有真正的 agent-interaction 类知识，不代表该类别永远不会出现在 summary 中。
- 直接来源校验（举例，非穷举）：`stage1_outputs.json:21` 含原始 “Show all / 显示所有” 描述，本轮正确归入 category 3（不再误归 category 1）；
  `stage1_outputs.json:49` 含原始 “Selective Staging with Dirty Worktree” 描述，与 MEMORY.md 第 2 节内容字面对应。
- 根据指示，本轮未重跑全量 `pnpm test`/`pnpm typecheck` 基线（已在前两轮确认），只跑了 `pnpm exec vitest run src/agent/memory/`（110/110 绿）+ biome（干净）。

## 第四轮：穷举审计 11 条 + 2 个新实准确性规则 + 人工复核交付物

经 3.5 轮人工评审，`gen1small` 样本 11 条中发现 3 个真实缺陷，均以定向 grep 验证（非全库探索）：

1. **布尔逻辑反转**（句 1）：原文说 `status === 'running'` **AND** `Boolean(compaction)`，实际应为 **OR**（压缩中 status 仍为
   `'idle'`，若要求 AND 则永远判不忙）。定向验证：`src/renderer/stores/sessions/index.ts:1845` 实际代码为
   `(conversation.status === 'running' || conversation.compaction)`。
2. **实现名冲突/过时**（句 3）：原文说 “Use stock `createEditToolDefinition` directly”。定向验证：`src/agent/supervisor.ts:1288`
   实际调用 `createNormalizedEditTool(...)`，`src/agent/editTool.ts:44-45` 显示后者包装前者。原句断言与当前仓库不符。
3. **重复要点**：架构第 3 条（与实现名冲突同一条）与坑第 4 条重复表达同一根因（TypeBox schema 加宽）。

### 新增 2 个共享准确性规则（`ACCURACY_RULES`，TDD，已 GREEN）

- 复述条件/布尔规则时必须保留原始逻辑运算符（AND/OR），不得改重说时翻转。
- 多个 artifacts 对同一行为指向不同具体实现名时，memory_summary 只留稳定不变量，不写死具体实现名（memory_md 可保留最新名字+来源，若有证据）。
- 未重跑真实 LLM 验证（指示明确不需要），只经 `prompts.test.ts` TDD 确认规则本身存在于提示词中。

### 人工复核交付物（`.enso/memory-quality-gen1small-20260905-173024/`）

- `memory_summary.md` / `MEMORY.md`：**原始模型输出，未修改**。
- `memory_summary.REVIEWED.md` / `MEMORY.REVIEWED.md`：**人工最小化修复**（AI 辅助人工审核，非模型生成），仅修上述 3 处，
  其余逐字不变。`memory_summary.REVIEWED.md` 去重后从 11 条降为 10 条，仍在 12 条上限内。
- `README.md`：记录完整 provenance——哪 3 处、为什么、对应定向验证证据、不声称自动质量保证。

### 结论（不声称自动质量保证）

管线产出可作为**需人工复核的参考输出**（advisory with review），不是自验证的事实真相源。已发现并修复 1 个真实逻辑反转 bug
与 1 个实现名过时问题，新增的 `ACCURACY_RULES` 提示词约束尚未经真实 LLM 调用回归验证。

## 第五轮：剩余 8 条穷举审计 + 修正 provenance 措辞

对 `gen1small` 样本剩余 8 条（架构第 2/4/5/6/7 条、坑第 1/2/3 条）逐条比对 `stage1_outputs.json` 源 artifact（README.md
完整表格）：**全部 8 条均支持性良好**，没有新发现缺陷（坑 8 条中有 1 条对源有选择性省略一项子项，不算虚构）。
重要发现：已修复的1/2 个缺陷（AND/OR 反转、`createEditToolDefinition` 实现名）**均已存在于 stage1 原始
`raw_memory` 中**（threadId `01a06d5d`、`01a06c74`）—— phase2 是忠实传递了 stage1 已有的错误，而不是自己新增的虚构。
因此 `ACCURACY_RULES` 同时写入 `STAGE_ONE_SYSTEM`与`consolidationUser` 是正确选择。

### provenance 措辞纠正

原文说 “AI-assisted human review”——**不准确**，未有任何人工审核。README.md 已改为：“agent-reviewed and manually
edited through tools; no human verification”，并明确说明编辑者是本 coding-agent 会话本身，不是模型、也不是人。

本轮无代码改动，只改 `README.md` 与 provenance 描述。`pnpm exec vitest run src/agent/memory/`（114/114 绿）/ biome（干净）与之前一致。
