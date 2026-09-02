# 技术设计：桌面端连接远程 EnsoCode 节点

## 架构总览

```
                 A（guest 桌面）                              B（host 桌面，现状不变 + host-info）
┌─────────────────────────────────────┐            ┌──────────────────────────────┐
│ renderer                            │            │ main: pairHost.ts            │
│  NodeSwitcher ─┐                    │            │  connect(role=host)          │
│  RemoteNodeView│  useRemoteNodes    │            │  handleFrame → PairAgentBridge│
│   ├ NodeSidebar│  (zustand)         │            │  forwardAgentEvent           │
│   └ NodeChat   │   ↑ NODE_MESSAGE   │            │  sendMeta(+host-info)        │
│                │   ↓ NODE_SEND      │            └──────────────▲───────────────┘
├────────────────┴────────────────────┤                           │ WSS(加密帧)
│ preload: electronAPI.nodes.*        │                           │
├─────────────────────────────────────┤     ┌─────────────────────┴───┐
│ main: pairGuest.ts                  │────▶│ relay room(pairId)      │
│  nodeStore.ts (remote-nodes.bin)    │ WSS │  host tag / guest tag   │
│  connect(role=guest) 心跳/退避/1008   │     └─────────────────────────┘
│  openFrame → IPC 推 renderer         │
│  IPC 收命令 → 白名单 → sealFrame     │
└─────────────────────────────────────┘

shared: src/shared/pair/guestProjection.ts  ←  phone/client.ts 与 renderer/stores/remoteNodes.ts 共用
```

## 模块边界

### 1. `@enso/pair` 协议扩展（`packages/pair/src/protocol.ts`）

```ts
export type HostToPhone =
  | ...现有
  /** host 自述：guest 用作默认节点名；旧 PWA 忽略未知帧 */
  | { type: 'host-info'; hostname: string; appVersion: string };
```

`pairHost.sendMeta` 末尾追加一帧 `host-info`（`os.hostname()`、`app.getVersion()`）。

### 2. shared 投影（`src/shared/pair/guestProjection.ts`）

从 `packages/phone/src/client.ts` 抽出，签名：

```ts
export interface GuestSessionView { messages: Map<number, ProjectedMessage>; status: string;
  approvals: ApprovalRequestInfo[]; asks: AskRequestInfo[]; tasks: BackgroundTaskInfo[];
  subagents: SubagentInfo[]; retry?: RetryInfo }

export const emptyView = (): GuestSessionView;

/** 单条 agent-event（非 snapshot）→ 新视图；返回 null 表示事件与此会话无关 */
export function applyGuestEvent(view: GuestSessionView, event: Record<string, unknown>): GuestSessionView;

/** snapshot 批事件：按 baseIndex 接续合并（尾窗接不上则丢弃旧段），返回每会话新视图 */
export function applyGuestSnapshot(
  sessions: ReadonlyMap<string, GuestSessionView>,
  event: { sessions?: unknown[] }
): { id: string; view: GuestSessionView; lastIndex: number }[];

/** history 应答：只并入消息 */
export function applyGuestHistory(view, payload: { baseIndex: number; messages: unknown[] }): GuestSessionView;

/** worker-exited：全部会话置 failed */
export function markAllFailed(sessions): Map<string, GuestSessionView>;
```

`taskProjection.ts`、`syncProjection.ts` 同步搬到 `src/shared/pair/`，phone 里原位置改为 re-export（或直接改 import）。**游标持久化（saveCursor）不进纯函数**：返回 `lastIndex` 由调用方落盘。phone `client.ts` 的 `applyAgentEvent` 改为调用上述函数，行为等价由测试固定（先给现有 `client.ts` 行为写测试再抽取）。

### 3. main

#### `services/nodeStore.ts`
仿 `pairStore.ts`。文件 `remote-nodes.bin`，元素：

```ts
export interface RemoteNode extends PairedDevice { nodeId: string /* = pairId */; label: string }
```

