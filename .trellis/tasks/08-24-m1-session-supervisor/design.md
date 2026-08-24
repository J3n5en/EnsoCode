# 技术设计：SessionSupervisor + MessagePort 通路 + 单会话对话

## 进程拓扑

```
Renderer（对话窗）
   │  既有 IPC 三点式（invoke + 事件推送）
Main（AgentHost：worker 生命周期 + 消息中转 + apiKey 补全）
   │  utilityProcess.fork + postMessage
agent worker（utilityProcess，故障域 A）
   └─ SessionSupervisor: Map<id, AgentSession>
```

- **Renderer 不直连 worker。** 后续权限门、多窗口广播都需要 Main 在场；
  M1 就固定这个形状，不做「先直连后重构」。
- worker 只有一个（故障域 A，M0 已实测）。退出/崩溃由 Main 监听 `exit` 事件，
  把全部活会话广播为 `failed`；**本刀不自动重启**，用户手动重开会话。

## 模块边界

| 位置 | 模块 | 职责 |
|---|---|---|
| `src/shared/types/agent.ts` | 协议类型 | `AgentCommand` / `AgentEvent` union、`SessionSnapshot`、`NodeStatus` |
| `src/agent/index.ts` | worker 入口 | 接线：process.parentPort ↔ supervisor |
| `src/agent/supervisor.ts` | SessionSupervisor | 会话表、spawn/prompt/steer/abort、事件转发、操作门 |
| `src/main/services/agentHost.ts` | AgentHost | fork/exit 监听、命令下发、事件上抛、apiKey 补全 |
| `src/main/ipc/agent.ts` | IPC handler | Renderer 命令入口 + `webContents.send` 事件推送 |
| `src/preload/`（既有出口追加） | electronAPI.agent | invoke 封装 + `onAgentEvent` 订阅 |
| `src/renderer/stores/sessions/` | 投影 store | 内存态（不 persist）：会话列表、消息增量归并、status |
| `src/renderer/components/chat/` | 对话窗 | 模型选择、消息流、输入框、abort 按钮 |

`src/agent/` 是新顶层目录：它既不是 main 也不是 renderer，与 shared 平级，
只允许 import `@shared` 与 pi sdk。

## 构建：utilityProcess 入口

electron-vite 的 `main` 段支持多入口。给 `main.build.rollupOptions.input` 加
`agent: src/agent/index.ts`，产出 `out/main/agent.js`；Main 侧
`utilityProcess.fork(path.join(__dirname, 'agent.js'))`。
`externalizeDeps` 保持 —— pi sdk 从 node_modules 加载（M0 验证项 1 的通过形态）。

风险：electron-vite 对 main 多入口的 dev 模式热重载行为未验证 —— implement 第 1 步
先做 fork + echo 的 spike，走不通的备选是把 agent 入口放进独立的 vite lib 构建。

## 消息协议（会话级增量 + 消息级快照）

ref-chat-b 参照（`runtime/dispatch.ts` 的 `flushBlocksToRenderer`、renderer `stores/ui/stream.ts`）：
流式投影**不是 delta 归并**——每次推「当前正在流的那条消息的完整内容」，renderer 整体替换。
会话间是增量（只推在流的消息），消息内是全量。pi 的 `message_update` 事件恰好携带完整
消息对象，直接照搬这个形状。收益：renderer 无归并 reducer，天然免疫乱序与丢事件。

```ts
// Main → worker
type AgentCommand =
  | { type: 'spawn'; sessionId: string; cwd: string; model: ModelRef; auth: AuthPayload }
  | { type: 'prompt'; sessionId: string; text: string }
  | { type: 'steer'; sessionId: string; text: string }
  | { type: 'abort'; sessionId: string }
  | { type: 'snapshot' }

// worker → Main（Renderer 收到的与此同形，Main 只过滤不改写）
// 每个事件带 per-session 单调递增 seq，store 丢弃 seq 过期的事件（重连/多窗口的最小防护）
type AgentEvent =
  | { type: 'status'; sessionId: string; seq: number; status: NodeStatus; error?: string }
  | { type: 'message-updated'; sessionId: string; seq: number; message: ProjectedMessage }
  | { type: 'turn-completed' | 'turn-failed'; sessionId: string; seq: number; error?: string }
  | { type: 'snapshot'; sessions: SessionSnapshot[] }
```

