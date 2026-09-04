# TODO 六件套

## Goal

落地调研拍板的六条（stats 降级）：结构化 yield、本地记忆、探后折叠、子代理互聊、bash 纠偏；Usage 大盘已有，本批只尝试补工具失败率，没有埋点则跳过。

## Requirements

1. **结构化 yield（subagent 优先）**
   - `subagent` 可选 `schema`（JSON Schema 对象）。
   - 子代理最后一条必须是符合 schema 的 JSON；校验失败最多再催 2 次。
   - 父会话可读 `agent://<id>`（全文）与 `agent://<id>?q=<json-pointer>`（抽字段）。
   - coworker 本批只在 `report`/`wait` 结果里附同样的 JSON 块（若调用方传了 schema），不做完整 `agent://`。

2. **本地两阶段记忆**
   - 会话正常结束后，用标题摘要那条便宜模型路径萃取要点。
   - 写入项目 `.enso/learned.md`（追加、按条目去重）。
   - 设置开关默认开，可关。不自动升 skill。

3. **探后折叠 explore-fold**
   - 工具：`explore_mark(goal)` / `explore_fold(report)`。
   - 设置默认关；会话可开。
   - 时间线给人看仍完整；下一轮送给 LLM 的 context 抹掉 mark→fold 之间的 tool 轮，换成 report。
   - 不是用户 rewind，不碰 git checkpoint。

4. **子代理互聊**
   - 不新增顶层工具。`coworker` 增加 `operation: message`（`to` + `text`）。
   - 投递抄 `message_main_agent`：对方 idle 唤醒，busy 搭下一轮工具结果，不打断当前轮。
   - 用户 Tab 看得到这条消息。

5. **bash 纠偏**
   - 硬拦，提示改用 read/grep/edit/find。
   - POSIX：`cat/head/tail/less`、`grep/rg`、`sed -i`/`perl -pi`；管道后段吃 stdin 的不拦；`git` 原生命令放过。
   - PowerShell（omp 没有）：`Get-Content`/`gc`/`cat`、`Select-String`/`sls`、`Set-Content -Path` 就地改文件等。
   - 建议工具不在会话里时不拦。

6. **stats**
   - 设置 → Usage 已有 token/成本/缓存/分模型分项目。
   - 本批只补工具失败率；没有现成埋点则整条跳过，不新做面板。

## Acceptance Criteria

- [ ] `checkBashInterception` 单测覆盖 POSIX + PowerShell + 管道放过
- [ ] explore-fold：mark 后 fold，后续 prompt 的 LLM 视图含 report、不含中间 tool 结果
- [ ] subagent + schema：合法 JSON 一次过；非法再催；仍非法则失败
- [ ] `agent://id?q=` 能抽出字段
- [ ] coworker `message` 能投到另一 coworker，不绕主会话正文
- [ ] 会话结束后 `.enso/learned.md` 有去重追加（开关开）
- [ ] `pnpm typecheck && pnpm test` 绿；不改无关功能
