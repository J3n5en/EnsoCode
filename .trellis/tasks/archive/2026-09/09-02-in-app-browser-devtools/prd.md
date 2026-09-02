# 内嵌浏览器原生 DevTools 面板

## Goal

用户在右侧 Browser 面板里打开 **原生 Chrome DevTools**（Console / Elements / Network / Sources 等全套），交互对标 Cursor：嵌在面板内，不是独立窗口，也不是自绘日志抽屉。

## Background

- 父任务 `09-01-enso-in-app-browser`：guest 是 Main 的 `WebContentsView`，叠在主窗口上，矩形跟随 `BrowserView` 占位洞。
- 现有工具栏只有后退 / 前进 / 刷新 / 地址栏 / 锁定接管。
- Electron 43：`webContents.setDevToolsWebContents(other)` 把官方 DevTools 前端画进另一块 `WebContentsView`。
- host 已用 `contents.debugger.attach('1.3')` 做截图、无头 emulation、`browser_cdp`。同一 `webContents` **不能同时**挂 debugger 和 DevTools 前端。

## Requirements

- 地址栏旁有开关，打开后在当前 Browser 面板内显示原生 Chrome DevTools。
- 页面与 DevTools 上下分栏（可拖分割条）：上面网页洞，下面 DevTools 洞；两块矩形都报给 Main。
- 不弹独立 DevTools 窗口；不做成 Files/Terminal 级独立 dock 面板。
- 只服务当前网页 tab；切网页 tab / 切会话 / 关侧栏时两边一起藏。
- 锁定接管时网页洞行为不变；DevTools 仍可看、可操作。
- **打开 DevTools 时拆掉该 tab 的 `debugger.attach`**。期间截图 / `browser_cdp` / 无头 emulation 失败并返回明确错误。关掉后再 attach。
- 关开关：拆 `setDevToolsWebContents`，网页洞恢复满高。
- 关网页 tab：guest 与 DevTools view 一起销毁。

## Out of scope

- 自绘 console 日志列表
- 改 `browser_cdp` 白名单或把完整 CDP 交给模型
- 多窗口同步、中央编辑区嵌 DevTools
- 对用户开放远程调试端口

## Acceptance Criteria

- [ ] 点开关后面板内出现原生 DevTools，能切 Elements / Console / Network / Sources
- [ ] 页面 `console.log` / 未捕获异常出现在 Console；Network 能看到该 tab 请求
- [ ] 不是独立窗口，也不挡 Terminal / Files
- [ ] 拖侧栏宽度 / 拖分割条 / 缩放窗口后两块洞都对齐
- [ ] 关开关后 DevTools 消失，网页占满原洞
- [ ] 关 Browser 面板或切走 tab：两块 view 隐藏；再回来开关状态仍在
- [ ] 关网页 tab：guest 与 DevTools view 一起销毁
- [ ] DevTools 开着时 `browser_cdp` / 截图返回明确错误；关掉后恢复
- [ ] `file://` / `javascript:` 导航门不变

## Key decisions

- Q1：开 DevTools 拆 debugger。用户调试优先；agent 侧能力暂时不可用并报错。
