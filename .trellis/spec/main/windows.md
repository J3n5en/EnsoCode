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
- **HTML 弹层盖不过 guest view**：不能整页 `setVisible(false)`（白屏）。BrowserView 按 popup 矩形从 guest bounds 上裁一条，全屏 backdrop 忽略。新弹层打 `data-enso-float` 或 `data-slot=*-popup|*-positioner`。
