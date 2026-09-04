# 工作区搜索 — 设计

## 行为差距

现在只有 `mod+f` 搜已打开时间线。应该用 `mod+k` 搜本机工作台里的会话投影 + pi `SessionInfo`，跳到对应会话（必要时预填 `ChatFindBar`）。

## 边界

- **检索排序**：`src/shared/workspaceSearch.ts`（无 electron / fs / React）。
- **冷索引**：`src/main/services/workspaceSearchIndex.ts`，只对权威 `sessionFile` 调 pi list。
- **IPC**：`workspace-search:query`（或等价名）挂 `src/main/ipc/`，preload 出口，通道进 `IPC_CHANNELS`。请求只带 `scope` / `projectId` / `query`，不带路径。
- **UI**：`WorkspaceSearchDialog` + `App.tsx` 快捷键；设置页随 `KEYBINDING_ACTIONS` 自动出一项。
- **跳转**：复用 sessions store 切项目/会话/tab；命中正文时打开 `ChatFindBar` 并设 query。

## 数据流

```
keydown mod+k
  → WorkspaceSearchDialog
  → 热：renderer conversations 投影 → searchWorkspace(docs, query, scope)
  → 冷：electronAPI.workspaceSearch.query({ query, scope, projectId })
       → Main: registry sessionFile ∩ SessionManager.list(sessionDir)
       → 同一套 searchWorkspace
  → 合并去重（conversationId）→ 列表
  → 选中：setActive + 可选 requestOpenChatFind(prefill)
```

热索引优先：已 hydrate 的 messages 比 `allMessagesText` 更细（可带 nearby / 工具字段）。冷索引一条 `SessionInfo` 合成一个 body 文档。

## 文档模型（shared）

```ts
type WorkspaceSearchScope = 'project' | 'all' | 'all-including-archived';

interface WorkspaceSearchDoc {
  conversationId: string;
  projectId: string;
  projectName: string;
  title: string;
  lastActiveAt: number;
  archived?: boolean;
  isDraftEmpty?: boolean;
  isCurrent?: boolean;
  parentConversationId?: string; // coworker/child → 跳父
  coworkerId?: string;
  fields: Array<{ field: 'title' | 'project' | 'id' | 'body' | 'tool'; text: string }>;
}

interface WorkspaceSearchHit {
  conversationId: string;
  projectId: string;
  title: string;
  field: 'title' | 'project' | 'id' | 'body' | 'tool';
  snippet: string;
  nearby?: string[];
  isCurrent?: boolean;
  archived?: boolean;
  parentConversationId?: string;
  coworkerId?: string;
}
```

## 冷索引注意

- `SessionManager.listAll()` 会扫 pi 默认 session 目录里**所有**工具的 jsonl。必须用权威 `sessionFile` 做白名单，或对每个 Enso session 的目录调 `list`。
- `allMessagesText` 已是可见正文；不要再解析 jsonl。
- 增量：第一版查询时现拉 + 进程内按 mtime/path 缓存即可。删除后路径不在 registry 即消失。
- 并发：可取消的 in-flight；失败返回空 hits，不抛到 UI。

## 快捷键

`KEYBINDING_ACTIONS` 加 `search-workspace`。`capabilityGateway` 的 `DEFAULT_KEYBINDINGS` 必须同步，否则 capability 重置会丢掉这项。远程节点与 `find-in-chat` 一样屏蔽。

## 明确不做

向量、手写 jsonl、改 `mod+f`、手机 RPC、改权威源结构。
