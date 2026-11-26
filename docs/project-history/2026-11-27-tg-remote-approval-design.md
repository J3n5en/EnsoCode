# Telegram 远程审批设计

目标：审批产生时推送带上下文的卡片到 Telegram，用户在手机上点按钮批准/拒绝，
决定路由回正确会话的 pending approval。高危操作必须回桌面应用审批。

> 注：初版调查基于陈旧检出，本文已按当前源码核实修正。

## 现状（已核实）

### 审批系统（src/agent/approval.ts）

- worker 侧 `ApprovalGate`：pending 按 `requestId`（`apr-<n>-<timestamp>`）键控。
  结果机 `allow | deny | revise | block | cancel | timeout | no-approver`。
- **每个审批请求已带内容感知的风险标注**（`ApprovalRequestInfo`）：
  - `protected`：`external-send | delete | payment | deploy | secret | destructive`，
    由 `classifyProtectedTool`（`src/agent/protectedActions.ts`）按**工具参数内容**分类——
    `git push` → deploy、`rm -rf` → destructive、读密钥文件 → secret、MCP 动词分类等。
    命中即「无视档位强制真人确认」（底线开启时）。
  - `mandatory`：每次都要真人（秘书插件非只读工具）。
  - `guard`：dcg 命令守卫命中详情。
  - `kind`：`command | file-edit | file-write | mcp`；`summary`：命令全文/路径/参数预览；
    `filePaths`：写目标；`expiresAt`：真人处理时限。
- 决策枚举：`allow | allowSession | deny | revise | review`（APPROVAL_DECISIONS）。
- Main 只中继：`respondApproval`（`src/main/services/agentHost.ts:2843`）→
  supervisor `gate.respond()`（`src/agent/supervisor.ts:2415`）。Main 不校验 pending，
  未知 requestId 在 worker 侧自然 no-op（gate.respond 查不到即返回）。
- 事件流：`broadcastAgentEvent`（`src/main/ipc/agent.ts:546`）是全部会话事件扇出点；
  `approval-request`（带完整 `ApprovalRequestInfo`）与 `approval-resolved`（requestId）都在其上。

### 承载通道

| 路径 | 能力 | 认证 |
| --- | --- | --- |
| 配对 PWA / remote desk | 批准、答问、steer | 配对 `contentKey` + `operate` scope |
| secretary Bot API（contact 层） | 答 ask、确认提案卡（inline keyboard 完整机制） | `admitChat`：绑定私聊，或白名单群里绑定者本人 |
| tgclient 插件（MTProto userbot） | **无法创建 inline keyboard**，出局 | — |

contact 层已有：callback 分发（`handleAction`）、`card:<c|r|o>:` 提案卡、
`admitChat` 鉴权、settle（消息改写成「✅ 已确认」）、`cardConfirm` 渠道开关（默认关）、
zh/en 文案族（`src/shared/secretary/contact.ts`）。审批现走 `approval:<slot>` 占位卡，
只有「在应用里打开」按钮（`contact/service.ts:1926` 硬编码「审批只能在应用里处理」）。
多秘书架构：每个秘书一个 ContactService 实例（`src/main/ipc/secretaryContact.ts`）。

### 安全模型

- 审批决定不走注入通道：Main 内部结构化命令，与 PWA `approval-respond` 同级，不经模型上下文。
  TRUSTED_INJECT 不相关、不动。
- `admitChat` 在 telegram.ts 层已保证 callback 只认绑定者本人。
- 通知内容量级沿用 `summary`（web push 已这么发），不额外暴露参数细节。

## 设计

### 数据形状

新增 `src/main/services/secretary/remoteApprovalBridge.ts`（纯逻辑 + 注入 ports）：

```
RemoteApproval = {
  key: string            // sha256(requestId) 前 16 hex，按钮 callback 凑进 64 字节
  requestId: string      // 完整 id，内存映射（worker 的 apr-<n>-<ts>）
  identity: SessionIdentity  // 含 generation，respondApproval 需要
  tool: string
  kind: ApprovalKind
  summary: string        // 截断
  remoteTier: 'remote' | 'desktop'
  status: 'pending' | 'settled'
}
```

注册表只在内存。重启后按旧按钮 → 查无此卡 →「已失效」。正确行为：worker 重启后
审批不会以同一 requestId 存活，hash 不会误中其他审批。

### remoteTier：复用底线分类器，宁缺毋滥

```
remoteTier(ApprovalRequestInfo):
  desktop 若 protected 非空          —— 系统级最保守判断（deploy/delete/payment/secret/destructive/external-send）
  desktop 若 mandatory === true      —— 每次都要真人
  desktop 若 guard 是 blocking 命中
  desktop 若 kind = mcp              —— 未命中 protected 的 MCP 也无法泛化判断
  desktop 若 kind = command 且 classifyProtectedCommand(summary) 非空
       —— 防线独立于 protectedFloor 开关：用户关掉底线也不放开远程批危险命令
  remote  其余（file-edit/file-write 与良性 command）
```

效果：`write`/`edit`、测试命令、`pnpm install` 可远程批；`git push`（deploy）、
`rm -rf`、发布、密钥读取、MCP 一律 desktop-only。`classifyProtectedCommand` 是 main 侧
纯函数（`src/agent/protectedActions.ts` 已是独立模块，worker/main 都可 import——实现时确认 import 路径合法性）。

