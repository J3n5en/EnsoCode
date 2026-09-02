# 桌面端连接远程 EnsoCode 节点

## Goal

让一台 EnsoCode 桌面（A）像手机 PWA 一样，连到另一台运行中的 EnsoCode 桌面（B），在 A 上浏览、操控 B 的会话：列表、聊天、新建会话、审批/提问应答、模型切换。agent、模型凭据、skills、会话历史全部留在 B。对齐 Multica「一处操控、多机执行」的多机模型，但复用现有 pair 中继架构，不新增服务端与账号体系。

## Background / 已确认事实

### 现有两种「远程」语义不同
- **SSH 项目**（`kind:'ssh'`，设置 → SSH，`src/main/services/sshConnectionStore.ts`）：agent 在本机跑，只有工具（read/bash/edit…）经 `SshExecutor` 到远端执行；LLM 调用、历史、skills 都在本机。
- **手机第二屏**（`src/main/services/pairHost.ts` + `packages/relay` + `packages/phone`）：agent 在桌面跑，手机只是远程 UI。本任务给桌面补的正是这个方向的 guest 角色。

### 可直接复用的积木
- `@enso/pair`（`packages/pair/src`）：握手 `startHostPairing`/`pollHostPairing`/`claimPairing`（纯 HTTP，无需摄像头）、`sealFrame`/`openFrame`、`attachHeartbeat`、`backoffDelay`、`PairedDevice`、`parsePairUri`（兼容 `enso://` 与 https 链接）。与 guest 是手机还是电脑无关。
- relay `packages/relay/src/room.ts`：房间只有 `host`/`guest` 两个 tag；同角色新连接顶替旧连接（`room.ts:108-113`）→ **一个 pairId 只能有一个 guest 在线**，每台连接方需单独配对（手机侧已如此：`packages/phone/src/deviceList.ts`）。加密载荷对中继透明，扩协议不需要重新部署中继。
- 协议 `packages/pair/src/protocol.ts`：上行 `PhoneToHost` 白名单（prompt/steer/abort/approval-respond/ask-respond/snapshot/subscribe/spawn/set-model/set-reasoning/set-thinking/history/push-*/presence）；下行 `HostToPhone`（catalog/projects/providers/appearance/agent-event/push-config/history）。手机 `client.ts` 的 switch 无 default，未知下行帧被忽略 → 加新帧类型对旧 PWA 向后兼容。
- guest 端投影逻辑：`packages/phone/src/client.ts` 的 `applyAgentEvent`（snapshot 合并 / message-upsert / status / approvals / asks）+ 纯函数 `syncProjection.ts`、`taskProjection.ts`。目前与 WebSocket 传输耦在一个类里。
- host 侧 `pairHost.ts`：每设备一条 WSS；`handleFrame` 解密 → `pairPolicy.parsePhoneCommand` → `PairAgentBridge`；`forwardAgentEvent` 按订阅裁剪；`updatePairCatalog` 接收 renderer 经 `PAIR_CATALOG` 推的目录（`src/renderer/stores/pairCatalog.ts`）；`sendMeta` 在进房/目录更新时下发 catalog/projects/providers/appearance/push-config。
- 手机 PWA 复用桌面 `src/renderer/components/chat/*`（MessageTimeline/Composer/ApprovalBar/AskBar/TaskBar/RetryBar），经 `packages/phone/vite.config.ts` alias 把 `@/stores/sessions`、`@/stores/settings`、`@/i18n` 换成 stubs。说明聊天组件与 store 之间已存在可替换边界；但在桌面 A 上 store 是真的：`TimelineRow.tsx:563-611` 的 `RewindButton`/`RetryButton` 与 `:1084` 的 `RunningElapsed` 直接读 `useSessionsStore` 的本机 active 会话，远程视图若不隔离会把回退/重试打到本机会话上。
- 凭据存储 `src/main/services/pairStore.ts`：safeStorage 加密整包 + 原子 rename；`isSecureStorageAvailable()` 不可用时 UI 提示。

### 桌面端缺的
- 只有 host 角色实现，没有 guest 角色。
- `useSessionsStore`（`src/renderer/stores/sessions/index.ts`，1916 行）所有命令直打 `window.electronAPI.agent.*` → 本机 agentHost，无「节点」维度。
- 设置页「手机」（`PhoneSettings.tsx`）只能出码，不能粘码去连别人。
- 协议里 host 从不下发自己的主机名（`PairedDevice.deviceName` 是 guest 自报的名字，手机侧只能叫「电脑 N」）。

### 协议能力边界（首版 = 手机能力上限）
协议不含：rewind、retry、worktree、pin/archive/rename/delete 会话、coworker 雇佣/解散、Files/Changes/Terminal 面板、设置读写、set-approval-mode、@ 文件/会话提及、slash 命令。远程节点视图首版不提供这些，且**不显示灰掉的入口**。

## Decisions

