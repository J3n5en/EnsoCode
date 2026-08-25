# PRD: Subagent(task 工具 + 子会话 + 胶囊详情)

父任务: 08-26-bg-tasks-subagent
前置: 08-26-background-tasks(胶囊条与事件通道复用)

## 需求

1. **task 工具**(worker):父会话注册 `task(description, prompt)` 工具;执行 = 同 worker 内 `createAgentSession` 开子会话(共享 ModelRuntime 与 MCP 连接池,继承父的模型与审批档位),prompt 跑完后把子会话最终文本作为工具结果返回父会话。
   - 支持并行多个 task 调用;
   - 父会话 abort → 子会话全部 abort;
   - 子会话不落自己的持久会话记录(或落独立 jsonl 供二级查看,design 定)。
2. **进度透出**:子会话的事件(当前工具/步数/最新文本摘要)经事件流转发,渲染层 per 会话 `subagents: { id, description, status, currentActivity, steps }`。
3. **胶囊接入**:TaskBar 上子代理胶囊(Bot 图标+description 截断+状态点);点击展开详情面板:进度(N 步 · 当前动作)+ 最新输出摘要;完成后显示最终产出(markdown)。
4. pi 官方 subagent 示例(spawn pi CLI 子进程)不采用——同 worker 子会话零进程开销且复用连接。

## 验收

- 「用两个子代理分别调研 A 和 B 然后汇总」→ 两个胶囊并行出现、进度流动;点击见各自详情;完成后父会话汇总;abort 联动。
