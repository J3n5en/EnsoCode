# 设计：右侧栏内嵌浏览器

## 边界

```
Renderer: SidePanel dockview → BrowserView.tsx（单例面板 id 'browser'）
    只报容器矩形 + 可见性；地址栏/前进后退按钮
    IPC: browser:set-viewport / browser:set-visible / browser:tabs / browser:navigate / browser:clear-data
              ↓
Main: BrowserHost（src/main/services/browserHost.ts）
    session.fromPartition(persist:enso[-dev]-browser)
    WebContentsView 叠在主窗口 contentView 上，bounds 跟随面板
    debugger.attach 1.3（仅 Page/DOM/Runtime/Accessibility）
              ↑
Agent worker
    ToolDefinition browser_*（buildCoreTools）
    事件 browser-invoke → 命令 browser-result
```

页只存在 Main。Worker 无 Electron、无 Node `session`。
不用 `BrowserView`（已废弃），只用 `WebContentsView`。
不要把 guest view 塞进 `createAppWindow` 工厂——那是 Enso UI 窗口；guest 页不是 app 窗口，由 BrowserHost 管。

## 为什么不走 MCP / 不复用 capabilityGateway

- MCP：用户要配 server；这是一等内置能力，应像 `read`/`bash` 一样进 `buildCoreTools`。
- `capabilityGateway`：给 Enso 团队能力（审批、child generation）。浏览不是 child 专属，主会话也要用。另开 `browser-invoke` / `browser-result`，避免和 capability `requestId` 命名空间搅在一起。

审批：`withApproval(gate, 'browser' | 'mcp', tool)`。第一刀复用 `'mcp'`；PRD 的「非环回要批」在 **host 再挡一层**：按 origin 记住本应用已批名单，写 userData，不是模型白名单。

## 协议（worker ↔ main）

现状：worker `postMessage` 只发 **事件**（`AgentWorkerEvent`），main `postMessage` 发 **命令**（`AgentCommand`）。能力调用已是 worker→main 事件 `capability-invoke`，main 再 `capability-result` 回来。浏览抄这条：

- Worker 事件：`{ type: 'browser-invoke', requestId, sessionId, generation, op, params }`
- Main 命令：`{ type: 'browser-result', requestId, ok, result?, error? }`

`parseAgentCommand` / `parseAgentWorkerEvent` 必须加字段白名单；漏了会静默丢（见 shared/types.md）。测试夹具同步改。

`op` 闭集：`navigate | snapshot | click | type | screenshot | tabs | lock | close`。

## BrowserHost

不 import `ipcMain`；IPC 注册在 `src/main/ipc/browser.ts`，入参 unknown 收窄。

- `partitionName()`：`persist:${app.isPackaged ? 'enso' : 'enso-dev'}-browser`
- `getSession()`：`session.fromPartition`，permission handler 只放行最小集；`setPermissionRequestHandler` 默认拒
- tab 表：`id → { view: WebContentsView, lockSessionId?, lastSnapshot?, createdAt, ownerSessionId? }`
- 「当前 tab」按 **发起工具的 agent sessionId** 记；无则新建
- `navigate(url)`：`assertAllowedUrl` → origin 审批 → `loadURL`；成功后 `browser:reveal` 让渲染层建/聚焦 Browser 面板
- 销毁 tab：`cookies.flushStore` + `flushStorageData` + `view.webContents.close()` + 从 contentView 移除
- `clearCookies` / `clearCache` / `clearAllData`：`session.clearStorageData` dataTypes 对齐 Cursor 列表
- 无头上限 4：超出关最旧的未锁、非用户正看的 tab

guest `webPreferences`：`sandbox: true`, `nodeIntegration: false`, `contextIsolation: true`，无 Enso preload，`partition` 指向上面的罐。

`setWindowOpenHandler`：`http(s)` 转成本 host 新 tab（`action: 'deny'` 后自己 `navigate`）；其它 deny。不调 `shell.openExternal`。

CDP：`webContents.debugger.attach('1.3')`。命令白名单在 host 内，模型看不到 raw CDP。

### snapshot / ref

纯逻辑放 `src/shared/browser/`（可单测，无 Electron 依赖）：

1. `Accessibility.getFullAXTree`（或 DOM + 可见过滤）
2. 给可交互节点分配 `ref=e1…`，文本树给模型
3. `click`/`type` 用 ref → backendNodeId → `DOM.scrollIntoView` + `DOM.getBoxModel` → **`webContents.sendInputEvent`**（主进程 API），不给模型 `Input.dispatchMouseEvent`

