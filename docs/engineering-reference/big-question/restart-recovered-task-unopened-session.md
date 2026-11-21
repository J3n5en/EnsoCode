# 重启后后台任务还在跑，界面却看不到

## 症状

菜单「重启」（优雅重启）前会话里挂着转后台的命令。新实例起来后点开该会话：进程仍在、日志还在写，
但输入框上方没有任务条，侧栏也没有「活跃中」。随便发一句话后任务条才出现。单测全绿。

## 根因

症状在渲染层，根因在 worker 只给「已打开」的会话发事件：

- 新 worker 构造时 `bgTasks.recover()` 把上一代交出的命令认回进 `BackgroundTaskManager`，
  `announce` → `onStarted` / `onLevel` 回调里 `this.sessions.get(sessionId)` 为空（会话没 spawn），事件被丢掉；
  之后的 `onOutput` 同理。Main 的 `backgroundTaskStates` 也就没有这份投影。
- 空闲根会话按 `await-user` 写进恢复清单，冷启动不续跑也不打开；渲染层点开冷会话只经
  `AGENT_PARENT_HISTORY_TAIL` 读 jsonl 尾窗，`requestSnapshot(id)` 对没打开的会话回空，不会 spawn。
- 只有发消息触发 `spawn-parent(resumeFile)` 时，resume 快照才带上 `backgroundTasks`。

## 修法

worker 对没打开会话的任务变化发无 identity 的 `unopened-background-tasks`（全量、REPLACE）；
`snapshot` 命令（渲染层启动全量拉、点开冷会话按 id 拉）对没打开且有任务的会话补发同一事件。
渲染层只替换 `backgroundTasks`，不领养 generation、不动 seq、不置 started；Main 的 tracker 同样按全量替换。

## 回归防线

- `src/agent/supervisor.gracefulRestart.test.ts`「认回任务所在会话没打开也下发给渲染层」
- `src/renderer/stores/sessions/reducer.test.ts`、`restart.test.ts`（冷会话收到事件不 spawn）
- `src/main/services/backgroundTaskTracker.test.ts`

## 相关代码

`src/agent/supervisor.ts`（`emitUnopenedTasks`、`snapshot` 命令）、`src/agent/backgroundTasks.ts`（`recover`）、
`src/renderer/stores/sessions/index.ts`（`onEvent`）
