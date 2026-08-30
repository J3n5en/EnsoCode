# Move to worktree 的三重竞态（会话换 cwd 重生的完整坑单）

> 来源：08-30-worktree-isolation 任务，CDP 真机排障。单元测试全绿的情况下，
> 端到端连续踩了三个独立的坑才让「迁移后写文件落在 worktree」成立。
> 凡是「杀掉 worker 会话 → 换参数重新 spawn」的功能（fork、换 cwd、换运行时）都会撞。

## 坑 1：新增 AgentCommand 必须同步改 parseAgentCommand 白名单

worker 入口对 main→worker 命令做 shape 白名单校验（`src/shared/types/agent.ts`
`parseAgentCommand`），漏加的命令被**静默丢弃**，只在 stdout 打一行
`[agent] dropped unparsable command: <type>`。类型系统不会提醒你——`AgentCommand`
联合类型加了新成员，parser 的 switch 缺 case 不报错。

**规矩**：加命令三件套 = 联合类型 + parseAgentCommand case + 回归测试（agent.test.ts）。

## 坑 2：post 型 IPC 的「ok」不等于「做完了」

`sendAgentCommand` 只是 postMessage，返回 ok 不代表 worker 执行完。
release-parent（销毁会话）后紧跟 spawn-parent（新 cwd 重生）时，spawn 可能在
release 完成前到达：supervisor 的 spawn 对「已存在且同 generation」的会话走
**短路复用分支**（不打 [spawn] 日志！），旧 cwd 的会话继续活着，新 cwd 永不生效。

**修法**：需要顺序语义的命令在 main 侧等确认事件回流（AGENT_RELEASE 等
parent-ended，带超时兜底），再返回 IPC。

## 坑 3：`spawning` 不能当互斥门用——worker 事件会清它

renderer 想用 `spawning: true` 挡住 ChatView 的自动 resume，但 sessions store
的事件处理会在 worker 事件（含 release 触发的 parent-ended）到达时把 spawning
清掉，守卫在最需要它的窗口期失效。auto-resume 趁 worktree 尚未登记，用旧 cwd
把会话复活。

**修法**：互斥门用专职字段（`workspaceMigrating`），只由迁移动作本身设置/清除，
不与任何事件驱动的运行态字段复用。

## 治本原则：路径类授权/决策收口到 main

renderer 的状态永远可能陈旧（HMR、事件竞态、多入口 resume）。cwd 这类安全敏感
参数不要依赖 renderer 传对：main 在 AGENT_SPAWN 里按 worktree registry
**无条件覆写** cwd，整类「陈旧 cwd 抢跑」从有害降级为无害。

## 排障手段备忘

- supervisor `[spawn]` 日志带 cwd 是定位关键（本次顺手加上了，别删）。
- CDP 包 store action 记 trace（`store.setState({ action: wrapped })`）可拿到
  精确到 ms 的竞态时序，比猜快得多。
