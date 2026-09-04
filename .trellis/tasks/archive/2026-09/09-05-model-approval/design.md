# 设计：助手代审

## 范围与边界

- 改审批档位闭集与门闩，不重写工具执行链。
- 代审是**无工具一次性补全**，不走 subagent / coworker。
- 不引入 DeepChat `ApprovalBroker`。继续用本仓 `ApprovalGate`（fail-closed）。

## 档位语义

| mode | 行为 |
|------|------|
| `supervised` | 全部需审（现状） |
| `auto-edits` | 免 file-edit / file-write（现状） |
| `full` | 全免（现状） |
| `assistant` | 与 `supervised` 相同的「要不要审」集合（command / file-edit / file-write / mcp）；审的主体先是代审模型，再按结果放行 / 回问 / 拒绝 |

对齐 DeepChat：`auto_approve` 在权限层被当成 `full_access` 以便工具能跑，但执行前对权限请求以及 file/command/search 类 agent 工具做 LLM 评审。本仓没有 DeepChat 那套 precheck/full_access 双轨，等价映射就是 **不要用 `auto-edits` 免文件**，该审的都代审。MCP-app 在 DeepChat 的 `requestAppDecision` 对 `auto_approve` 直接放行——本仓 MCP 工具走同一道 `withApproval`，**不单独豁免**（比 DeepChat 更严，避免 MCP 写操作漏审）。

## 数据与协议

- `APPROVAL_MODES` 增加 `'assistant'`。
- 代审模型是设置全局项 `approvalReviewer: DefaultModelRef | null`，与 `defaultModel` 同形状、同一套可用性检查（`modelUsability`）。旧 `settings.json` 缺字段 = `null`。
- 会话只存 `approvalMode`，**不存会话级 reviewer**。worker 在 spawn / settings-changed 时拿当前全局 reviewer 的 `SpawnModelConfig`。
- `set-approval-mode` 只传 `mode`。`assistant` 且全局 reviewer 为空或不可用：IPC 拒绝；已在该档运行时评审失败 → `ask_user`，不放行。
- pair `ApprovalMode` 同步字面量。手机/远程不选模型；切档受桌面设置约束。
- 解析失败或未知 mode：**不得**当成 `assistant` 放行。未知 mode 拒命令或回退 `supervised`（更严），测试钉死。

## 运行时数据流

```
withApproval
  → gate.needsApproval（assistant 与 supervised 同集合）
  → gate.ask
       → 若 mode===assistant：reviewer(info, signal)
            auto_allow → settle('allow')，可先发 reviewing 再 resolved
            block      → settle('deny')
            ask_user / 失败 → 走现有 onRequest，弹出审批卡（summary 可附 rationale）
       → 其它档：直接 onRequest
```

代审调用放在 **agent worker**，与门闩同进程：

- 已有 `modelRuntime` / `resolveBaseModelOrRefresh`，能解析全局 reviewer 的 `SpawnModelConfig`。
- abort signal 与 `cancelAll` 直接打断评审。
- 避免「先弹卡、再 IPC 回主进程补全、再 respond」的往返。

若 pi runtime 没有轻量 one-shot API，则退化为：worker 发 `approval-review-invoke`，Main 用现有 provider 补全，结果回 `approval-review-result`。优先 worker 内补全；实现时先探 API，再选一条，不要两条并存。

超时：30s。超时、抛错、空响应 → `ask_user`。

## 评审契约（纯函数，单测主阵地）

输入：`tool / kind / summary / 最近若干条投影消息`。

输出：`{ decision: 'auto_allow' | 'ask_user' | 'block'; riskLevel?; rationale?; actionHash }`。

规范化（对齐 DeepChat，本仓可复用同一策略）：

1. 必须回显 `actionHash`，否则 `ask_user`。
2. 必须有合法 `riskLevel`。
3. `critical` → `block`（覆盖模型自己的 allow）。
4. `high` → `ask_user`（即使模型写 allow）。
5. `auto_allow` / `allow` 且 risk 为 low|medium → `auto_allow`。
6. `block` / `deny` 且非 critical → `ask_user`（给用户最终决定，除非 critical）。
7. 其它 / 坏 JSON → `ask_user`。

Prompt 把 transcript 与参数当不可信证据；禁止只因路径在工作区外就标 high/critical。

## UI

- `ApprovalModePicker` 第四项：盾牌 +「助手代审」。全局 reviewer 为空或不可用时该项禁用，描述指向设置。
- `ProvidersSettings`（默认模型 / 子代理模型附近）增「助手代审模型」一行：`ModelPicker`，可清空。
- `StatsLine` 增加该档 icon/label。
- 代审中：现有审批卡显示「助手代审中…」或独立短状态；结束为 resolved 则消失，回问则变成允许 / 本会话允许 / 拒绝。
- 远程新建、手机新建：先能选档；模型选择能带就带，否则省略 reviewer（回退会话模型）。

## 兼容与错误

- 旧会话无 `assistant`：行为不变。
- 切到 `assistant` 但 reviewer 中途变不可用 / 被清空：下一次评审失败 → 回问用户，卡上写清原因，不静默改回 `full`。
- 已挂起的真人审批不因改设置里的 reviewer 重评。

## 测试

- `approval.test.ts`：`assistant` 的 `needsApproval` 与 `supervised` 同；`full`/`auto-edits` 回归。
- 新 `approvalReview.test.ts`：规范化表驱动（hash、critical、high、坏 JSON、超时映射）。
- `parseAgentCommand` / spawn 校验：接受 `assistant` + 合法 reviewer；拒绝脏 reviewer。
- i18n 映射表补新文案 key。
- UI 不单测（规范：组件暂未覆盖）。