- 未决 #7 落定为**增量事件**（会话粒度）；`snapshot` 仅用于调试与重连补投影。
- `ProjectedMessage` 以 pi 的消息类型为基底，经**投影脱敏层**（见下）产出，不自造再映射。
- **投影脱敏层**（抄 ref-chat-b `clientMessageProjection.ts` 的形状）：worker 事件出口统一过
  一个纯函数模块——剥离不该出 worker 的字段（auth、provider 原始回放数据）+ 结构化克隆。
  纯函数，直接可测。
- **auth 不回流**：`spawn` 携带的 apiKey 只进 worker；`AgentEvent` 类型层面不给 auth 位置，
  投影层再兜一道。

## SessionSupervisor 内部

- `spawn`：`createAgentSession()` + 绑事件订阅 + 登记 Map。共享一个 ModelRuntime
  （M0 验证项 2：共享与分建都通过，选共享，简单）。
- 操作门：`Map<sessionId, Promise<void>>` 的 promise 链 —— spawn/prompt/abort
  对同一会话串行；不同会话互不影响。这是 §2 决策 7 的雏形，删除门 M3 再补。
- 事件订阅在 spawn 时绑定一次（设计文档 §6 陷阱 3：这是创建时的事，与 Runtime 重绑无关）。
- abort 语义：终止当前 turn，会话保留可继续 prompt；出错则 `failed` + error 文案。

## provider → pi 的映射

`ModelApiKind` 的值域已对齐 pi sdk 的 `Api`（`src/shared/types/llm.ts` 注释即为此设计）。
Main 侧从 settings 取已启用 provider/model，组装 `{ api, baseUrl, modelId, apiKey }` 下发。
Renderer 发起 spawn 时只传 `providerId + modelId`，apiKey 由 AgentHost 在 Main 补全。

## 数据流示例（一次对话）

1. Renderer：选模型点发送 → `invoke('agent:spawn', { providerId, modelId, cwd })`
2. Main handler → AgentHost 补 apiKey → worker `spawn` → supervisor 建会话 → `status: idle`
3. Renderer `invoke('agent:prompt', { sessionId, text })` → worker → `session.prompt()`
4. pi 事件流 → supervisor 转 `AgentEvent` → Main → `webContents.send('agent:event')` → store 归并
5. abort 按钮 → `invoke('agent:abort')` → `session.abort()` → `status: idle`

## 测试面

worker 与 Electron 强耦合的部分不测（testing.md 的既定边界）。可测的纯逻辑：

- 协议消息的构造/收窄函数（脏输入不崩）
- 投影脱敏层：给定含敏感字段的消息，产出无 auth / 无原始回放数据
- seq 守卫：store 对过期 seq 的丢弃逻辑（纯函数抽出）
- 操作门：同 id 串行、异 id 并行（纯 Promise 逻辑，无 Electron 依赖）

## 取舍记录

- **不重启 worker**：自动重启牵出 jsonl 恢复与投影重建，是独立一刀（设计文档 §2 决策 6）。
- **不引入 MessageChannelMain 直连 Renderer**：省一跳的收益 < Main 在场的必要性。
- **共享 ModelRuntime**：M0 两种都通过，选简单的；出问题的回退路径是 per-session。
- **消息投影用快照不用 delta**：ref-chat-b 生产验证的形状；renderer 免归并、免乱序处理。
- **不抄 ref-chat-b 的 requestId/epoch 竞态防护群**：那是分页列表 + 多入口 hydrate 的
  复杂度，M1 没有这些入口；只留 seq 单调守卫这一个最小防护。
