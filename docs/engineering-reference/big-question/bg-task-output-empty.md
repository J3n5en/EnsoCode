# 后台任务展开「输出」总是「(暂无输出)」

## 症状

任务条里的任务进程在跑、`task-logs/` 里也有输出，展开「输出」却是「(暂无输出)」：
`iproxy`、长跑的 Python 服务、刚起几分钟的 `cat > x.py <<EOF … python x.py | tail -3`。

## 根因

面板 tail 只来自 worker `BackgroundTaskManager` 内存里的 `task.output`（`snapshot` / `task-output`），与模型 `task_output` 同源，
stdout 与 stderr 都写进同一份 `run-<runId>.out`。看起来「都没输出」其实是几种不同原因叠在一起，原来都显示同一句文案：

- 优雅重启认回的任务：`recover()` 重新登记时内存缓冲为空，只从交接偏移接着读，重启前的输出只留在 `task-<id>.log`；
  `iproxy`、已就绪的服务重启后不再写，面板就一直空。
- 程序自己的块缓冲：C stdio / perl 等写文件（非 tty）时攒满约 4KB 才写出（`iproxy` 的 `.out` 恰为 24576 = 6×4096）。
  Python 已由 `hardenedEnv` 的 `PYTHONUNBUFFERED=1` 覆盖（所有本地 agent 命令，前台与后台一致）；C 程序没有通用环境变量可关，
  上 PTY 或包 `stdbuf` 都会改变命令行为，不做。
- 命令本身还没写：`… | tail -3` 要等上游 EOF；条件 `echo` 的轮询循环。

## 修法

- 认回时 `readFileTail` 只读 `task-<id>.log` 最后 64KB 种回内存，读游标推到末尾，上一代输出不重放给模型。
- `BackgroundTaskInfo.outputBytes` / `task-output.outputBytes` 带累计字节数；面板区分「加载中（还没有 worker 数据）」、
  「已输出 N 但面板没拿到」、「进程确实没写（附块缓冲提示）」。
- `FileBackedRun.readError()`：输出文件读不到时把原因写进输出，面板与 `task_output` 看到的是失败原因。

## 回归防线

- `src/agent/backgroundTasks.test.ts`「只写 stderr 的命令」
- `src/agent/backgroundTasks.restart.test.ts`（尾部接上重启前输出、大日志只读尾部、通知不重放、读不到输出文件）
- `src/agent/shell/detachedRun.test.ts`「readFileTail」「readError」
- `src/renderer/components/chat/TaskBar.test.tsx`「TailView」

## 相关代码

`src/agent/backgroundTasks.ts`（`register` 的 `appendLog`、`infoOf`、`noteReadError`）、`src/agent/shell/detachedRun.ts`（`FileTail`、`readFileTail`）、
`src/agent/shell/hardenedEnv.ts`、`src/renderer/components/chat/TaskBar.tsx`（`TailView`）
