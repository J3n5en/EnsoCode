---
name: project-knowledge
description: >
  Navigate EnsoCode's long-term engineering conventions, layer boundaries, testing rules,
  historical decisions, and high-cost pitfalls. Use before non-trivial or cross-layer changes,
  when adding IPC or session/worker behavior, when debugging state/history/input issues,
  when a fix reveals a reusable rule, or when the user asks to search or capture project knowledge.
  项目知识导航、踩坑检索、根因沉淀、TDD 和工程约定。
---

# Project Knowledge

这是项目知识的导航和维护入口，不替代权威文档，也不恢复任务状态机或工作流。先按下面的场景选择最相关的文档，避免无目的地通读整个知识库。

## 动手前：先读什么

| 场景 | 必读资料 |
| --- | --- |
| 任意非平凡改动 | `AGENTS.md`、`docs/engineering-guidelines.md` |
| 跨主进程 / preload / renderer | `docs/engineering-reference/guides/cross-layer-thinking-guide.md`、`main/ipc.md` |
| Main、worker、child、session | `docs/engineering-reference/main/services.md`、`renderer/state.md` |
| 新增或修改 IPC | `docs/engineering-reference/main/ipc.md` |
| provider、skill、MCP、指令扫描 | `docs/engineering-reference/main/services.md`、`testing.md` |
| React、Zustand、持久化 | `docs/engineering-reference/renderer/state.md`、`renderer/components.md` |
| UI、弹窗、窗口、样式 | `docs/engineering-reference/renderer/components.md`、`dialogs.md`、`styling.md`、`main/windows.md` |
| Windows 本地安装包 | `docs/engineering-reference/guides/EnsoCode_Windows本地打包_操作指南.md`；使用既有入口，不重复环境探索 |
| 纯逻辑、协议、解析器、路径校验 | `docs/engineering-reference/testing.md` |
| 怀疑已有类似实现 | `docs/engineering-reference/guides/code-reuse-thinking-guide.md` |

动手前至少回答：行为差距是什么、行为真正属于哪一层、哪些文件必须改、哪些相邻问题明确不做。

## 排障时：先查症状和根因

先看 `docs/engineering-reference/big-question/index.md`，再打开与症状最接近的条目：

| 症状 | 优先检查 |
| --- | --- |
| preload 改动后应用启动失败 | `big-question/preload-externalization.md` |
| 状态不更新、一直加载、推送无效 | `main/ipc.md`、`main/windows.md` |
| 同一个资源被导入多份 | `big-question/dedupe-identity.md` |
| 冷会话 / 历史为空，先发消息后正文消失 | `big-question/optimistic-echo-blocks-snapshot.md` |
| 多轮后历史消息消失 | `big-question/agent-end-run-scoped-messages.md` |
| worktree 切换后文件写错位置 | `big-question/worktree-move-races.md` |
| CDP 点击、拖拽或输入时好时坏 | `big-question/cdp-hidden-window-input.md` |
| retry、回退、恢复行为异常 | `big-question/pi-auto-retry-willretry.md`、`checkpoint-cross-session-wipe.md` |
| 弹窗或下拉无响应 | `big-question/dialog-layering.md`、`ui-component-classname.md` |

排查应沿完整链路验证可观察事实：

```text
UI → store/reducer → preload → IPC → Main → worker / 文件 / 网络
```

优先检查 IPC 返回值、持久化文件、worker 事件和 CDP 运行时状态，不要只根据症状所在的组件猜根因。

历史设计、研究和开发日志位于 `docs/project-history/`。它们用于找背景和已有决策，不是当前规范；如果历史资料和当前源码或工程规范冲突，以当前源码、`AGENTS.md` 和 `docs/engineering-reference/` 为准。

## 测试与验证

改动纯函数、解析器、协议校验、路径校验或 reducer 时必须遵循：

1. 先写测试并确认它因缺少功能而失败（RED）。
2. 写最小实现使其通过（GREEN）。
3. 跑全量测试后提交。

修 bug 同样先写复现测试。测试应断言可观察行为，不要只断言内部调用或错误文案。涉及模型自主调用工具的链路，至少用两个不同厂商的模型真机验证。

提交前运行：

```bash
pnpm typecheck && pnpm lint && pnpm test
```

## 发现新知识后：如何沉淀

完成实现或排障后，只有具备复用价值的结论才写入文档。判断标准：

- 是否是一个其他模块也可能遇到的根因或边界条件？
- 是否改变了以后实现、测试或排查的默认做法？
- 是否有明确的回归测试、真机证据或可观察现象？

按类型选择落点：

