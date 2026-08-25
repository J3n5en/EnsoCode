# Implement: 工具审批门

1. [ ] shared/types/agent.ts:ApprovalMode/ApprovalKind/ApprovalRequestInfo、命令与事件扩展、parse 收窄、SessionSnapshot.pendingApprovals。
2. [ ] src/agent/approval.ts:ApprovalGate + withApproval 包装;vitest(needsApproval 三档、allowSession、deny 抛错、cancelAll)。
3. [ ] supervisor.ts:per-session gate、excludeTools 三件套、包装接入(bash/edit/write/MCP)、approval-respond / set-approval-mode 命令、abort 时 cancelAll、snapshot 带 pending。
4. [ ] main agentHost + preload:approvalMode 透传、respond/setMode IPC。
5. [ ] renderer reducer + store:pendingApprovals 投影、approvalMode 持久化与下发。
6. [ ] ApprovalBar + Composer 锁定 + ApprovalModePicker;i18n。
7. [ ] 全绿;CDP 实机:supervised 会话 bash 弹条 → 允许/拒绝/本会话允许 三路径、abort 取消、刷新恢复。
8. [ ] 小步提交(worker 协议 / 渲染 UI 可分两笔)。
