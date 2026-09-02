# 实施计划

每步一个或多个独立提交；★ = 先写失败测试（Red→Green）。全程 `pnpm typecheck && pnpm test && pnpm lint`。

## Step 1 协议 + host-info（小）
- `packages/pair/src/protocol.ts`：`HostToPhone` 加 `host-info`。
- `src/main/services/pairHost.ts` `sendMeta` 末尾发 `host-info`（`os.hostname()`、`app.getVersion()`）。
- 提交：`feat(pair): host 下发 host-info 帧`

## Step 2 共享投影抽取 ★（中，推荐 coworker 角色分离）
- ★ 先给现有 `packages/phone/src/client.ts` 的 `applyAgentEvent` 行为写等价测试（snapshot 接续/丢弃、message-upsert、status 流转、approvals/asks 增删、retry、task、worker-exited、history 合并）——测试写在 `src/shared/pair/guestProjection.test.ts`，针对将要暴露的纯函数签名，先红。
- 新建 `src/shared/pair/guestProjection.ts`；搬 `taskProjection.ts`、`syncProjection.ts`、`drawerOrder.ts` 到 `src/shared/pair/`（含各自测试），phone 内 import 改路径。
- `client.ts` 改为调用共享函数，`saveCursor` 用返回的 `lastIndex`。
- `pnpm --filter @enso/phone build` 与 `typecheck` 通过。
- 提交：`refactor(pair): 抽出 guest 投影纯函数供桌面与手机共用`

## Step 3 main：nodeStore + pairGuest + IPC ★
- ★ `nodeStore.test.ts`：upsert 保留 label、rename trim、默认 label 填洞、坏 JSON 降级。
- ★ `ipc/nodes.test.ts` 或 `pairGuestPolicy.test.ts`：`NODES_SEND` 放行白名单、拒绝 `push-*`、拒绝非对象。
- `services/nodeStore.ts`、`services/pairGuest.ts`、`ipc/nodes.ts`、`shared/types/ipc.ts` 常量、`shared/types/nodes.ts`（`NodeStatus`、`NodeMessage`）、preload `electronAPI.nodes`。
- main 启动/退出挂 `startGuestHost`/`stopGuestHost`（与 pairHost 同处）。
- 提交：`feat(nodes): main 侧 guest 连接、凭据存储与 IPC`

## Step 4 renderer store ★
- ★ `stores/remoteNodes/reducer.test.ts`：目录/项目/providers/host-info 入库；agent-event 走共享投影；hostOnline 翻转触发重订阅意图；切节点清空；幽灵会话；游标读写（注入 storage）。
- `stores/remoteNodes/index.ts`（zustand）+ `reducer.ts`。
- 提交：`feat(nodes): renderer 远程节点 store`

## Step 5 ChatHostContext 隔离
- `components/chat/chatHost.ts`；`TimelineRow.tsx` RewindButton/RetryButton/RunningElapsed 读 context（缺省=现行为）。
- 提交：`refactor(chat): 时间线经 ChatHostContext 读取宿主会话与能力`

## Step 6 RemoteNodeView + NodeSwitcher + 配对/新建对话框
- `components/nodes/*`；`App.tsx` 分支渲染；i18n 文案。
- 提交拆分：`feat(nodes): 节点切换器与配对对话框` / `feat(nodes): 远程节点会话视图` / `feat(nodes): 新建远程会话`

## Step 7 设置页「设备」
- `DevicesSettings.tsx` 取代 `PhoneSettings.tsx`；`SettingsContent` label 改「设备」；节点列表重命名/解绑。
- 提交：`feat(settings): 手机页扩为设备页，含节点管理`

## Step 8 真机验收
- 两台桌面（或同机两份 userData：`--user-data-dir`）+ 中继：逐条走 AC1–AC10。用 `enso-cdp` skill 驱动 A 端验证。
- 手机 PWA 回归：连 A，列表/聊天/审批正常。

## 风险文件
- `packages/phone/src/client.ts`（重构）：以 Step 2 测试为回归防线。
- `TimelineRow.tsx`（高频组件）：仅加 `useContext`，缺省 null。
- `App.tsx`：分支渲染，`DndContext` 仍包住本机分支。

## 验证命令
```bash
pnpm typecheck && pnpm test && pnpm lint
pnpm --filter @enso/phone typecheck && pnpm --filter @enso/phone build
```