| 知识类型 | 落点 |
| --- | --- |
| 高频、稳定的硬规则 | `AGENTS.md` |
| 项目级开发约定或跨层规则 | `docs/engineering-guidelines.md` |
| 某一层或某一模块的详细契约 | `docs/engineering-reference/main/`、`renderer/`、`shared/` 或 `guides/` |
| 真实踩坑、症状与根因错位、排查成本高 | `docs/engineering-reference/big-question/` |
| 一次性设计背景、方案比较、历史决策 | `docs/project-history/` |
| 纯回归防线 | 对应测试文件；必要时加简短背景注释 |

新增高代价陷阱使用以下结构，务必写清真实症状和回归防线：

```md
# 问题标题

## 症状

## 根因

## 修法

## 回归防线

## 相关代码
```

更新文档后同步检查相邻规范和已有链接，避免把同一规则复制成互相漂移的多份内容。不要把一次性的聊天总结、未经验证的猜测或完整任务日志直接写进长期规范。

## 知识库上限与压缩清理

本项目暂不自动删除或自动改写知识文档；压缩清理采用人工审计，避免误删有价值的根因和回归证据。每次新增知识前，以及完成一组相关任务后，按下面的规则检查：

| 内容 | 建议上限 | 超限处理 |
| --- | ---: | --- |
| `AGENTS.md` | 约 100 行 | 只保留高频硬规则，其余移到 `docs/engineering-guidelines.md` 或 reference |
| `docs/engineering-guidelines.md` | 约 250 行 | 按主题拆到 `docs/engineering-reference/` |
| 单个 `big-question` 条目 | 约 150–250 行 | 删除过程日志，只保留症状、根因、修法、回归防线和相关代码 |
| `project-knowledge/SKILL.md` | 约 150 行 | 只保留导航、检索、沉淀和维护规则，不复制规范正文 |
| `docs/engineering-reference/big-question/` | 不设硬上限 | 合并重复问题，按症状和根因去重 |
| `docs/project-history/` | 不设硬上限 | 按日期归档；只保留仍有背景价值的设计和研究结论 |

### 新增前去重

1. 先搜索 `AGENTS.md`、`docs/engineering-guidelines.md`、`docs/engineering-reference/` 和 `docs/project-history/`。
2. 已有同一规则时更新原文，不新建相似条目。
3. 同一根因导致多个症状时，保留一个根因条目，并在症状表中列出表现。
4. 只有具备可观察证据、回归测试或明确设计决策的内容才进入长期知识库。

### 手动压缩

- `AGENTS.md` 只保留贡献者每天需要看到的规则。
- 工程规范保留当前行为契约；旧实现细节和一次性方案比较移入 `project-history/`。
- `big-question` 条目删除聊天过程、重复代码片段和无结论尝试，保留最短可复用解释。
- 历史任务保留最终 PRD / design / research 结论；纯 context manifest、重复验收过程和临时日志可以删除。
- 规则被当前代码淘汰时，不要直接抹掉证据：先在文档中标注已过期及替代规则，确认无引用后再删除。

### 自动维护命令

项目提供三条命令：

```bash
pnpm knowledge:check
pnpm knowledge:clean
pnpm knowledge:clean -- --apply
pnpm knowledge:compact
```

- `knowledge:check` 只读检查文档行数、Markdown 链接和踩坑条目结构；发现问题时返回非零状态，不修改文件。
- `knowledge:clean` 默认 dry-run，列出历史目录中的临时 `.jsonl` 文件；只有显式传 `-- --apply` 才移动到 `docs/knowledge-review/archive/`。
- `knowledge:compact` 检查超长 `big-question` 条目，在 `docs/knowledge-review/compact/` 生成源文件副本和压缩提示；原文不变。
- 设置 `OPENAI_API_KEY` 后，`knowledge:compact` 可调用兼容 Chat Completions 的模型生成草案；可选 `OPENAI_BASE_URL` 和 `OPENAI_MODEL`，模型输出仍只写入审阅目录。
- 自动命令不会直接覆盖、删除或合并当前知识。应用模型草案前必须人工检查 diff，并确认根因、证据、风险和源码链接没有丢失。

### 安全原则

压缩清理只能减少重复和过程噪声，不能删除：

- 真实 bug 的根因和症状；
- 回归测试、真机验证或安全边界证据；
- 仍被源码、测试或其他文档引用的内容；
- 尚未完成的设计决策和风险记录。

## 维护边界

- 本 skill 只负责知识检索和知识沉淀。
- 不创建或维护任务状态，不引入 workflow、session pointer、JSONL manifest 或平台 hook。
- 不把 `docs/project-history/` 当作当前行为契约。
- 不为重复已有规则而新增抽象；优先更新最接近权威来源的文档。
