# oh-my-pi 差距调研总评

对照仓库：`/Users/j3n5en/project/oh-my-pi` vs EnsoCode。
六路 coworker：tools / code-intel / session / memory / runtime / product。

## 值得抄（高杠杆、我们缺、落地不依赖整套 Rust 内核）

| 优先级 | 能力 | 为什么 | 难度 | 详见 |
| --- | --- | --- | --- | --- |
| P0 | **探后折叠**（explore-fold；omp 工具名 checkpoint/rewind） | 模型自己设点探仓库，探完中间 tool 轮从 LLM context 抹掉，只留 report。不是用户 rewind | 低 | session-collab.md |
| P0 | `/review` 噪声过滤 + P0–P3 verdict + 跨边界检查 | 我们已有 reviewer 角色，缺流水线 | 中 | code-intel.md |
| P0 | Rulebook 索引 + `rule://` 按需拉取 | 规则不再全文塞 prompt | 低 | memory-rules.md |
| P0 | 运行时发现 Cursor/Cline/AGENTS/Copilot 规则 | 我们是一次性导入副本，对方每次启动原生读盘 | 中低 | memory-rules.md |
| P0 | LSP 最小集：diagnostics / definition / references / rename_file + mux | Agent 告别纯 grep 猜引用 | 中高 | code-intel.md |
| P1 | Hashline 编辑协议 | 锚点防脏写，少吐上下文 | 中 | tools.md |
| P1 | `conflict://` 语义解冲突 | 模型不再手撕 `<<<<<<<` | 低 | tools.md |
| P1 | `bashInterceptor` | 拦 `cat/grep/sed` 导向专用工具 | 极低 | tools.md |
| P1 | `artifact://` 超长输出落盘切片 | 构建日志不再截断丢关键行 | 低 | runtime-natives.md |
| P1 | Prewalk：规划用大模型，首写后切便宜模型 | 成本/速度杠杆大 | 中低 | code-intel.md / runtime |
| P1 | Schema-validated `yield` + `agent://` | 子代理产出可机读 | 中 | session-collab.md |
| P1 | 语义模型角色 `@smol/@slow/@plan/@commit` + fallback | 我们有 coworker 模型，缺角色一等公民 | 低 | product-surface.md |
| P1 | `omp commit` 原子拆分 + topo + lockfile 配对 | 大改动不再糊成一个巨型 commit | 中 | product-surface.md |
| P1 | 本地 stats 大盘 | Token/缓存/成本跨会话 | 低 | product-surface.md |
| P1 | 两阶段 local memory（会话萃取 → learned.md） | 我们只有 occupancy 占位 | 中 | memory-rules.md |

## 可观望（酷，但重或场景窄）

- **TTSR** 流式规则中断 + discard 重试：护城河级，要接流式循环（session / memory）
- **Advisor/Watchdog** 旁路模型 `nit/concern/blocker`：和 coworker 正交，不是替代
- **IrcBus** 子代理互聊：我们 coworker 只通主会话
- **eval + tool 重入**（后续讨论，≈ code mode）：脚本里 `tool.read()` / `agent()`；内核重，见 `TODO.md`
- **万能 read**（zip/sqlite/pdf/AST 折叠）：体验好，适配器堆叠
- **Browser Relay** 接管本机 Chrome 登录态：补 Electron 隔离浏览器的短板
- **Snapcompact** 历史渲成点阵图给视觉模型：黑科技，依赖 vision + 渲染
- **ast_grep / ast_edit** 两阶段预览：依赖 tree-sitter/natives
- **DAP 真调试器**：酷，日常 80% 用不上
- **computer-use / 桌面 AX**：安全面大，IDE 主路径弱
- **in-process Rust bash/rg**：Windows 一致性极强，Electron ABI/CI 极贵
- **ACP 进 Zed**：和「自己就是宿主」定位冲突
- **Marketplace / Claude 插件**：生态快，沙箱责任重
- **Mnemopi / Hindsight / Autoresearch / voice / tts / 生图**：有趣，非桌面编码刚需

## 我们更强（别跟错方向）

- Coworker 独立 Tab + 多轮介入 + `message_main_agent`
- `tester` + `writeScope` 硬限制：测文件白名单，TDD 防作弊
- 桌面多会话 / Worktree UI / 三档审批 / Git checkpoint
- 手机伴侣 E2EE（比 `/collab` 网页看播更完整）
- 内置 Electron 浏览器面板（免装扩展；缺的是宿主 Chrome 登录态）
- Cursor provider bridge、目标模式、steer 队列

## 本轮取舍（用户）

**抄**：结构化 yield、本地记忆、stats、探后折叠、IrcBus、bash 纠偏。见 `TODO.md`。
**后续讨论**：eval 回调 / tool 重入（code mode）。见 `TODO.md`「后续讨论」。
**先不做**：规则按需读、`/review`、Hashline、conflict://、artifact、prewalk、角色链、LSP 四件套。
**已有近似、不是缺口**：设置「加载项目内其它工具目录」（扁平全文塞 prompt，不是 rulebook）。

## 不建议当差距的东西

纯 TUI/安装器包装、31 工具清单里的 read/edit/bash 基线、和我们同级的 subagent/审批。对方「31 tools」很多是把二线能力塞进 `xd://`，不是每个都该平铺进 Function Calling。