过期：tab 导航（`did-navigate`）或 DOM 大变后清 snapshot；ref 对不上返回 `stale-ref`。

## 叠层（第 2 刀，产品硬约束）

只用 `WebContentsView` 叠在主窗口 `contentView` 上，不开新 `BrowserWindow`，不做中央编辑器 Browser。

**Renderer 侧**（`src/renderer/components/sidepanel/BrowserView.tsx`）：

- 在 `sidePanelDock.ts` 加 `openBrowser()`，与 `changes` / `files` 同款单例（`id: 'browser'`）
- `SidePanel.tsx` 菜单去 Soon
- 面板顶栏：后退 / 前进 / 刷新 / 地址栏 / tab 条；正文是一块占位 `div`（真页面由 Main 画）
- `ResizeObserver` + dockview `onDidActivePanelChange` / `onDidVisibilityChange`：算占位 div 的 `getBoundingClientRect()`（CSS px）+ `window.devicePixelRatio`，发 `browser:set-viewport`
- 不可见条件任一成立即发 `browser:set-visible false`：侧栏关闭、Browser 面板不是 active tab、占位 div 不在文档中、窗口 blur 不算
- 卸载时发 `set-visible false`；**不**销毁 tab、不 flush（页继续无头存活）

**Main 侧**：

- 每个 tab 一个 view；只有「当前面板选中的 tab」`setVisible(true)` 并 `setBounds`，其余 `setVisible(false)`
- bounds 由 renderer 报的 CSS 矩形直接用（Electron `setBounds` 接 DIP，不乘 dpr）；宽高为 0 时当隐藏
- 窗口 `resize` / `enter-full-screen` 不自己算，等 renderer 下一次 `set-viewport`（`ResizeObserver` 会触发）
- 不同窗口（多 app window）：view 只挂在发起可见的那扇窗；切窗时先 `removeChildView` 再挂新窗
- 锁住时：view 上不拦鼠标（Electron 没这 API），改为 renderer 占位 div 叠一层「接管」遮罩不可行（view 在 DOM 之上）→ 折衷：锁住时 Main `setIgnoreMouseEvents` 不可用，直接在面板顶栏显示「Agent 正在操作 · 接管」，点接管解锁；用户误点页面不阻止（Cursor 同款）

`windows.md` 规范里补一句「guest WebContentsView 由 BrowserHost 管，不走 `createAppWindow`」。

## 工具层

`src/agent/tools/browser.ts`：`createBrowserTools(invoke)`
`supervisor.buildCoreTools` 并入，`withApproval`。
`browser_navigate` 参数 `reveal?: boolean`，默认 false（对标 Cursor `position`，第 1 刀只两态）。
远程 ssh 会话：浏览仍打 **本机** Enso Chromium，不转发到远端。文档里写清楚。

## 安全

| 面 | 处理 |
|---|---|
| 导航 URL | 解析后只 http(s)；`file:` / `javascript:` / `enso:` / `chrome:` 明确报错 |
| origin | 非环回首次审批，已批名单落 userData |
| partition | 必须 `persist:` 且后缀 `-browser`，clear API 再校验一遍 |
| CDP | host 内白名单，无 `browser_cdp` 工具，禁 `Input.*` |
| 渲染层 IPC | 矩形只收有限数字；clear 不收路径；navigate 走同一 `assertAllowedUrl` |
| Node | guest `sandbox: true`, `nodeIntegration: false`, `contextIsolation: true`，无 Enso preload |
| 指纹 | 不伪装 UA / GPU / platform，本机 Chromium 原样 |

## 测试切面

单测（先红后绿）：

- `assertAllowedUrl`：环回 / 外网 / file / javascript / 脏字符串
- snapshot 编码与 stale ref
- `parseBrowserInvoke` / `parseBrowserResult` 脏输入
- `parseViewport`：负数 / NaN / 超大 → 丢弃
- 可见性判定纯函数：`(sidebarOpen, activePanelId, rect) → visible`
- partition 名 dev/prod

不测：真 `WebContentsView` 挂载 / setBounds（spec：Electron 窗口行为暂未覆盖）；第 2 刀用 enso-cdp 真机看对齐。

## 回滚

协议加字段导致 spawn 全挂：解析器必须兼容旧命令（新类型是加分支，不是改旧字段）。
设置 `browserEnabled` 默认 true；出事关工具注册 + 菜单项回 Soon，partition 数据留盘。
