# 执行计划：SessionSupervisor + MessagePort 通路 + 单会话对话

每步一个可独立描述的 commit（小步提交）。每步结束跑
`pnpm typecheck && pnpm lint && pnpm test`，干净才进下一步。

## 1. 依赖 + utilityProcess spike

- [ ] `pnpm add @earendil-works/pi-coding-agent`（注意 pnpm 10 的
      `onlyBuiltDependencies`，若 sdk 带原生构建脚本需登记）
- [ ] `electron.vite.config.ts` main 段加 `agent` 入口（`src/agent/index.ts`）
- [ ] spike：worker 入口先只做 echo（收到消息原样回发），Main 在启动时 fork 并
      验证往返 + `exit` 事件可收到；`pnpm dev` 与 `pnpm build` 都要过
- 回滚点：spike 走不通 → 按 design.md 的备选（独立 vite lib 构建）调整，不动后续步骤
- commit: `feat: 引入 pi sdk 与 agent worker 构建入口`

## 2. 协议类型 + 投影脱敏层（shared / agent）

- [ ] `src/shared/types/agent.ts`：`AgentCommand` / `AgentEvent`（含 per-session `seq`）/
      `SessionSnapshot` / `NodeStatus`；消息载荷用**消息级快照**（`message-updated` 携带
      完整投影消息），不做 delta
- [ ] 投影脱敏层（抄 ref-chat-b `clientMessageProjection.ts` 形状）：worker 事件出口的
      纯函数——剥离 auth / provider 原始数据 + 结构化克隆
- [ ] 收窄函数（worker/Main 两侧入口用）：脏消息返回 null 不抛
- [ ] 收窄 + 脱敏的 Vitest 用例
- commit: `feat: agent 消息协议类型与投影脱敏`

## 3. SessionSupervisor（worker 侧）

- [ ] `src/agent/supervisor.ts`：会话表、spawn（共享 ModelRuntime）、prompt、steer、
      abort、事件订阅→AgentEvent 转发
- [ ] 操作门：per-sessionId promise 链（纯函数/类抽出）
- [ ] `src/agent/index.ts`：parentPort 接线替换 echo
- [ ] 操作门的 Vitest 用例（同 id 串行、异 id 并行、链上抛错不断链）
- commit: `feat: SessionSupervisor 会话表与操作门`

## 4. AgentHost + IPC 三点式（Main）

- [ ] `src/main/services/agentHost.ts`：fork、exit→全会话 failed 广播、命令下发、
      apiKey 补全（读 settings 的 provider）
- [ ] `src/main/ipc/agent.ts`：通道常量 + handler（spawn/prompt/steer/abort）+
      事件 `webContents.send`；typeof 入参守卫
- [ ] preload 出口：`electronAPI.agent.*` + `onAgentEvent`
- [ ] 核对：事件载荷无 apiKey/auth 字段
- commit: `feat: AgentHost 与 agent IPC 通路`

## 5. Renderer：sessions store + 对话窗

- [ ] `src/renderer/stores/sessions/`：内存 store，订阅 onAgentEvent；
      `message-updated` 整体替换在流消息（无归并）；seq 守卫丢弃过期事件（纯函数抽出）
- [ ] `src/renderer/components/chat/`：模型选择（复用 settings store 的已启用
      provider/model）、消息流渲染、输入框、发送/abort、status 显示
- [ ] 挂进主窗口 `App.tsx`
- [ ] seq 守卫的 Vitest 用例
- commit 可拆两个: `feat: 会话投影 store` / `feat: 最小对话窗`

## 6. 真机验证 + 收尾

- [ ] CDP 真机走查（临时 TEMP-DEBUG 端口，验后清理）：
      - 发一句话 → 流式回复出现
      - running 时 abort → 回 idle → 再发话正常
      - `kill -9` worker → 会话标 failed、app 不崩
      - 检查 IPC 载荷确无 apiKey
- [ ] 全量 `pnpm typecheck && pnpm lint && pnpm test` + 调试残留 grep
- [ ] 更新 spec：`main/services.md`（agentHost）、新 `agent` 层说明落点、
      `renderer/state.md`（sessions store）—— 按 Phase 3.3 走
- commit: `docs: spec 补充 agent 通路` （验证中修的 bug 各自单独 commit）

## 验证命令

```bash
pnpm typecheck && pnpm lint && pnpm test
command grep -rn "TEMP-DEBUG\|remote-debugging-port\|console.log(" src/
```
