# PRD: background tasks v2(grok-build 对齐)

## 范围(调研采纳项)

1. **自动通知(核心)**:任务结束时——会话 idle → 注入合成提示唤醒 agent 继续;会话 running → 挂 pending,**下次任意工具结果顶部搭车**完成提醒。幂等抑制:模型经 task_output 阻塞等到过结束态、或自己 task_stop 且已收到回执的任务,不再通知。
2. **task_output 阻塞等待**:`timeout_ms` 参数(缺省/0=快照;>0 阻塞至完成,上限 10 分钟且上限值写进工具描述);超时文案「不需要再调,完成会自动通知」。
3. **输出双写**:内存环形 + 磁盘全量(`userData/agent/task-logs/<id>.log`);截断输出附文件路径引导 read。
4. **进程组管理**:detached spawn(setsid),kill 整个进程组;SIGTERM→超时 SIGKILL。
5. **护栏**:前台命令尾部 `&` 拒绝并引导 background=true;并发配额 10(满额先清已完成);task_stop not-found 枚举已知 id。
6. **完成文案**:id/退出码或信号/耗时/命令;用户 UI 停止的 → 「killed by the user — do not restart it」。
7. **胶囊自动关闭**(用户拍板):done 的任务 5 秒后自动从胶囊条淡出(面板开着则不收);failed 保留手动关闭(用户需看到失败)。

## 不做(记录原因)

- 前台超时自动转后台:前台命令由 pi bash 内部管理,进程无法事后移交,需完全接管 bash 实现,性价比低,列 future。
- monitor 工具:另立项。

## 验收

- 后台任务完成时 agent 空闲 → 自动被唤醒续跑;agent 忙 → 下条工具结果携带提醒;同一任务只通知一次。
- task_output(timeout_ms) 阻塞等待生效且不重复通知。
- done 胶囊 5s 自动消失。全绿 + CDP 实测。
