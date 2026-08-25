# Design: 后台任务

## worker 侧

`src/agent/backgroundTasks.ts`:

```ts
interface BackgroundTask {
  taskId; command; child: ChildProcess;
  output: string;           // 环形截尾,上限 200KB
  status: 'running'|'done'|'failed';
  exitCode?: number; startedAt: number;
}
class BackgroundTaskManager {
  // per supervisor 单例,任务按 sessionId 归属
  start(sessionId, command, cwd): taskId      // spawn(command,{shell:true,cwd,detached:false})
  output(sessionId, taskId): { status, output }   // task_output 工具用
  stop(sessionId, taskId): boolean
  stopSession(sessionId) / stopAll()
  snapshot(sessionId): BackgroundTaskInfo[]
  onEvent 回调 → supervisor emit(task-started/task-output/task-ended)
}
```

- 输出节流:stdout/stderr 累积,500ms 定时把**尾部快照**(≤8KB)以 `task-output {taskId, tail}` 覆盖式下发(幂等,无需增量拼接);无新输出不发。
- 会话 abort **不杀**后台任务(dev server 场景);会话被删/worker 退出时终止(shutdown 钩子)。

## 工具

- bash 包装 `withBackground`(叠在审批门**内层**——审批先问,批准后才判断 background):
  - schema 加 `background?: boolean`(描述引导:dev server/watch 等长驻命令用);
  - `background=true`:manager.start 后立即返回 `Started background task <taskId> — use task_output to check.`;
  - 否则走原 execute。
- `task_output(taskId)` / `task_stop(taskId)`:免审 custom 工具,读/停 manager。

## 协议

- `AgentWorkerEvent` +
  - `{ type:'task-started'; sessionId; seq; task: BackgroundTaskInfo }`
  - `{ type:'task-output'; sessionId; seq; taskId; tail; status }`
  - `{ type:'task-ended'; sessionId; seq; taskId; status; exitCode? }`
- `BackgroundTaskInfo = { taskId, command, status, tail, startedAt, exitCode? }`
- `SessionSnapshot.backgroundTasks?: BackgroundTaskInfo[]`

## 渲染层

- `SessionProjection.backgroundTasks: BackgroundTaskInfo[]`(reducer 归并;snapshot 采纳;worker-exited 全标 failed)。
- `TaskBar.tsx`:MessageTimeline 内 `absolute top-2 left-1/2 -translate-x-1/2 z-20`;药丸容器(EnsoAI 视觉:`rounded-full border bg-background/80 px-2 py-1.5 shadow-lg backdrop-blur-sm`);有任务才渲染。胶囊:Terminal 图标 + 命令截断(max-w-40 truncate)+ 状态点(running 绿脉冲/done 蓝/failed 红)。
- 点击胶囊 → 下方展开 `TaskDetailPanel`(absolute 面板):命令全文、输出尾部(`font-mono text-xs whitespace-pre-wrap` 自动滚底)、运行时长、停止按钮(IPC task_stop?渲染层直接发 worker 命令 `task-stop`)。
- `AgentCommand` + `{ type:'task-stop'; sessionId; taskId }`(渲染层停止按钮用);preload/IPC 照 abort 模式。
- done/failed 的任务:面板可查看;胶囊「已读」后(面板打开过)从条上淡出?v1 简化:done/failed 保留在条上,提供胶囊上的关闭(X)手动清除(渲染层本地 dismiss,不动 worker)。
