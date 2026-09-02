# Enso 内嵌浏览器（右侧栏）

## 背景

Cursor 3.18.9：Main 用 `WebContentsView` + `persist:${app}-[dev-]browser`；扩展只注册进程内 `browser_*`，无 Playwright。
页内脚本打 `data-cursor-ref` / 自写 YAML snapshot；点击走 DOM 事件，**禁止 CDP `Input.*`**。
可见面是右侧栏 Browser tab；agent `navigate` 自动打开该面板，用户能看见。

Enso 已有右侧 `dockview`（Terminal / Files / Changes），「Browser」菜单项仍是 Soon。
Agent 在 `utilityProcess`，页必须活在 Main；worker 只发命令、收结果。
guest 页不能当 React 子树，也不能用普通 iframe（session / 沙箱对不齐 Cursor）。

## 目标

- Agent 在 Enso 自带 Chromium 里打开页、读 snapshot、按 `ref` 点/填、截图。
- Cookie / localStorage 落在独立持久 session，和编辑器 `defaultSession` 切开。
- **用户看见的地方只有右侧 SidePanel 的 Browser tab**（与 Files / Terminal / Changes 并列）。
- 用户能在同一 persist session 里手动登录，能清浏览数据。

## 非目标

- 不控制用户日常 Chrome / 不做商店扩展 / Native Messaging
- 不接通用 Playwright MCP，不当 Computer Use
- 不把任意 CDP（尤其 `Input.*`）交给模型
- 不做编辑器中央区 Browser 编辑器、不做多窗口同步浏览
- 第一刀不做 per-workspace 多罐、不做企业 origin allowlist、不做 `browser_cdp` / hover / drag / fill_form

## 需求

### 可见面（右侧栏）

- `New tab` 菜单启用 Browser，去掉 Soon。
- 一个会话一个 Browser 面板（与 Files/Changes 同款单例）；面板内再切网页 tab。
- 面板顶栏：后退 / 前进 / 刷新 / 地址栏；清 Cookie 可后置到设置。
- 用户切走或关掉 Browser 面板：页可继续无头存活，不销毁 persist session。
- 用户关网页 tab：flush 后销毁该 tab。
- Agent `navigate` 自动打开右侧 Browser 面板并叠上真实网页；用户关面板后页可继续无头存活。
- 锁住时：面板上可「接管」（对标 Take control），解锁后用户能点页面。

### 叠层（产品约束）

- 真实网页由 Main 的 `WebContentsView` 画在主窗口上，矩形跟随右侧 Browser 面板的屏幕盒子。
- 侧栏关着、面板不可见、或当前 dock tab 不是 Browser：view 隐藏，不挡 Terminal/Files。
- 侧栏拖宽、窗口缩放、分屏：盒子同步，不能错位或漏出邻面板。

### 会话

- 全应用共用一罐：`persist:enso-browser`（dev：`persist:enso-dev-browser`）
- 与主窗口 `defaultSession` 隔离
- 关网页 tab / 退应用前 flush Cookie 与 storage
- 设置里可「清 Cookie」「清缓存」「清全部」

### 导航边界

- 只允许 `http:` / `https:`
- 拒绝 `file:`、`enso:`、`chrome:`、`javascript:` 等
- 环回（localhost / 127.0.0.1 / ::1）默认放行
- 其它 origin 首次需审批（现有 approval 门，类别单独或复用 mcp）
- 页内 `window.open` / 外链：本 tab 导航或新网页 tab，不弹系统浏览器抢焦点

### Agent 工具（内置，不靠用户配 MCP）

| 工具 | 作用 |
|---|---|
| `browser_navigate` | 开/复用 tab 并导航；默认后台 |
| `browser_snapshot` | 可访问树 + 稳定 `ref`（`e1`…） |
| `browser_click` | 按上次 snapshot 的 `ref` 点 |
| `browser_type` | 按 `ref` 输入（可清空后填） |
| `browser_screenshot` | 视口截图（图回模型，不当定位） |
| `browser_tabs` | 列 / 切 / 关 tab |
| `browser_lock` | 锁当前 tab；用户可接管 |

无 Playwright 选择器。点/填只认本会话最近一次 snapshot 的 `ref`，过期则报错让模型重拍。

### 生命周期

- Agent 自己开的 tab：回合结束默认可关；用户正在看的不关
- 锁住的 tab 回合结束不关
- 无头 tab 上限（建议 4），超出关最旧未锁 tab

## 验收

- [ ] 右侧 `New tab` 能开 Browser；面板可见时能看到真实网页（不是空白占位）
- [ ] 侧栏关着或切到 Terminal/Files 时，网页不挡其它面板
- [ ] 拖侧栏宽度 / 缩放窗口后，网页盒子仍对齐 Browser 面板
- [ ] 打开 `http://127.0.0.1:<port>`，snapshot 有可点 `ref`，click 后 URL 或树变化
- [ ] Agent `navigate` 自动打开右侧 Browser 面板并显示网页
- [ ] 在内嵌页登录后重启 Enso，同一 origin Cookie 仍在（persist 目录有 `enso-*-browser`）
- [ ] 主窗口 Cookie 登的站，内嵌页看不到（session 切开）
- [ ] `file://` / `javascript:` 被拒且有明确错误
- [ ] 非环回 origin 第一次 `navigate` 走审批；拒绝则不导航
- [ ] 过期 `ref` 不乱点，返回可理解错误
- [ ] 设置「清全部」后该站 Cookie 消失
- [ ] 用户没配任何 MCP server 也能看到上述工具
- [ ] 改协议时 `parseAgentCommand` / 构造 / 消费三处同步，脏输入丢弃有日志
- [ ] 可单测逻辑（URL 策略、ref 解析、命令收窄）先红后绿

## 分期

1. **宿主 + 无头工具**：persist、命令桥、navigate / snapshot / click / type / screenshot（localhost 可测）
2. **右侧栏可见**：启用 Browser tab、矩形叠层、地址栏、手动登录
3. **收尾**：tabs / lock / 接管、回合清理、设置里清数据

第 1 刀就必须能让 agent 测 localhost。第 2 刀才叫「右侧栏能看见」。