`loadNodes` / `saveNodes` / `upsertNode` / `removeNode` / `renameNode`。纯函数部分（upsert/rename/默认 label）单独导出便于测试。

#### `services/pairGuest.ts`
与 `pairHost.ts` 对称，但每节点一条 `role=guest` 连接：

- `startGuestHost()` / `stopGuestHost()`：启动读盘全连；`powerMonitor.resume` → probe。
- `pairNode(inviteUri): Promise<Result<RemoteNode>>`：`parsePairUri` → `claimPairing(relay, pk, os.hostname())` → upsert → connect。错误分类：`invalid-uri` / `expired-or-claimed`（HTTP 4xx）/ `relay-unreachable`。
- `removeNode(nodeId)`：`revokePairing` best-effort + 本地清理 + 关连接。
- `sendToNode(nodeId, command: PhoneToHost)`：`sealFrame` 后发；ws 未就绪返回 `{ ok:false, error:'offline' }`。
- 收帧：控制帧 `host-online`/`host-offline`/`revoked` → 状态；加密帧 `openFrame` → 过滤 `appearance`/`push-config` → `onMessage(nodeId, payload)`。
- 状态：`NodeStatus { nodeId, label, relayUrl, pairedAt, connected /*WSS*/, hostOnline, revoked }`。
- 1008 或 `revoked` → `removeNode` 本地部分 + 状态广播（UI 提示已被解绑）。

#### IPC（`ipc/nodes.ts`）
| channel | 方向 | 入参校验 |
|---|---|---|
| `NODES_LIST` | invoke | — → `NodeStatus[]` + `secureStorage` |
| `NODES_PAIR` | invoke | `uri: string` |
| `NODES_REMOVE` | invoke | `nodeId: string` |
| `NODES_RENAME` | invoke | `nodeId, label: string`（trim 非空） |
| `NODES_SEND` | invoke | `nodeId: string`, `command: unknown` → `parsePhoneCommand`（复用 `pairPolicy`）且 type ∉ {`push-subscribe`,`push-unsubscribe`} |
| `NODES_STATUS_CHANGED` | main→renderer | `NodeStatus[]` |
| `NODES_MESSAGE` | main→renderer | `{ nodeId, payload: HostToPhone }` |

只主窗口可调 `NODES_SEND`（`isMainWebContents`），设置窗口可调其余。

### 4. preload
`electronAPI.nodes = { list, pair, remove, rename, send, onStatusChanged, onMessage }`。

### 5. renderer

#### `stores/remoteNodes.ts`（zustand）
```ts
interface RemoteNodesState {
  nodes: NodeStatus[];
  activeNodeId: 'local' | string;      // 持久化 localStorage
  byNode: Record<nodeId, {
    catalog: CatalogEntry[]; pinnedOrder: string[]; projects: ProjectEntry[];
    providers: ProviderEntry[]; hostInfo?: { hostname; appVersion };
    sessions: Record<sessionId, GuestSessionView>;
    activeSessionId: string | null; subscribedId: string | null;
    sync: SyncTracking; historyPending: Set<string>;
  }>;
  // actions
  bind(): () => void;             // 订阅 onStatusChanged/onMessage，App 挂载时调一次
  switchNode(id); selectSession(nodeId, sessionId | null); send(nodeId, cmd);
  requestHistory(nodeId, sessionId); spawn(nodeId, req) /* 生成 sessionId、标记 fresh */;
}
```
reducer 部分（`remoteNodesReducer.ts`）纯函数：`applyNodeMessage(state, nodeId, payload)` 内部调 shared 投影；游标存 `localStorage['enso-node-cursors:<nodeId>']`；hostOnline 从 false→true 时重发 `subscribe`（带 sinceIndex）与 `snapshot`。