- **D1 呈现形态 = 节点切换（非融合分组）**：侧栏顶部增加节点切换器 `本机 | <节点…> | + 连接节点`。切到远程节点后侧栏与聊天区整体换成该节点的目录与会话，由独立的 `RemoteNodeView` 承担。本机 `useSessionsStore` 不加节点维度。融合分组留作后续迭代（依赖本任务的 guest 连接层）。
- **D2 命名与入口**：远程 EnsoCode 称「节点」；SSH 仍称「SSH」（远程目录，非远程 agent）；手机仍称「手机」。设置页「手机」改为「设备」，分两栏：「允许连入」（现有出码 + 已配对设备列表，手机/电脑一并显示）与「连接到节点」（粘贴配对链接 + 已连节点列表：在线状态/重命名/解绑）。节点切换器里的 `+ 连接节点` 直接弹粘码对话框，成功后立即切到该节点。设置页可适度重构。
- **D3 guest 传输与密钥留在 main**：与 `pairHost` 对称，新建 `pairGuest` 服务在 main 持有 WSS、加解密与凭据（safeStorage）；renderer 经 IPC 收明文 `HostToPhone` 载荷、发 `PhoneToHost` 命令。contentKey 不进 renderer；连接不随窗口刷新断开。
- **D4 投影逻辑抽成共享纯函数**：把 `client.ts` 的 `applyAgentEvent` 抽到 `src/shared/pair/guestProjection.ts`（phone 经 `@shared` alias 复用，桌面 renderer 直接引），phone 的 `client.ts` 只剩传输。不复制第二份。
- **D5 节点显示名**：协议新增下行帧 `host-info { hostname, appVersion }`（加密载荷，中继无感；旧 PWA 忽略）。A 侧默认标签 = 对方 hostname，可重命名。桌面作为 guest 去 claim 时 `deviceName` 用本机 `os.hostname()`，B 的设备列表因此能区分手机与电脑。
- **D6 存储隔离**：节点凭据存 `remote-nodes.bin`，与 `phone-pairing.bin` 分开——两者角色相反，混存会让 host 侧误以 host 身份连别人的房间。
- **D7 远程视图与本机 store 隔离**：新增 `ChatHostContext`（sessionId + 能力开关），`ChatView` 提供本机值、`RemoteNodeView` 提供远程值；`TimelineRow` 的 RewindButton/RetryButton 按能力开关隐藏，`RunningElapsed` 的计时 key 用 context 的 sessionId。phone 不受影响（stubs 已隔离）。

## Requirements

- **R1 节点凭据与连接（main）**：`nodeStore.ts`（仿 `pairStore.ts`：safeStorage 加密、原子写、`label` 字段）；`pairGuest.ts`：每节点一条 `role=guest` WSS、心跳、退避重连、`powerMonitor.resume` 探活、1008/`revoked` → 清凭据并通知；解密后的 `HostToPhone` 原样经 IPC 推 renderer；`appearance`/`push-config` 帧丢弃（A 保留自己的主题，桌面无 Web Push）。
- **R2 配对（main + UI）**：粘贴配对链接（`parsePairUri`）→ `claimPairing(relay, pk, os.hostname())` → 存凭据 → 立即连接。失败给可读错误（链接格式错 / 已过期 / 中继不可达）。解绑走 `revokePairing` 并清本地。
- **R3 IPC/preload**：`NODE_LIST`、`NODE_PAIR`、`NODE_REMOVE`、`NODE_RENAME`、`NODE_SEND`、`NODE_STATUS_CHANGED`（main→renderer）、`NODE_MESSAGE`（main→renderer，`{ nodeId, payload }`）。入参按 unknown 校验；`NODE_SEND` 只放行 `PHONE_COMMAND_TYPES` 且拒绝 `push-*`。结果对象不抛异常。
- **R4 共享投影**：`src/shared/pair/guestProjection.ts` 导出纯函数 `applyHostEvent(view, event)`/`applySnapshotEvent(...)`，行为与现有 `client.ts` 完全一致（snapshot 尾窗接续规则、worker-exited → failed、approvals/asks 增删、retry/task 投影）。phone `client.ts` 改为调用它。
- **R5 renderer 节点 store**：`stores/remoteNodes.ts`（zustand）：节点列表与连接状态、`activeNodeId: 'local' | nodeId`、每节点 catalog/pinnedOrder/projects/providers/hostInfo、每会话 `SessionView`、订阅会话与游标（localStorage 按 nodeId+sessionId）、`syncing` 状态、幽灵会话处理。切节点时清空上一节点视图。
- **R6 节点切换器**：侧栏顶部 `NodeSwitcher`：本机 + 已连节点（带在线/离线点）+ `+ 连接节点`。切到远程后 `App.tsx` 用 `RemoteNodeView` 替换 `Sidebar + ChatView + SidePanel`（右侧面板首版对远程不可用，隐藏）。
- **R7 RemoteNodeView**：左栏 = 该节点项目分组的会话列表（置顶/归档/活跃分栏，排序与手机 `drawerOrder.ts` 同语义，仅可选择，无右键操作）+「新建会话」；右侧 = 复用 MessageTimeline/Composer/ApprovalBar/AskBar/TaskBar/RetryBar 的聊天区，顶部显示节点名 + 连接状态横幅（连接中/对方离线/同步中）。Composer：`commands={[]}`、无 cwd、无 chatCandidates、`enterToSend` 默认；模型/推理切换用 `ModelPicker` 级联的 provider/model 部分（数据源为节点下发的 providers）；上滑加载更早历史。
- **R8 新建远程会话**：对话框选项目 / provider+model / 审批模式 / 推理档位，发 `spawn`，sessionId 本地生成，`fresh` 订阅规则同手机。
- **R9 设置页「设备」**：`DevicesSettings.tsx` 取代 `PhoneSettings.tsx`（分类 id 保留 `phone` 以免动持久化，label 改「设备」）：「允许连入」栏 = 现有出码/倒计时/复制链接/中继地址 + 已配对设备列表；「连接到节点」栏 = 粘贴框 + 已连节点列表（在线状态、重命名、解绑）+ safeStorage 不可用提示。
- **R10 host 侧 `host-info`**：`pairHost.sendMeta` 增发 `{ type:'host-info', hostname, appVersion }`；协议类型与 `HostToPhone` 联合同步更新。
- **R11 i18n**：新增文案按 `.trellis/spec/renderer/i18n.md` 键即英文原文，补中文。

