# Design: 侧边栏文件树右键菜单

## Boundaries

- **Renderer**：菜单、行内新建/重命名、确认删除、打开编辑器/预览、调用 `addSidePanelBrowser` + `browser.navigate`。不拼本机绝对路径做 IO。
- **Shared**：新 IPC 通道名与结果类型；`assertAllowedUrl` 增加可选 cwd；条目名校验纯函数。
- **Main services**：`filesWorkspace` 扩展 create / mkdir / rename / remove / resolveAbs（已有 `resolveUnderCwd`）。剪贴板与 Reveal 用 Electron `clipboard` / `shell`，逻辑仍放 service，ipc 只做校验转发。
- **Browser**：导航门从「协议白名单」变为「http(s) 或（file + 落在给定 cwd 内）」。

## Workspace file mutations

请求形状保持 `FilesWorkspaceRequest`：`conversationId`、`projectId`、`rel`，另加 `name` / `toRel` 等标识符字段。

建议通道（三点式：`ipc.ts` + `filesWorkspace.ts` + preload）：

| Channel | 作用 |
|---|---|
| `files:mkdir` | `rel` = 父目录（`""` 为根），`name` 为单层名 |
| `files:create-file` | 同上，空文件；已存在失败 |
| `files:rename` | `rel` → 同目录 `name`，或显式 `toRel`（仍须 `resolveUnderCwd`） |
| `files:remove` | 文件 unlink；目录 rm recursive |
| `files:abs-path` | 返回解析后的绝对路径字符串（给复制路径 / 拼 `file://`）。不开放任意读 |
| `files:copy-path` | Main 写文本剪贴板（`absolute` \| `relative`） |
| `files:copy-file` | 本地文件：`clipboard.writeBuffer('public.file-url' / 平台等价)` 或 Electron `clipboard` 文件 API；SSH 返回 `unsupported` |
| `files:reveal` | `shell.showItemInFolder(abs)`；SSH `unsupported` |

所有通道先 `parseRequest` + `resolveUnderCwd`；`name` 走 `assertEntryName`（禁止分隔符与 `.` `..`）。

本地 fs 用 `fs` sync/promises + `error` 枚举：`invalid-path` | `invalid-name` | `exists` | `unavailable` | `unsupported`。SSH 用现有 executor：`mkdir`、`touch`/`:` 空文件、`mv`、`rm -rf`（仅已解析 abs）。

## Entry name

导出 `assertEntryName(name: string): boolean`（与 `resolveUnderCwd` 同测）：

- 非空、无 `/` `\`、不是 `.` / `..`、无 NUL。

## Tree refresh

`FileTree` 增加 `refreshKey` 或父级在成功后对受影响 `rel` 再 `listDir`。最小做法：根 FileTree 持有 `generation`，突变后 `setGeneration(n+1)` 并保留已展开目录（`openDirs` 不丢）。不必 directory watch。

## Browser `file://`

`assertAllowedUrl(raw, opts?: { fileRoot?: string })`：

- 无 `fileRoot`：行为与现在完全相同（拒一切 `file:`）。agent 工具路径不传 `fileRoot`。
- 有 `fileRoot`：允许 `file:` 且 `fileURLToPath` 后 `resolveUnderCwd(fileRoot, relFromRoot)` 非空。`file:` 无 hostname 要求（mac `file:///Users/...`）。用户名密码仍拒。
- `will-navigate` / `will-redirect` / `setWindowOpenHandler` / `userNavigate` / `navigate` 必须走**同一**带 root 的校验。root 取该 tab 所属 conversation 的本地 cwd（与 `resolveLocalCwd` 相同）。SSH conversation：`fileRoot` 不传，继续拒 `file:`。

菜单「在浏览器中打开」：`files:abs-path` → `pathToFileURL`（Main 也可直接返回 `fileUrl` 以免渲染层拼路径）→ `addSidePanelBrowser` → `browser.navigate(tabId, conversationId, fileUrl)`。优先 Main 返回已校验的 `fileUrl`，渲染层只转发。

持久化：`tabPersist` 仍用 `assertAllowedUrl`。工作区内 `file://` 若要恢复，persist 时必须带得起同一 fileRoot；否则恢复阶段会拒。MVP：file tab **不写入 persist**，或 persist 前把 file URL 丢掉（避免重启后无 root 无法校验）。选择：**不持久化 `file:` 标签**，避免把 cwd 外 URL 写进磁盘。

## Markdown preview

`OpenDoc` 增加 `mode?: 'edit' | 'preview'`。预览 tab 的 `rel` 可用 `rel + '#preview'` 或并行 `previewRels`，避免与编辑 tab 抢同一 `rel`。只读，不 watch-write。内容仍 `workspaceFiles.read`。

## Clipboard file

本地 only。实现放 `src/main/services/filesWorkspaceClipboard.ts`（或同文件导出函数），用 Electron `clipboard`：

- darwin：`public.file-url` / `NSFilenamesPboardType` 常见写法；以当前 Electron 版本可用 API 为准，单测对「路径在 cwd 内才写、越界不写」做纯函数预检。

无法在 node 单测里真写系统剪贴板则测：路径预检 + 不调用 clipboard 当 `resolveUnderCwd` 失败。

## Compatibility

- 现有 read/write/watch 不变。
- 现有「发送到对话」不变。
- urlPolicy 默认调用点不加 `fileRoot` → 外部测试（`file:///etc/passwd`）继续失败。新增带 `fileRoot` 的用例。

## Rollback

关掉新菜单项即可回退 UX；IPC 无调用则无行为变化。urlPolicy 默认签名保持拒 `file:`。
