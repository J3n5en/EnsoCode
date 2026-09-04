# 设计

对照 omp 机制，按 Enso 现有 supervisor / coworker / Usage 面板落地。stats 大盘已有，不当新功能做。

## bash 纠偏

- 新文件 `src/agent/bashInterceptor.ts`：纯函数 `checkBashInterception(command, availableTools)`。
- 在 `createBashToolDefinition` 外包一层：execute 前检查，block 则返回 tool error（不跑 shell）。
- 切分：`;` `&&` `||` 换行作新命令；`|` 后段若吃 stdin 不拦。
- POSIX 规则对齐 omp 默认子集（read/grep/edit/find）；无 `hub`/`write` 重定向规则（我们已有 background_tasks）。
- PowerShell：`Get-Content|gc|type`、`Select-String|sls`、`Set-Content`/`Add-Content` 就地写。omp 未做，我们补识别。
- **本批不改执行器**：Windows 仍走现有 bash/WSL；模型写 PS 会被拦并导向 read/grep/edit，不会改用 pwsh 跑。
- `git` 原生命令不拦。建议工具不在 availableTools 则不拦。

## 探后折叠

- 工具 `explore_mark` / `explore_fold`，设置 `exploreFoldEnabled` 默认 false。
- 会话态：pending mark entry id；fold 后记 `{ from, to, report }`。
- **LLM 视图**（`transcript.ts` / prompt 组装）把区间内 tool 消息换成一条 `Explore report:\n…`；时间线 / jsonl 不删。
- 未 mark 就 fold、双重 mark：工具报错。
- 用户 rewind 不走这条路径。

## 结构化 yield

- `src/agent/structuredYield.ts`：解析最后一条 assistant JSON、对照 schema（用已有依赖，避免新包；必要时最小 JSON Schema 子集：type/required/properties）。
- `subagent` 参数加可选 `schema`。失败注入「只输出 JSON」再 `prompt`，最多 2 次。
- 父侧登记 `structuredById`；`read` 认 `agent://<id>` 与 `?q=` JSON Pointer。
- coworker：若 spawn/send 带 schema，report 文本后附 `<!-- yield:json -->` 块。本批不做 coworker 的 `agent://`。

## 互聊

- `coworker` 增加 `operation: message`，参数 `to` + `text`（`name` 仍是发送方）。
- supervisor 复用 ParentNotifier 同类队列，目标改 coworker 会话。
- 时间线记一条 coworker→coworker 消息，Tab 可见。

## 本地记忆

- 开关 `localMemoryEnabled` 默认 true。
- 会话变 idle 且本轮有实质 assistant 输出后，异步跑标题模型：输入=最近对话切片，输出=3～8 条短要点。
- 写入 `{project}/.enso/learned.md`，条目指纹去重。失败静默。
- 下次 spawn 把该文件当 agentsFiles 附加（有则）。

## stats

- 先搜 tool 失败是否已进 usage jsonl。没有则本批跳过，不在 Usage 面板造假数据。
