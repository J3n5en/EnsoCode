# Design: 右侧 Files 面板

## Boundaries

- Renderer：dock `files` 组件、树、pierre 编辑、拖拽/右键、脏/冲突。
- Main：`listDir` / `write` / `watchStart|Stop`；路径一律由 `conversationId` 推 cwd，不收任意绝对路径当根。
- 不改 agent worker。Changes 面板不动。

## Cwd 与路径

与终端 / git diff 相同：本地用 `sessionWorktree` + `canonicalPath`。SSH 项目无本地 worktree，cwd 用远端 `canonicalPath`，经该项目的 `sshConnectionId` 找 `SshExecutor`（与 agent/terminal 同连接）。

打开/写/watch 的 path：相对 cwd。main `path.resolve(cwd, rel)` 后必须 `startsWith(cwd + sep)`，否则拒绝。单文件 2MB，与 `files.read` 一致。

## IPC

| 通道 | 入参 | 出参 |
|---|---|---|
| `FILES_LIST_DIR` | `{ conversationId, projectId, rel? }` | `{ ok, entries: { name, kind: 'file'\|'dir' }[] }` |
| `FILES_WRITE` | `{ conversationId, projectId, rel, content }` | `{ ok, error? }` |
| `FILES_WATCH_START` | `{ conversationId, projectId, rel }` | `{ ok }` |
| `FILES_WATCH_STOP` | `{ conversationId, rel }` | `{ ok }` |
| `FILES_WATCH_EVENT`（main→renderer） | `{ conversationId, rel, type: 'change'\|'rename' }` | — |

`files.read` 仍走现有通道，但 Files 面板只传 **由 listDir 点选得到的 rel**，再在 renderer 拼 abs 仅用于 read——更稳是新增 `FILES_READ_REL` 只收 conversationId+rel。**采用 `FILES_READ_REL`**，避免再开放任意 `files.read` 路径。现有 `files.read` 留给 EditDiff。

Watch 分后端，同一张 refcount 表 `` `${webContentsId}:${conversationId}:${rel}` ``：

- **本地**：`fs.watch(abs, { recursive: false })`；rename/change 都当「再读」。
- **SSH**：不调远端 fswatch。对打开文件 `setInterval`（~2s）远程 read，内容哈希变化才通知 renderer。executor 忙/断线则跳过这一拍，不叠请求。

refcount 到 0 或 webContents destroyed → `close()` / `clearInterval`。

## 泄漏防线

- 只 watch **已打开文件**，不 watch 目录、不递归。
- 关编辑页签 / 关 dock `files` / 会话 dock unbind → stop 每一个 rel。
- 单测：start×2 + stop×2 才 close；destroyed 清零。
- 禁止 `@parcel/watcher` 整树订阅。

## Renderer

`FilesView`：左 `FileTree`（展开才 `listDir`），右 `FileEditor`。

打开文件存在 store（可内存，不 persist 内容）：`{ rel, contents, version, dirty, conflict }`。

pierre：`EditProvider` + `<File file={{ name, contents }} edit editOptions={{ onChange }} />`。外部刷新：`version++` 且换新 `contents`。dirty 时外部事件只设 `conflict`。

保存：Cmd/Ctrl+S → `FILES_WRITE` → dirty=false。写盘会触发自己的 watch：用「忽略紧随 write 的一发」或比较内容相等则 no-op，避免回跳光标。

工具信号：复用 Changes 的 ok `edit`/`write` path；若 `rel` 在打开集合里且 !dirty，read+bump。这是快路径；watch 覆盖其他会话。

## 拖到 Composer / 右键

`DndContext` 已包 SidePanel。`DragPayload` 增：

```ts
{ type: 'workspace-file'; relativePath: string; name: string }
```

`routeDrop`：over `COMPOSER_DROP_ID` → `insert-file-mention`。`App.tsx` 已有 insert 分支。

右键菜单：`insertComposerMention({ kind: 'file', id: rel, label: name, relativePath: rel })` + 可 `requestFocusComposer()`。拖拽若与 dockview 抢指针，允许只做右键（PRD AC6）。

## 兼容

| 环境 | 行为 |
|---|---|
| 本地 git/非 git | 树 + 编辑 + watch |
| SSH | 树+编辑+保存；watch=轮询打开文件 |
| 手机 shim | list/write/watch 失败空态 |

## Rollback

去掉 `files` 组件后旧 layout 的 `fromJSON` 仍 catch 空态。watch 表随 webContents 销毁。
