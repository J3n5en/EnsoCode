# Design: 工具审批门

## 拦截架构(worker 侧)

复用 edit 宽容版验证过的「excludeTools + customTools 包装」模式:

```
createAgentSession({
  excludeTools: ['edit', 'bash', 'write'],
  customTools: [
    withApproval(gate, 'command', createBashToolDefinition(cwd)),
    withApproval(gate, 'file-edit', createLenientEditTool(cwd)),   // 叠在宽容版之上
    withApproval(gate, 'file-write', createWriteToolDefinition(cwd)),
    withApproval(gate, 'mcp', ...mcpTools),
    todoTool,  // 免审
  ],
})
```

`src/agent/approval.ts`:

```ts
type ApprovalMode = 'supervised' | 'auto-edits' | 'full';
type ApprovalKind = 'command' | 'file-edit' | 'file-write' | 'mcp';
interface ApprovalRequestInfo { requestId; tool; kind; summary }

class ApprovalGate {
  mode: ApprovalMode;                       // spawn 传入,set-approval-mode 可改
  private sessionAllowed = new Set<string>(); // 「本会话总是允许」的工具名
  private pending = new Map<requestId, { resolve(d): void; info }>();
  onRequest / onResolve: 回调(supervisor 注入,负责 emit 事件)

  needsApproval(kind, tool): boolean   // full→false;auto-edits→kind 为 file-* 时 false;sessionAllowed 含 tool→false
  async ask(tool, kind, summary, signal): Promise<'allow' | 'deny'>
    // 生成 requestId,onRequest(info),挂 promise;signal.abort → settle('cancel')
    // allowSession → sessionAllowed.add(tool) 后按 allow 返回
  respond(requestId, decision)         // 渲染层决策入口
  cancelAll()                          // abort/会话终止时
  snapshot(): ApprovalRequestInfo[]    // 刷新恢复
}
```

`withApproval(gate, kind, def)`:包装 execute——`needsApproval` 为真时先 `ask`;deny/cancel 抛 `Error('User denied this operation' / 'Approval cancelled')`(pi 转 isError 工具结果,轮继续);allow 走原 execute。summary:bash 取 `params.command` 全文,file-* 取 `params.path`,mcp 取 JSON 预览(200 字符)。

## 协议扩展(shared/types/agent.ts)

- `AgentCommand` +:
  - `{ type:'approval-respond'; sessionId; requestId; decision:'allow'|'allowSession'|'deny' }`
  - `{ type:'set-approval-mode'; sessionId; mode: ApprovalMode }`
  - spawn 加 `approvalMode?: ApprovalMode`
- `AgentWorkerEvent` +:
  - `{ type:'approval-request'; sessionId; seq; request: ApprovalRequestInfo }`
  - `{ type:'approval-resolved'; sessionId; seq; requestId }`(任何 settle 路径统一发,渲染层据此删除,不乐观删)
- `SessionSnapshot` + `pendingApprovals?: ApprovalRequestInfo[]`(刷新恢复)

per-session gate 持于 ManagedSession;abort 命令与 agent_end 时不 cancelAll(审批可跨等待?)——abort 时必须 cancelAll(用户中断);会话删除/worker 退出自然消亡。

## 渲染层

- `SessionProjection.pendingApprovals: ApprovalRequestInfo[]`(reducer:approval-request 追加、approval-resolved 移除、snapshot 全量采纳、worker-exited 清空)。
- `Conversation.approvalMode?: ApprovalMode`(persist,缺省 supervised);spawn/resume 请求带上;中途切换发 set-approval-mode。
- `ApprovalBar.tsx`:composer 上方警示条(amber 边),kind 图标 + summary(`whitespace-pre max-h-24 overflow-auto` 不截断)+ 按钮 拒绝(destructive)/ 本会话总是允许 / 允许(primary)+ 右侧 1/N。只渲染队首。
- Composer:`pendingApprovals.length > 0` 时 textarea disabled,placeholder 提示先处理审批。
- `ApprovalModePicker`:composer 工具栏盾牌图标三档下拉(复用 PresetPicker 的 Popover 形态)。
- main 层 agentHost:spawnSession 透传 approvalMode;新增 approvalRespond / setApprovalMode IPC(照 setSessionThinking 模式)+ preload 暴露。

## 关键边界

- 审批等待期间 pi 的 turn 挂起(execute await),tool_execution_start 已发、工具行显示 running 转圈 + 跳表——审批时长会计入工具耗时,可接受。
- steer 在审批等待期到达:pi 的 steer 排队,不冲突(输入框已锁,一般不会发生)。
- reconcile/agent_end 不受影响(审批在 execute 内,消息流原语不变)。
