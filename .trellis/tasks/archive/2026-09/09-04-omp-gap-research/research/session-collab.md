# 会话 / 协同：oh-my-pi vs EnsoCode

来源：coworker `omp-session`。已排除我们已有的 coworker / subagent / goal / steer / 手机伴侣 / ask_user。

## 对方有而我们没有

### TTSR
- 规则默认不进 prompt；流式匹配 regex/AST；abort + reminder + 同点重试；可 discard 脏 assistant。
- 难度：中高。**值得抄（护城河）。**
- 路径：`session/ttsr-coordinator.ts`、`docs/ttsr-injection-lifecycle.md`

### 探后折叠（explore-fold）
- **产品名：探后折叠**。工程 id：`explore-fold`。omp 实现仍叫 `checkpoint`/`rewind` 工具。
- **不是** Enso 时间线用户 rewind（`supervisor` `navigateTree` + 可选 git 文件还原）。
- 模型：`checkpoint(goal)` → 一堆 read/grep → `rewind(report)`，中间 tool 轮从 **LLM context** 抹掉，只留报告。默认关，`checkpoint.enabled`。
- 我们已有：用户回退到第 N 条 user、可选 restoreFiles；另有 git checkpoint 与 compact。缺的是探后折叠。
- 难度：低。值得抄。
- 路径：`oh-my-pi/.../tools/checkpoint.ts`；Enso：`src/agent/supervisor.ts` case `'rewind'`、`TimelineRow` RewindButton

### Advisor / Watchdog
- 独立只读会话盯主模型；nit / concern / blocker。
- 难度：中。**值得抄，和 coworker 正交。**
- 路径：`advisor/runtime.ts`、`docs/advisor-watchdog.md`

### Schema yield + `agent://`
- `outputSchema` + 最多 3 次强制 yield；`agent://id?q=` 抽字段。
- 难度：中。**值得抄。**

### IrcBus
- 子代理互发；idle 唤醒、parked 拉起、busy 边界注入。
- 我们 coworker 只通主会话。难度：中。**可观望/值得试。**
- 路径：`irc/bus.ts`、`session/irc-bridge.ts`

## 可观望

- magic keywords：`ultrathink` / `orchestrate` / `workflowz`
- `/vibe` 导演模式（主会话只 read + vibe_*，fast/good worker）
- `/fresh` 只重置 provider stream，保留本地历史
- 模型角色 `@smol/@slow/@plan/@commit/@advisor/@tiny`
- `/collab` QR + 免装网页（我们手机伴侣更完整，网页看播更轻）
- `/resume @claude` 接管外生会话；单文件 HTML export

## 我们更强

- Coworker 图形 Tab vs Alt+A TUI Hub
- 手机伴侣长期绑定 vs 临时 collab
- Steer 队列、Worktree UI（不必跟 pi-iso 文件系统驱动）

## Top 5

1. TTSR  
2. 探后折叠（explore-fold）  
3. Advisor  
4. Schema yield + agent://  
5. IrcBus  
