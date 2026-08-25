# Design: Subagent

## worker

`src/agent/subagent.ts` — `createTaskTool(deps)`:

- `task(description, prompt)` 工具(promptSnippet 引导:独立子任务委派给 subagent,可并行,隔离上下文)。
- execute:同 worker `createAgentSession` 开子会话:
  - 复用父的 runtime/piModel(克隆)/cwd/agentDir/thinkingLevel;
  - **共享父的 ApprovalGate**(supervised 下子代理的 bash/edit 同样弹审批,审批条在父会话 UI);
  - 子会话 customTools = 父组装的同套(read/bash+bg/edit/write/MCP)**但不含 task(防递归)与 todo**;
  - `SessionManager.create(cwd, sessionDir)` 落盘(可追溯);
  - subscribe 子会话事件:assistant message_start → steps++;tool_execution_start → currentActivity=工具名+摘要;节流(500ms)emit `subagent-update`;
  - 父 abort → execute 的 signal → 子 session.abort();
  - 完成:取子会话最后 assistant 文本作为工具结果;status done/failed。

deps 由 supervisor spawn 闭包提供(makeSubSession 工厂 + emitUpdate)。

## 协议

- `SubagentInfo { id, description, status: running|done|failed, steps, currentActivity, resultText?, startedAt }`
- 事件 `{ type:'subagent-update'; sessionId; seq; agent: SubagentInfo }`(覆盖式,按 id 幂等 upsert)
- `SessionSnapshot.subagents?: SubagentInfo[]`(worker 侧 per-parent 记录存 ManagedSession)

## 渲染

- `SessionProjection.subagents: SubagentInfo[]`(reducer upsert by id;snapshot 采纳;worker-exited running→failed)。
- TaskBar 扩展:subagent 行(Bot 图标 + description + steps·时长 + 状态点);「查看」浮层:currentActivity(running)/ resultText markdown(done);done 5s 自动收起同后台任务。

## 不做(v1)

- 单独停止某个子代理(abort 父即全部);子会话完整时间线查看器(落盘 jsonl 未来可导入查看);自定义 agent 类型(scout/planner 等,固定 general)。
