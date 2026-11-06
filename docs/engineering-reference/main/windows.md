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
...(isWindows && {
  transparent: false,
  thickFrame: true,
  titleBarOverlay: { color, symbolColor, height: 44 },
}),
...(isMac && { trafficLightPosition: TRAFFIC_LIGHT_POSITION }),
```

macOS 保留系统红绿灯；Windows 通过 Window Controls Overlay 保留原生窗口按钮，
让系统识别最大化按钮并提供 Windows 11 贴靠布局；Linux 由 `TitleBar.tsx` 自绘。
Windows 的标题栏内容为原生按钮预留区域，优先使用 `titlebar-area-width`，独立
`WebContentsView` 没有该几何信息时按 138 DIP 预留。`useNativeWindowControls` 把实际
标题栏配色转换成十六进制色，经 `window:set-title-bar-appearance` 同步；Main 只接受经过校验的
颜色，并且只允许该窗口的工作区 renderer 更新。按钮底色保留 alpha（`#rrggbbaa`）：
标题栏透明或半透明（壁纸模式、桌面外壳顶栏落在画布上）时原生按钮区一起透出，
不要再给顶栏垫不透明底色来迁就按钮。按钮图标色和可选的宿主底色 `surface`（取画布色）
必须不透明；半透明按钮底色不能拿来 `setBackgroundColor`，丢掉 alpha 会把宿主刷成近黑。

Windows 顶层 `BrowserWindow` 必须保持不透明：Electron 43 的透明窗口会强制关闭
粗边框，并使用特殊的最大化路径。主窗口的 workbench `WebContentsView` 与其 HTML
仍保持透明，所以 guest 网页垫底和菜单遮挡仍沿原有视图叠层处理。macOS/Linux 的
透明主窗口配置保持原样。

主窗口暂时保留 800×600 的最小尺寸。系统贴靠区域小于此尺寸时仍会受到限制；
进一步降低限制需要同时适配聊天、侧栏和右侧面板，不能只改两个尺寸常量。

Linux 最大化后中间按钮改成还原图标（重叠方块），不要一直画单个方块。

`useWindowsWindowChrome` 给主窗口 `html` 挂 `enso-win` 和 `enso-win-native`，
最大化/全屏时挂 `enso-win-flush`。原生模式不叠加 renderer 自绘圆角与描边；
这些状态只控制 browser guest/devtools 的边缘预留。

窗口状态事件可能先于初始 IPC 查询返回；初始快照不能覆盖已经收到事件的字段，
Effect 清理后也不能让未完成的查询重新写 class。初始查询完成前挂
`enso-win-pending`，避免恢复最大化窗口时短暂闪出普通态圆角。
Windows 恢复窗口时 `unmaximize` 通知可能不到 pinned renderer；renderer 收到
`resize` 后要防抖重查 `isMaximized` / `isFullScreen`，事件通知只作为快速路径。

Browser guest/devtools 是独立原生 `WebContentsView`，提到 workbench 上方时不受
`#root` 的圆角裁切和 CSS z-index 约束。普通窗口下，renderer 上报 viewport 的
`browser-native-stack` 必须给右描边留 2px（1px 窗口裁边 + 1px 描边）、给底部圆角留 8px；flush 状态取消预留。

## Windows 最小化

旧版透明主窗口 + pinned `WebContentsView` 在 Windows 上最小化一段时间后，任务栏可能点不回来。
主窗口 `html` / `body` 全透明，UI 全靠 workbench 画，所以 occlusion、0×0 bounds、
renderer 被杀、GPU 丢表面的观感都一样，**未在真机二分，不要把其中一条写成已证实根因**。

当前 Windows 顶层窗口已不透明；仍保留以下防御（`win32Restore.ts` / `rendererGone.ts`）：

- win32 启动时把 `CalculateNativeWinOcclusion` 合并进 `disable-features`（未证实是否仍有效）。
- 最小化 / 空矩形不写 workbench bounds；`restore` / `show` / `maximize` / `unmaximize` /
  `display-metrics-changed` 立即同步，并 `setImmediate` 再同步一次。
- `browserHost.ensureWorkbenchOnTop` 走同一套 bounds。
- `restore` 只在「刚从 minimize 回来」时尝试 `show()`，避免和 unmaximize 的 `restore` 搅在一起。
- `render-process-gone` 除 `clean-exit` 外都 reload（含 Windows 后台 `killed`），60s 内最多 3 次。
- `child-process-gone` 打日志，便于下次对照 GPU / utility 是否先死。
- 第二实例唤起要 `restore` + `show` + `focus`，不能只 `focus`。
- 不要给 pinned workbench 关 `backgroundThrottling`：挡不住合成器停帧，还会让最小化期间
  layout 更勤，更容易把 bounds 写坏。

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
- 隐藏 tab 另外开 `Emulation.setFocusEmulationEnabled`，否则后台页 rAF / 动画仍会被掐
  （`backgroundThrottling: false` 不够）。亮着的 tab 关掉 focus emulation。
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
