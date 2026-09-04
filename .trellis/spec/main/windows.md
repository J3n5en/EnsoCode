# 窗口规范

## 多窗口模型

每个窗口是独立的 renderer 入口，在 `electron.vite.config.ts` 里声明：

```ts
input: {
  index: path.resolve(__dirname, 'src/renderer/index.html'),
  settings: path.resolve(__dirname, 'src/renderer/settings.html'),
}
```

新增窗口要同时加：入口 html、入口 tsx、`electron.vite.config.ts` 的 input、
`src/main/windows/<Name>Window.ts`。

窗口一律经 `createAppWindow()` 工厂创建，不要直接 `new BrowserWindow`。工厂统一处理了
无边框样式、窗口状态持久化、可编辑区右键菜单、外链转系统浏览器、dev/prod 加载路径。

单例窗口的模式见 `SettingsWindow.ts`：模块级变量持有引用，已存在则 `restore()` + `focus()`，
`closed` 事件里置空。

## 无边框标题栏

平台差异集中在工厂里：

```ts
titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
frame: isMac,
...(isMac && { trafficLightPosition: TRAFFIC_LIGHT_POSITION }),
```

macOS 保留系统红绿灯，Windows/Linux 由渲染层自绘（`components/app/TitleBar.tsx`）。

Windows 透明主窗口无框后系统不再画圆角和外框。主窗口渲染层用
`useWindowsWindowChrome` 给 `html` 挂 `enso-win`，`globals.css` 给 `#root`
在 `enso-main-shell.enso-win` 下画 8px 圆角和描边；最大化/全屏挂
`enso-win-flush` 去掉这层。普通不透明窗口（如设置页）保留 Windows/DWM
已有的圆角和边框，不要重复挂自绘 chrome。
不要给透明主窗口开 Electron `roundedCorners`。

窗口状态事件可能先于初始 IPC 查询返回；初始快照不能覆盖已经收到事件的字段，
Effect 清理后也不能让未完成的查询重新写 class。初始查询完成前挂
`enso-win-pending`，避免恢复最大化窗口时短暂闪出普通态圆角。
Windows 恢复窗口时 `unmaximize` 通知可能不到 pinned renderer；renderer 收到
`resize` 后要防抖重查 `isMaximized` / `isFullScreen`，事件通知只作为快速路径。

Browser guest/devtools 是独立原生 `WebContentsView`，提到 workbench 上方时不受
`#root` 的圆角裁切和 CSS z-index 约束。普通窗口下，renderer 上报 viewport 的
`browser-native-stack` 必须给右描边留 1px、给底部圆角留 8px；flush 状态取消预留。

## macOS 红绿灯

三条来自实际排查的约束：

**位置用固定像素，不用 rem。** 本项目 `:root` 的 `font-size` 是 14px，
Tailwind 的 `h-11` 会算成 38.5px 而不是 44px，与 `trafficLightPosition: { x: 16, y: 16 }`
假定的 44px 标题栏对不上，标题就不居中。标题栏因此写死 `h-[44px]` 和 `pl-[84px]`。

**恢复显示时必须重设位置。** `setWindowButtonVisibility(true)` 会把按钮位置重置为系统默认，
所以 `src/main/ipc/window.ts` 里恢复显示后要重新 `setWindowButtonPosition()`。
漏掉的表现是：弹窗开关一次之后红绿灯位置就偏了。

**开关由渲染层的引用计数守卫驱动。** `src/renderer/hooks/useTrafficLightsGuard.ts`
是模块级单例，多个并发弹窗用计数避免互相覆盖，全屏时不隐藏，HMR 时通过
`import.meta.hot.dispose` 复位以免计数泄漏。Dialog / AlertDialog 的根组件已自动调用，
新弹窗组件走这两个封装就无需关心。

## 窗口状态持久化

传 `stateFile` 即启用，状态写在 `app.getPath('userData')` 下的独立 JSON，
与 `settings.json` 分开 —— 窗口几何信息变化频繁，不该触发设置的多窗口广播。

## 生命周期

`src/main/index.ts` 的要点：

- **单实例锁**：`requestSingleInstanceLock()`，第二个实例聚焦已有窗口后退出。
  调试时若发现新起的实例秒退，先确认没有残留进程：
  `pkill -f "electron-vite dev"`。
- `app.on('browser-window-created')` 统一给所有新窗口挂状态事件，
  见 `ipc/index.ts` 的 `attachWindowStateEvents`。
- 退出前 `flushSettings()` 落盘未写完的设置（见 [settings-persistence.md](settings-persistence.md)）。

## guest WebContentsView 由 BrowserHost 管，不走 createAppWindow

内嵌浏览器的网页是主窗口 `contentView` 的子 `WebContentsView`，不是 app 窗口：
不开新 `BrowserWindow`，不进 `createAppWindow`。矩形由渲染层 `browser:set-viewport`
上报（CSS px = DIP，直接 `setBounds`），可见性由 `browserHost.layout()` 统一决定。

真机踩过的坑（改 `browserHost.ts` 前先读）：

- `contentView` 的子视图**全部画在 renderer 之上**，index 0 也不例外；无头只能 `setVisible(false)`。
- 隐藏后 view 尺寸归零，页面布局 0×0（快照只剩 inline 元素、截图空）。用 CDP
  `Emulation.setDeviceMetricsOverride` 撑出 viewport，可见时 `clearDeviceMetricsOverride`。
- 被遮挡 / 隐藏的 view `capturePage` 报 `UnknownVizError`；截图走 CDP
  `Page.captureScreenshot` + `captureBeyondViewport`。
- **首次 `dom-ready` 之前 `debugger.attach` 会让 Main 段错误**（SIGSEGV）。`Tab.ready`
  门住所有 CDP 调用。
- 渲染层 CDP 截图只拍 renderer webContents，看不到兄弟 view；验叠层要 `screencapture`。
- **层级按 `covered` 动态切**（`browserHost.layout()`）。工作区 renderer 是一整块 NSView，
  **透明像素照样吃掉 hit-test**——guest 垫在它下面时用户点不到网页（锁没锁都一样，真机踩过）。
  所以：平时 guest `addChildView(view)` 叠在工作区**之上**，用户可直接操作；只有 renderer
  报 `covered=true` 时才 `addChildView(view, 0)` 沉到底，靠 HTML 透明洞（`.enso-guest-hole`）
  透出网页，让菜单 / Dialog / 锁定遮罩盖在上面。
- `covered` 由 `BrowserView.tsx` 的 rAF tick 算：`state.locked`，或 body 下 `#root` 之外任一
  portal 元素的盒子与网页矩形相交（`overlayCover.ts`）。新增浮层组件只要 portal 到 body 就自动
  生效，不要为弹层整页隐藏 guest，也不要用原生菜单绕。
- 验证「用户能不能点网页」必须发 **OS 级鼠标事件**（CGEvent / `cliclick`）；CDP
  `Input.dispatchMouseEvent` 直接进 webContents，绕过 NSView hit-test，验不出层级问题。
