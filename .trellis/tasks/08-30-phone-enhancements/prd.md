# 移动端增强：spawn 推理档位 / 子任务输出查看 / Web Push 通知

## 背景

手机 PWA（packages/phone）已具备会话查看、发消息、审批能力，但三处体验缺口：

1. 新建会话只能选项目/服务/模型/审批模式，推理开关与档位只能建完后在会话设置里补调。
2. subagent / coworker / 后台任务的事件下行链路已通（pairPolicy 已放行
   `subagent-update` / `coworker-update` / `task-*`，snapshot 的 `subagents` /
   `backgroundTasks` 字段随裁剪透传），但手机端 client 不消费、UI 不渲染；
   coworker 子会话（catalog 中带 parentId）被抽屉过滤掉，无法查看。
3. 无任何通知：审批请求 / 回合完成时，手机切后台或锁屏无感知。

## 方案决策

- 通知选 **Web Push（桌面 main 直发）**：Electron main 用 `web-push` 库直接调
  浏览器厂商推送服务，relay 零改动。手机 PushSubscription 经加密 pair 信道上行，
  VAPID 公钥经下行帧发放。推送载荷只含通用文案 + sessionId，不含消息内容
  （推送途经 Apple/Google 服务器，保持 E2E 姿态）。
- 实施顺序 ① → ② → ③，各自独立小步提交。

## 需求

### ① 新建会话设置推理强度（纯 UI 补齐）

- `NewSessionSheet` 增加「推理」开关 + 推理档位 Select（low/medium/high/max），
  交互与 `SessionConfigSheet` 一致（开关关闭时隐藏档位）。
- `NewSessionRequest` 增加 `reasoningEnabled?` / `thinkingLevel?`；App 的
  `onCreate` 已 `...req` 展开，spawn 命令自动带上（协议与 pairHost 已支持）。
- 加固：`pairPolicy.parsePhoneCommand` 的 spawn 分支校验
  `reasoningEnabled`（boolean）与 `thinkingLevel`（枚举），非法即拒（TDD）。

### ② 查看 subagent / coworker / 后台任务输出

- `client.ts`：`SessionView` 增加 `tasks: BackgroundTaskInfo[]`、
  `subagents: SubagentInfo[]`；`applyAgentEvent` 处理
  `subagent-update` / `task-started` / `task-output` / `task-ended`（对齐桌面
  reducer 语义：按 id 覆盖式 upsert / tail 覆盖），snapshot 分支并入两字段。
  纯逻辑，测试先行。
- `ChatScreen`：Composer 上方复用桌面 `TaskBar`（stub 的 `agent.stopTask`
  已降级返回失败，手机端不提供停止）。
- `SessionDrawer`：coworker 子会话嵌套显示在父会话下（缩进 + 名称），
  点击即切换订阅查看完整输出（订阅链路已支持子会话 id）。
- 本期不做：手机端停止后台任务（需新增上行帧，另立任务）。

### ③ Web Push 通知

- 协议（packages/pair/protocol.ts）：
  - 上行 `push-subscribe { subscription: { endpoint, keys: { p256dh, auth } } }`、
    `push-unsubscribe`；加入 `PHONE_COMMAND_TYPES`。
  - 下行 `push-config { vapidPublicKey: string }`（host-online 后随
    appearance 一并下发）。
- main：
  - `pairPolicy`：两个新命令结构校验（endpoint 必须 https，keys 必填）（TDD）。
  - 新 `pushNotifier.ts`：VAPID 密钥对首次生成并持久化（pairStore 同级）；
    存/清 subscription；发送封装（web-push），410/404 自动清订阅（TDD）。
  - `pairHost`：手机不在线（guest 离线）时，`approval-request` / `ask-request` /
    `turn-completed` / `turn-failed` 触发推送；解绑时清订阅。
  - 根 package.json 加 `web-push`。
- phone：
  - Service Worker：`push` → `showNotification`（标题按事件类型，正文=会话标题）；
    `notificationclick` → 聚焦已开窗口或打开 `/#session=<id>` 定位会话。
  - 订阅逻辑：收到 `push-config` 且用户开启通知后注册 SW + `pushManager.subscribe`
    + 上行 subscription；权限被拒/不支持时降级提示。
  - `SessionDrawer` 增加「通知」开关行；iOS 非 standalone 时提示先「添加到主屏幕」。

## 验收标准

1. 手机新建会话可直接选推理开关+档位，创建的会话在桌面端回显一致的档位。
2. 会话内 agent 派发 subagent / coworker / 后台任务时，手机输入框上方出现
   状态胶囊，可展开查看输出尾部 / 最终产出；coworker 可从抽屉进入查看完整对话。
3. 手机锁屏/切后台时，桌面端产生审批请求或回合完成，手机收到系统推送，
   点击进入对应会话（iOS 需安装为 PWA）。
4. `pnpm typecheck && pnpm test` 通过，`biome check` 干净；新逻辑
   （pairPolicy 校验、client 事件投影、pushNotifier）均有先行测试。

## 非目标

- 手机端停止/发起后台任务与 subagent。
- 推送携带消息正文（隐私考量，只发通用文案）。
- relay 改动。
