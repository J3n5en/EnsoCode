# PRD: 后台任务(bash background + 任务胶囊)

父任务: 08-26-bg-tasks-subagent

## 需求

1. **工具能力**(worker):
   - bash 工具加 `background?: boolean` 参数:后台任务立即返回 taskId,命令 detach 运行,输出累积在 worker 内(环形缓冲,上限 ~200KB);
   - 新工具 `task_output(taskId)`:agent 查询当前输出与状态;`task_stop(taskId)`:终止;
   - 任务结束(exit)时经事件流告知渲染层;会话 abort 不杀后台任务(独立生命周期),会话删除/worker 退出时全部终止。
2. **事件与状态**(渲染层):
   - per 会话 `backgroundTasks: { taskId, command, status: running|done|failed, output(尾部), startedAt, exitCode? }`;
   - worker 事件:task-started / task-output(增量,节流 ≤4Hz)/ task-ended;snapshot 带全量(刷新恢复)。
3. **TaskBar 胶囊条**(父任务 PRD 的设计):时间线顶部居中悬浮;有任务时出现;胶囊=Terminal 图标+命令截断+状态点;点击展开输出面板(尾部流式、等宽、自动滚底、停止按钮)。
4. bash 工具 description 更新引导模型:长驻命令(dev server/watch)用 background。

## 验收

- 「后台启动 python -m http.server 后告诉我」→ 轮立刻继续;胶囊出现且输出流动;点击见输出;task_stop/面板停止按钮可终止;刷新后胶囊仍在。
