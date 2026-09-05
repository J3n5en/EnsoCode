# 已拍板要抄（尚未开独立实现票）

来源：主会话对差距清单的取舍。未列入的（Hashline / conflict:// / artifact / prewalk / 角色链 / LSP / 规则按需读 / `/review`）先不动。

- [ ] **结构化 yield + `agent://`**：子代理按 schema 交结果，主会话按路径抽字段
- [ ] **本地两阶段记忆**：会话后萃取 → `learned.md` / 可复用 skill
- [ ] **stats 用量大盘**：跨会话 token / 成本 / 工具失败
- [ ] **探后折叠（explore-fold）**：模型设点探完，中间 tool 轮从 LLM context 抹掉，只留 report（不是用户 rewind）
- [ ] **子代理互聊（IrcBus）**：coworker 之间可发消息，不必每句绕主会话
- [ ] **bash 纠偏**（用户：「感觉可以」）：拦 `cat`/`grep`/`sed -i`，导向 read/grep/edit

实现时各自 `task.py create`，不要塞进本调研票改产品代码。

## 后续讨论（未拍板）

- **eval 回调 / tool 重入**（≈ OpenClaw / Codex 的 code mode）：脚本里循环调用 `tool.read` / `agent()`，对话只留一次 eval + 摘要。机制对，内核重（常驻解释器 + 桥 + 沙箱）。结构化 yield 先吃「子代理交机器可读结果」，吃不掉「本进程循环调工具」。再开票前先对齐安全边界与是否先做 JS。
