# 右侧多类型 Tab 面板（先做终端）

## 需求

- 主区右侧新增可展开面板，默认收起；展开后默认空白，提供「新建 Tab」入口
- Tab 种类：终端 / 浏览器 / 文件…（本期只实现终端，其余在新建菜单中预留占位、置灰）
- Tab 按会话隔离：每个会话有自己的 tab 集合与激活项，切换会话即切换视图
- Tab 支持拖拽排序（复用 @dnd-kit）
- 终端 cwd 跟随会话目录：worktree 目录优先，否则项目目录

## 技术方案

- 依赖：`node-pty`（主进程，需加入 pnpm onlyBuiltDependencies）、`@xterm/xterm` + `@xterm/addon-fit`（渲染层）
- Main：`services/terminalService.ts`（纯逻辑持有 pty 表）+ `ipc/terminal.ts`；IPC 三点式（IPC_CHANNELS / handler 注册 / preload 出口）
  - 通道：create / write / resize / dispose + data / exit 事件
  - cwd 只收 conversationId 推导？—— 当前会话目录信息在 renderer（settings 项目 + worktree 投影），MVP 由 renderer 传 cwd 字符串，main 校验目录存在否则回落 home（不涉及读文件内容，风险仅为工作目录选择）
- Renderer：
  - `stores/sidePanel/`：zustand store，`tabsByConversation` / `activeByConversation` / open / width；纯 reducer 拆出可测（TDD）
  - `components/sidepanel/`：`SidePanel`（容器+空态+新建菜单）、`SidePanelTabs`（横向 Sortable）、`TerminalTab`（xterm 挂载，跟随终端主题/字体设置）
  - App.tsx：右侧接入 + ResizeHandle + 折叠切换按钮
- Tab 布局持久化 layout（kind/title/顺序），pty 进程不持久化；重启后终端 tab 重新创建 pty

## 验收

- [ ] 展开面板为空态，可新建终端 tab；浏览器/文件项可见但禁用
- [ ] 终端可交互，cwd 正确，跟随会话隔离
- [ ] tab 可拖拽排序、可关闭；关闭 tab 时 pty 销毁
- [ ] store reducer 有单测（隔离/增删/激活回落/排序）
- [ ] pnpm typecheck && pnpm test && biome check 通过
