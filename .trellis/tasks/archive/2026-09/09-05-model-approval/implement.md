# 实现清单

TDD：先红灯再实现。大逻辑用 coworker 角色分离（tester 只写测试）。

## 0. 探 API（实现第一刀，不写功能）

确认 worker 内能否对任意 `SpawnModelConfig` 做无工具一次性补全。有则走 worker 内评审；无则走 Main IPC 往返。只保留一条路径。

## 1. 评审纯函数（独立文件，先测后写）

- 新增 `src/agent/approvalReview.ts`：hash、prompt 组装、`normalizeReviewDecision`。
- 测试 `src/agent/approvalReview.test.ts`（表驱动）。红灯到手前不写实现。

## 2. 设置 + 协议

- settings 增 `approvalReviewer: DefaultModelRef | null`（sanitize 跟 `defaultModel` 同规）。
- `ProvidersSettings` 一行 ModelPicker；可清空。
- `APPROVAL_MODES` 加 `'assistant'`。
- spawn / set-approval-mode：`assistant` 时解决可用 reviewer，否则拒。
- pair 字面量同步。
- i18n 中英 + `i18n.test.ts` 映射表。

## 3. ApprovalGate

- `needsApproval`：`assistant` 与 `supervised` 同集合。
- `ask` 可注入 reviewer；评审结果 settle 或降级 `onRequest`。
- `set-approval-mode` 同步 mode + reviewer。
- 扩 `approval.test.ts`。abort/cancelAll 回归必须绿。

## 4. Supervisor / Host / Store

- spawn / settings-changed 把全局 reviewer 的 `SpawnModelConfig` 下发 worker。
- `setApprovalMode('assistant')`：渲染层先看 settings 有可用 reviewer，主进程再校一次。
- 会话 persist 只带 `approvalMode`，不带 reviewer。

## 5. UI

- `ApprovalModePicker` 第四档；无 reviewer 时禁用。不内嵌 ModelPicker。
- `StatsLine` / ChatView。
- `NewRemoteSessionDialog`、phone `NewSessionSheet` 档位。
- 审批卡「代审中」状态（最小改现有 approval UI）。

## 6. 验证

```
pnpm typecheck
pnpm test
biome check 变更文件
```

## 回滚点

- 协议合并后若 pair 旧端不认新字面量：档位在旧端忽略，桌面仍按 `assistant` 运行；不要为旧端把字面量伪装成 `supervised`。
- 评审调用若卡住工具轮：保证 timeout + abort 绑定，失败回问。

## 不做

- 会话级代审模型、回退会话模型。
- DeepChat ApprovalBroker。
- 代审走 subagent。
