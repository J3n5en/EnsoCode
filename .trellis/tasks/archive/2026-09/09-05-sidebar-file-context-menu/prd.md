# 侧边栏文件树右键菜单增强

## Goal

侧栏 Files 树（文件行、目录行、空白处）右键可完成日常文件操作：新建、复制路径/真文件、查看、工作区内 `file://` 用侧栏浏览器打开、Markdown 预览、系统中显示、重命名、删除；文件行保留「发送到对话」。

## Background

- UI：`src/renderer/components/sidepanel/FilesView.tsx`。文件行仅有「发送到对话」；目录与空白处无菜单。
- IPC：`workspaceFiles` 仅 list/read/write/watch。写盘路径必须是 `conversationId` + `projectId` + 相对路径，Main 用 `resolveUnderCwd` 落到会话 cwd。
- 浏览器：`assertAllowedUrl` 只允许 http(s)，测试拒绝 `file:///etc/passwd`。已拍板：仅工作区内 `file://` 可导航。
- 树：`listDir` 只在 FileTree 挂载时拉一次。突变后必须刷新可见目录。
- 参考：Orca `file-explorer-row-context-menu.tsx`。不对齐远程下载、加为项目、Find in Folder、Collapse、Open in Terminal。

## Requirements

### 菜单出现位置

- **文件行**：新文件、新建文件夹；复制路径、复制相对路径、复制真文件（仅本地文件）；查看文件；侧栏浏览器打开（仅本地）；Markdown 预览（`.md` / `.markdown` / `.mdx`）；Reveal（仅本地）；重命名；删除（destructive + 确认）；发送到对话。
- **目录行**：新文件、新建文件夹（建在该目录内）；复制路径、复制相对路径；Reveal（仅本地）；重命名；删除（确认）；不出现查看 / 浏览器 / Markdown / 真文件复制 / 发送到对话。根目录条目不提供删除、重命名（没有可操作的根节点时，根操作只走空白处新建）。
- **树空白处**：仅新文件、新建文件夹，目标为仓库根（`rel=""`）。
- 无能力则隐藏，不放禁用占位。

### 行为

- **新建**：行内输入单层文件名；Enter 确认，Escape 取消。禁止 `/` `\` 空名 `.` `..`。同名冲突不覆盖，提示失败。
- **复制相对路径**：文本剪贴板，POSIX `rel`。
- **复制路径**：文本剪贴板，会话 cwd 解析后的绝对路径（SSH 为远端绝对路径）。由 Main 写入剪贴板，渲染层不传绝对路径做 IO。
- **复制真文件**：Main 把本地文件写入 OS 文件剪贴板。目录与 SSH 隐藏。失败 toast。
- **查看文件**：与单击相同，打开 Files 编辑器 tab。
- **Markdown 预览**：Files 面板只读预览，可与源文件 tab 并存。与聊天气泡共用的 `Markdown` 不同，Files 预览另走 `FileMarkdownPreview`（rehype-raw + rehype-sanitize），支持 README 常见原生 HTML（`<p align>`/`<h1>`/`<b>`/`<img width>`/`<details><summary>` 等，用 hast-util-sanitize 默认白名单），相对图片路径按当前 Markdown 文件所在目录解析到工作区内并通过 `files:read-image` 转为 data URL；http(s)/协议相对的远程图片（如 README 彽章 badge）通过 `files:fetch-remote-image` 走主进程代理，带 SSRF 防护（协议白名单、拒私有/保留 IP、解析后的真实 IP 连接前再验一次防 DNS rebinding、重定向逐跳校验、Content-Type 位图白名单、大小上限）。两条链路都不开放任意文件读取；svg（包括 README 彽章 badge 常用的 image/svg+xml）受支持——仅因为它始终只通过真实 `<img>` DOM 元素渲染（从不用 dangerouslySetInnerHTML/内联 `<svg>`/object/embed/iframe，`<svg>` 标签本身不在 sanitize 白名单里），浏览器对作为图片加载的 SVG 实施图片上下文隔离（禁脚本）；声明/扩展名与实际内容魔数不符仍拒（防改后缀伪装）。越权/`javascript:`/事件属性仍拒。聊天气泡行为不变。
- **侧栏浏览器**：本地工作区内文件导航 `file://`。校验等同 `resolveUnderCwd`。工作区外、SSH、目录：不出现或拒绝。其它危险协议仍拒绝。地址栏 / agent / 页内跳转提交工作区外 `file://` 仍拒绝。
- **Reveal**：本地 `shell.showItemInFolder`；文案按平台（Finder / File Explorer / 打开所在文件夹）。
- **重命名**：行内编辑，名称规则同新建；冲突不覆盖。打开中的 tab 改指向新 `rel`，不得再往旧路径写。
- **删除**：确认后永久删除，不做回收站。打开中的文件关闭对应 tab。
- **刷新**：创建 / 重命名 / 删除成功后刷新受影响目录列表。不做全盘 directory watch。
- **文案**：`t()` i18n。快捷键本期非必达。

## Additive request（同 tab 内 source/preview 切换）

- 打开 Markdown 文件的编辑 tab 时，文档内容区右上角（tab 栏下方）出现一个切换按钮：在**同一 tab** 内切换「源码 / 预览」两种视图，而非另开 tab。
- 非 Markdown 文件不显示该按钮；已通过右键菜单单独打开的只读 Markdown 预览 tab（独立 `#preview` tab）不受影响，继续保留。
- 切换到预览态展示的是当前未保存草稿（`draft`），不是磁盘内容；切回源码态保留未保存的编辑，不丢草稿、不触发保存。
- 复用现有 `Markdown` 渲染组件与项目 `Button` 封装；图标用 Eye（源码态可切预览）/ Code（预览态可切回源码）；文案走 `t()`。

## Out of scope

- 远程下载、加为项目、Find in Folder、Collapse Folder、Open in Terminal
- 全局放开 `file://`
- 多选、回收站、撤销删除、目录作为 OS 剪贴板文件
- SSH 真文件剪贴板与 SSH `file://` 浏览器

## Acceptance Criteria

- [ ] 文件 / 目录 / 空白处右键项符合「菜单出现位置」；文件「发送到对话」仍插入 composer mention
- [ ] 新文件 / 新文件夹出现在正确父目录（含根）；非法名或冲突不写盘
- [ ] 复制相对路径、复制绝对路径进入文本剪贴板
- [ ] 本地文件「复制」可在访达/资源管理器粘贴为文件；SSH 与目录无此项
- [ ] 「查看文件」打开编辑器；Markdown 可开只读预览
- [ ] 本地工作区内文件可用侧栏浏览器以 `file://` 打开；`file:///etc/passwd` 及 cwd 外路径仍被拒绝（含页内跳转）
- [ ] 本地 Reveal 打开系统文件管理器并选中该条目
- [ ] 重命名 / 删除成功后树刷新；打开中的 tab 不指向已失效路径
- [ ] 新 IPC 对 `../`、绝对路径与现有 `resolveUnderCwd` 一样失败
- [ ] `pnpm typecheck` 与相关单测通过（url 策略、路径校验、条目名规则）