### 通知侧

`broadcastAgentEvent` 扇出点挂 `remoteApprovalBridge.observe(event)`（与 maybeNotify 平级）：

```
approval-request（phase !== 'reviewing'，去重同 ApprovalNotificationGate 逻辑）：
  → key = hash(requestId)，注册 pending
  → 每个已绑定私聊的 ContactService：发卡片
     remoteTier=remote 且渠道 approvalRemote 开：按钮 [批准] [拒绝] [在应用里打开]
     否则：只有 [在应用里打开]，文案标注「必须在电脑上审批」
approval-resolved：
  → 注册表 settle → 通知所有 ContactService settle 该 key 的消息
worker-exited / parent-ended / child-ended：清注册表对应项（卡片 settle 为已失效文案）
```

- **只发绑定私聊**（`file.chat`），不推群/话题：审批内容不给群成员看。
- 多秘书：每个绑定的 ContactService 都发；settle 通过 bridge 广播，各服务 settle 自己的消息。
- 文案进 `src/shared/secretary/contact.ts` 的 zh/en 文案族。

### 回复侧

```
callback data: appr:<a|d|o>:<key>   （key 16 hex，总长 < 64 字节）
```

`handleAction` 新增分支（service.ts，在 card: 解析旁）：

1. `admitChat` 已鉴权（sender 是绑定者本人）——不新增认证逻辑；
2. service 不知道审批状态：回调经 port `resolveRemoteApproval(key, action)` 转给 bridge：
   - 无此卡 → ack「这条审批已失效」；
   - settled → ack「已在别处处理」并 settle 消息；
   - pending 但 tier=desktop 或渠道 approvalRemote 关 → ack「必须在电脑上审批」，不放行；
   - pending 且 remote → bridge 调 `respondApproval(identity, requestId, 'allow'|'deny')`
     （与桌面/PWA 同一条 `agentHost.respondApproval` 路径），注册表标 settled，
     ack「✅ 已批准/已拒绝」并 settle 消息。
3. 桥内注册表是 pending 唯一事实源：只在 pending 时放行，满足
  「不会真正发给 worker 的操作必须在乐观反馈之前拒绝」。worker 侧 gate.respond 对
   未知 id 自然 no-op 是第二道。
4. 远程批准一律 `allow`（单次），**没有 allowSession**：TG 上信息不足以做会话级授权。
5. `o`（打开）沿用现有 openInApp 深链。

文本 fallback（回复「批准」）：不做。按钮无二义性，文本关键词误触发面大。

### 替代旧占位卡

secretary 会话自己的审批不再走 `onCardWaiting` 的 approval 占位分支——
新卡片覆盖全部会话（含 secretary 会话），信息更完整。`host.ts:1057` 的 approval 分支删除，
`contact/service.ts` 的 `approval` 占位卡逻辑删除（migrate-callers-then-delete）。

### 设置

新增渠道偏好 `approvalRemote`（`contact/store.ts` PREF_KEYS，与 cardConfirm 同族）：
- **默认关**。开：卡片带批准/拒绝按钮；关：只有「在应用里打开」。
- 设置 UI：`SecretaryContactPanel.tsx` 仿 cardConfirm 加一个开关（i18n zh/en）。
- 不是 settings.json 项，不进 configCli/policy（实现时复核）。

### 不改的

- worker 审批流、桌面 UI、PWA 流、classifyProtectedTool、TRUSTED_INJECT：全部不动。
- 无新增 IPC：全部在 main 内部。renderer 只加设置面板一个开关（走现有 contact prefs IPC）。

### 测试（TDD）

1. `remoteTier` 分类单测：protected/mandatory/guard/kind 矩阵 + classifyProtectedCommand 独立防线。
2. bridge 单测：事件流注册表（request/resolved/重复/stale-seq/worker-exited 清理）、
   回调五态（无卡/settled/desktop-tier/prefs-关/pending-放行）、respondApproval 调用参数正确。
3. contact service 测试（service.test.ts 模式）：appr 回调 → port 调用；settle 改写消息；
   approvalRemote 关 → 只提醒。
4. 文案：zh/en 快照。

## 吞吐检查点

- **阻塞先行**：remoteTier + bridge（纯逻辑，TDD）先落地。
- **独立工作流**：(a) 纯逻辑层 (b) contact 层按钮/回调/settle (c) 扇出接线+设置 UI。
  共享同一数据形状，一个 owner 顺序做，接口即数据形状本身。
- **共享可变状态**：bridge 注册表唯一事实源；ContactService 只存 key→消息映射，不复制审批状态。
- **最小分解**：单 owner，约 900-1300 行 diff，三层各自带测试、顺序提交。

## 开放决策（已按设计定案，实现遵循）

1. `approvalRemote` 默认关 ✔
2. 审批卡片只发私聊 ✔
3. `git push` 属 deploy → desktop-only（系统分类器已定调，不放松） ✔
4. 远程只有单次 allow/deny，无 allowSession ✔
5. 多秘书：全部绑定服务都收到卡片，先按先赢 ✔