#### `ChatHostContext`（`components/chat/chatHost.ts`）
```ts
interface ChatHost { sessionId: string | null; canRewind: boolean; canRetry: boolean }
export const ChatHostContext = createContext<ChatHost | null>(null);
```
`TimelineRow` 的 `RewindButton`/`RetryButton`：`const host = useContext(ChatHostContext); if (host && !host.canRewind) return null;` 其余不变；`RunningElapsed` sessionId 优先取 context。`ChatView` 不提供 context（缺省=现行为）；`RemoteNodeView` 提供 `{ sessionId, canRewind:false, canRetry:false }`。phone 不改。

#### 组件
- `components/nodes/NodeSwitcher.tsx`：侧栏顶部下拉/分段；条目：本机、各节点（在线点：绿=hostOnline，黄=connected 无 host，灰=断开）、`+ 连接节点`。
- `components/nodes/PairNodeDialog.tsx`：粘贴框 + 校验 + 错误文案 + busy。
- `components/nodes/RemoteNodeView.tsx`：`NodeSidebar`（项目分组 + 置顶/归档；复用 `drawerOrder` 纯函数——搬到 shared 一并复用）+ `NodeChat`（顶部 = 节点名/会话标题/状态横幅；中 = `MessageTimeline`（items 由 `buildTimeline(messages, running, [], cwd)`）；底 = `RetryBar`/`TaskBar`/`ApprovalBar`/`AskBar`/`Composer`；Composer toolbar 放 `ModelPicker`（`providers` 由 `ProviderEntry[]` 映射为最小 `ModelProvider` 形状，`showReasoningControls` 开）。
- `components/nodes/NewRemoteSessionDialog.tsx`：项目 / provider+model / approvalMode / reasoning。
- `components/settings/DevicesSettings.tsx`：两栏；上栏搬 `PhoneSettings` 内容，下栏节点列表 + 粘贴入口。

#### App.tsx
`activeNodeId !== 'local'` 时渲染 `<RemoteNodeView nodeId=…/>` 取代 `Sidebar/ResizeHandle/ChatView/SidePanel`（TitleBar、Toast、Background 保留）。全局快捷键中与本机会话相关的（切模型、新建会话）在远程态下不响应或路由到远程（首版：不响应）。

## 数据流

1. 配对：UI → `NODES_PAIR(uri)` → main claim → 存盘 → connect → `NODES_STATUS_CHANGED`。
2. 进房：relay 发 `host-online`；host 收 `peer-joined` 后 `sendMeta`（catalog/projects/providers/appearance/push-config/host-info）→ main 过滤 → `NODES_MESSAGE` → store 更新目录。
3. 选会话：store `selectSession` → `NODES_SEND{subscribe,sinceIndex}` → host 请求 renderer resume + snapshot → 尾窗 snapshot 回 → `applyGuestSnapshot`。
4. 发消息：`NODES_SEND{prompt|steer}` → host bridge → B worker → 事件 `forwardAgentEvent` 按订阅裁剪 → A。
5. 解绑：任一侧 DELETE → relay 广播 `revoked` + 1008 → 两侧清凭据。

## 兼容与迁移

- 手机 PWA：`HostToPhone` 新增帧被旧 PWA 忽略；`client.ts` 重构后行为等价（测试固定）。
- 旧桌面 B（无 `host-info`）：A 侧 label 回落「节点 N」。
- 设置分类 id 保留 `phone`，只改 label，不迁移持久化。
- 中继零改动。

## 关键取舍

- 传输放 main 而非 renderer：与 host 对称、凭据不进 renderer、刷新不掉线；代价是多一层 IPC 转发（载荷本就是 JSON，可接受）。
- 不给 sessions store 加节点维度：避免 1916 行 store 与几十处命令分流的回归面；用 context 隔离仅有的两处跨 store 读取。
- 不复制投影逻辑：先测后抽，phone 与桌面共用一份。

## 回滚

所有新增文件独立；对既有文件的改动限于：`protocol.ts`（加联合成员）、`pairHost.ts`（sendMeta 加一帧）、`TimelineRow.tsx`（读 context）、`App.tsx`（分支渲染）、`SettingsContent.tsx`（换组件/label）、`ipc.ts` 常量、preload。逐提交可独立 revert。
