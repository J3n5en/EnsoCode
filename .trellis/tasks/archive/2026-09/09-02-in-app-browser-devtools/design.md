# 设计：面板内嵌原生 DevTools

## 行为差距

现在 Browser 面板只有 guest 网页洞。用户要点工具栏开关，在同一面板下半部看到官方 Chrome DevTools。

行为住在 Main 的 `browserHost`（谁画、谁叠、谁占 debugger），renderer 只报两个矩形和开关。

## 叠层

```
workbench (renderer, 整窗)
  guest WebContentsView     ← 网页洞
  devtools WebContentsView  ← DevTools 洞（仅开关打开且面板可见）
```

与现有 guest 相同：平时压在 workbench 上才能点；renderer 浮层盖住时沉底。DevTools view 单独报 `covered`。

## 绑定

- 每 tab 最多一块 DevTools view，懒创建。
- `guest.webContents.setDevToolsWebContents(devtools.webContents)` 后 `openDevTools({ mode: 'detach' })` 不应再弹窗（目标已是另一块 contents）。若仍弹窗则立刻 `closeDevTools` 并只保留内嵌。
- 关开关：`closeDevTools()` + detach DevTools view（可销毁或隐藏复用；推荐隐藏复用，避免反复加载前端）。
- `destroyTab` 必须关掉并 `close()` DevTools view。

## debugger 互斥

```
devtoolsOpen === true  → 若 debugger 已 attach 则 detach
devtoolsOpen === false → 需要 CDP 时再 attach（现有 cdp()）
```

`cdp()` / `screenshot` / `browser_cdp`：开着 DevTools 时抛
`DevTools is open; close it to use browser CDP / screenshots.`

无头 `Emulation.setDeviceMetricsOverride` 同样走 `cdp()`，开着时跳过并打 warn（用户看得见页，不需要无头撑尺寸）。

## IPC

| 通道 | 方向 | 作用 |
|---|---|---|
| `BROWSER_SET_DEVTOOLS` | r→m | `(tabId, open: boolean)` |
| `BROWSER_SET_DEVTOOLS_VIEWPORT` | r→m | `(tabId, conversationId, viewport \| null, covered)` |

`BrowserTabState` 增 `devtoolsOpen: boolean`，走现有 `BROWSER_STATE`。

renderer：`setViewport` 仍报网页洞；DevTools 洞另报。关面板时两路都传 null。

## 矩形拆分

`BrowserView` 在 guest 占位下加可拖分割条 + DevTools 占位。高度本地 state（默认约 40% 面板高，下限 ~120px）。不进 settings。开关状态跟 `state.devtoolsOpen`，刷新后以 Main 为准（tab 活着就还开着）。

## 不做

- dockview 新面板
- persist `devtoolsOpen` 到 `browser-tabs.json`（进程被卸掉后默认关）
- 改 agent 工具列表
