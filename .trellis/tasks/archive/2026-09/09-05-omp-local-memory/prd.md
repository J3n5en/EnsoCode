# 对齐 OMP local 两阶段记忆 + learn

## Goal

把本仓「每轮 idle 抽 3～8 条塞进项目 `.enso/learned.md`」换成与 OMP **local backend** 同构的记忆：`learn` 才写 `learned.md`；历史会话走 Phase 1 萃取 + Phase 2 合并；启动时注入的是 **Memory Guidance**（`memory_summary` + `learned`），不是整份复读清单。

本次对齐对象是 OMP `memory.backend = local`（见 `oh-my-pi/docs/memory.md`）。**不对齐** Hindsight / Mnemopi。

## Background

当前 `maybeLearnFromTurn` 用六行提示对最近 12 条纯文本做 `completeSimple`，`mergeLearnedMarkdown` 只做整句小写去重后追加。结果是工具用法与会话状态被复读进 `.enso/learned.md`，下次 spawn 整文件当 `agentsFiles` 贴进去。

OMP local：

- `learned.md` 只由 `learn` 写入（newest-first、100 条、脱敏、注入消毒）；consolidation **不覆盖**它。
- 启动时扫已落盘、已空闲的历史会话做 Phase 1 JSON 萃取，再 Phase 2 写出 `MEMORY.md` / `memory_summary.md` / `skills/`。
- 注入是 `read-path.md` 模板：启发式、仓库为准、引用路径。
- 当前会话、过新（默认 12h idle）、过旧（30 天）、超扫描上限的会话跳过。
- 子代理不做记忆管线。

## Requirements

1. **关掉每轮强制抽取。** `localMemoryEnabled` 为真时不再 `maybeLearnFromTurn` 往 `.enso/learned.md` 追加。
2. **`learn` 工具**（开关开才注册，仅父会话自动带；子代理/coworker 不自动带）：
   - 参数：`memory`（必填）、`context`（可选）、`skill`（可选 `{ action, name, description, body }`）。
   - 写项目记忆根下的 `learned.md`：newest-first、规范化行去重、最多 100 条、content 2000 / context 400、注入消毒 + 密钥脱敏。
   - 不改当前会话 prompt-cache；下一轮/下次 spawn 才注入。
   - `skill` 写入托管 skill 目录，不覆盖用户 authored skill；本轮不立刻 refresh 技能列表。
3. **记忆根不在项目 `.enso/`。** 对齐 OMP：`<agentDir>/memories/<encoded-cwd>/`（`MEMORY.md`、`memory_summary.md`、`learned.md`、`skills/`）。现有项目 `.enso/learned.md` **停止读取/写入**（可一次性提示或设置里说明；不自动搬迁复读内容）。
4. **Phase 1**：worker / 主进程启动记忆维护时，扫描本项目已落盘 jsonl（排除当前会话、coworker/child、idle &lt; 12h、age &gt; 30d，每轮最多 64，扫描上限 300）。模型读会话切片，**只出 JSON**：`rollout_summary` / `rollout_slug` / `raw_memory`。无信号则空串。提示词对齐 OMP `stage_one_system.md` + `stage_one_input.md`。
5. **Phase 2**：有新萃取或 enqueue 时第二遍模型合并，**只出 JSON** 后落盘 `MEMORY.md`、`memory_summary.md`、`skills/`（空 skills 允许；旧托管 skill 目录按本次输出修剪）。**禁止改 `learned.md`。** 提示词对齐 `consolidation_system.md` + `consolidation.md`。落盘前再做密钥脱敏。
6. **注入**：spawn 父会话时拼 Memory Guidance（OMP `read-path.md` 语义），token 预算共享约 5000；**不要**把 `MEMORY.md` 全文当 agentsFile。模型可用 `read` 读记忆根文件（本批可用真实路径；`memory://` 协议可同批或紧随，但注入文案仍写 `memory://root/...` 或同时给出真实路径）。
7. **并发**：Phase 2 要有租约/心跳或文件锁，避免多 worker 双跑。Phase 1 任务可声明式排队（sqlite 或 json sidecar，单测覆盖 claim/lease/retry）。
8. **失败**：超时 / 坏 JSON / 无模型 → 跳过该 job，会话照用；不得把半成品当 summary 注入。
9. **开关**：沿用 `localMemoryEnabled`（关 = 无 learn、无管线、无注入）。不新增 Hindsight 设置。
10. **远程 / 子会话**：remote cwd、coworker、child **不跑**管线、不注册 `learn`。
11. **设置文案**：说明「要点靠 `learn`；跨会话摘要在启动维护后出现」，不再写「每轮结束后写入 .enso/learned.md」。

## Out of scope

- Hindsight / Mnemopi、`recall` / `retain` / `reflect` / `memory_edit`。
- 完整 `/memory view|stats|diagnose|clear|enqueue` 斜杠面（enqueue 可用内部 API + 测试钩子；UI 斜杠可二期）。
- 把复读过的 `.enso/learned.md` 自动洗成 OMP 课程。
- Autolearn 按工具次数后台沉淀 skill（OMP Autolearn 阈值）。
- 会话级记忆模型覆盖；本批用标题/代审同类：设置里的总结模型，缺则会话模型。

## Acceptance Criteria

- [ ] 关 `maybeLearnFromTurn` 后，idle 不再增长项目 `.enso/learned.md`。
- [ ] `learn` 单测：newest-first、去重、cap 100、空内容 stored=0、消毒/脱敏、不碰 consolidation 文件。
- [ ] Phase 1 跳过规则单测：当前会话 / 过新 / 过旧 / 非本项目 / coworker。
- [ ] Phase 1 / 2 JSON 规范化单测：缺字段或非 JSON → 该 job 失败不落盘。
- [ ] Phase 2 不改 `learned.md` 的回归测试。
- [ ] spawn 注入含 Memory Guidance 规则 + summary/learned 片段，**不含**整份旧 `.enso/learned.md`。
- [ ] `localMemoryEnabled=false`：无 learn、无注入、无后台 job。
- [ ] 子代理/coworker 工具列表默认无 `learn`。
- [ ] 相关 vitest + `biome check` 绿；设置 i18n 中英一致。