## Acceptance Criteria

- [ ] AC1 B 桌面设置 → 设备 → 生成配对码并复制链接；A 桌面在节点切换器 `+ 连接节点` 粘贴该链接后 ≤ 5s 内出现节点、显示 B 的 hostname、状态为在线；B 的设备列表出现一条以 A 主机名命名的设备。
- [ ] AC2 A 切到该节点后看到 B 的项目分组与会话列表（含置顶/归档分栏）；点开会话后时间线与 B 桌面一致；上滑可加载更早历史。
- [ ] AC3 在 A 上给远程会话发消息，B 侧该会话开始运行且 A 实时看到流式输出；运行中再发走 steer；可中止。
- [ ] AC4 远程会话触发审批/提问时 A 显示 ApprovalBar/AskBar，在 A 应答后 B 继续执行；B 侧同一请求随即消失。
- [ ] AC5 A 上新建远程会话（选 B 的项目与模型）后 B 桌面列表出现该会话并开始执行；A 自动切到它且无「同步中」横幅卡死。
- [ ] AC6 A 上切换远程会话模型/推理档位后，B 桌面该会话的选择器回显一致。
- [ ] AC7 远程视图不显示回退、重试、worktree、pin/archive/rename、右侧面板、@ 提及、slash 等协议不支持的入口；本机会话的回退/重试功能不受影响。
- [ ] AC8 A 重载窗口（Ctrl+R）后节点连接不断、切回节点无需重连；A 重启后自动重连全部节点。
- [ ] AC9 任一侧解绑后另一侧 ≤ 10s 内标记失效并清理凭据，不再无限重连；B 关闭时 A 显示「对方离线」，B 重开后自动恢复在线。
- [ ] AC10 A 同时作为 host 给手机、作为 guest 连 B，两者互不干扰；手机连 A 的体验无回归（PWA 构建通过，`client.ts` 行为等价）。
- [ ] AC11 `pnpm typecheck && pnpm test && pnpm lint` 通过；新增纯逻辑（guestProjection、nodeStore 解析、NODE_SEND 白名单、remoteNodes reducer、默认标签）均有 Red→Green 测试。

## Out of Scope

- 新服务端 / 账号体系 / 云端任务队列（Multica 的 server 部分）。
- 侧栏融合分组（本机与远程会话同列表）——后续迭代。
- 协议尚不支持的操作（rewind、retry、worktree、pin/archive/rename/delete、coworker 管理、右侧面板、设置读写、@ 提及、slash）。
- 远程节点事件的系统通知（A 上对 B 的会话完成/审批弹系统通知）——后续项。
- 一个 pairId 多 guest 同时在线（需改中继）。
- B 上的 SSH 项目在 A 看来就是 B 的一个项目，无特殊处理。
- 手机 PWA 显示 hostname（协议已支持，PWA UI 改动不在本任务）。

## Risks / Deferred

- 中继单 guest 限制：同一 pairId 若手机与电脑共用会互相顶替 → 文档与 UI 明确「每台连接方单独配对」。
- `client.ts` 重构为调用共享投影：以现有手机行为为基准写等价测试，PWA 构建 `pnpm --filter @enso/phone build` 必须通过。
- `TimelineRow` 引入 context 是对高频组件的改动：只读 context，缺省值保持现行为（本机）。
