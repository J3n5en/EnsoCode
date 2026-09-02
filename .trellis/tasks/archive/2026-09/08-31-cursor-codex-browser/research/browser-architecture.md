# Cursor vs Codex 浏览器调用

本机版本：Cursor 3.18.9；ChatGPT.app / Codex 26.818.61809（`BundleSigningBaseName=Codex`）。CLI `@openai/codex@0.149.1` 与 App 共用同一套 rust `codex` + 插件缓存。

## 一句话

| | Cursor | Codex App |
|---|---|---|
| 宿主 | IDE 进程内 Electron `BrowserView` | 应用内嵌 Chromium（Codex Framework 151）**或** 用户 Chrome/Edge 扩展 |
| Agent 接口 | 固定 MCP 工具集 `cursor-ide-browser` | Skill + Node REPL 里跑 `browser-client` JS API（不是一堆 `browser_*` MCP 工具） |
| 定位方式 | a11y snapshot `ref` 为主，坐标/CDP 为辅 | Playwright locator / DOM-CUA / 坐标 CUA / AX / WebMCP 多层 |
| 会话 | 按 tab `viewId` + lock | 持久 JS `globalThis.browser`，tab 可 markHandoff |

---

## Cursor：内嵌 BrowserView + 进程内 MCP

### 组件

- 扩展 `cursor-browser-automation`（`extensions/cursor-browser-automation`）
- 平台命令 `cursor.browserView.*`：`navigate` / `newTab` / `newHeadlessTab` / `listTabs` / `selectTab` / `closeTab` / `takeScreenshot` / `executeJavaScript` / `sendCDPCommand` / `setLocked`
- 进程内注册：`vscode.cursor.registerMcpProvider(...)`，server id `cursor-ide-browser`（**不是** stdio 子进程）

### Agent 看到的工具

`browser_navigate` · `browser_tabs` · `browser_lock` · `browser_snapshot` · `browser_take_screenshot` · `browser_click` · `browser_mouse_click_xy` · `browser_type` · `browser_fill` · `browser_fill_form` · `browser_select_option` · `browser_press_key` · `browser_scroll` · `browser_drag` · `browser_hover` · `browser_highlight` · `browser_get_bounding_box` · `browser_cdp` · `browser_evaluate`（内部）

系统提示规定的工作流：

1. `browser_tabs list`
2. `browser_navigate`（省略 `position` 则后台开 tab，不抢焦点）
3. 已有 tab 先 `browser_lock`
4. `browser_snapshot` 拿 a11y + `ref`，截图只做目视校验
5. 用 ref 工具点/填；CDP 只做检查/评估/性能
6. 结束 `unlock`

### 实现要点

- **无 Playwright**。交互走 Electron webview + 自研 snapshot。
- **禁止 `CDP Input.*`**：Electron webview 焦点会把输入打到 Cursor UI。
- **origin allowlist**：`cursor.browserOriginAllowlist.ensureNavigationAllowed` / `ensurePageOriginAllowed`。
- **headless tab**：`newHeadlessTab`，agent 后台自动化不打扰编辑器。
- **lock**：锁住后用户要点「Take Control」才能抢回。
- snapshot 会推送（`mcp.snapshot.browser_provider_push_*`），失败有 backfill。

---

## Codex：插件 + Node REPL + 多后端

### 产品分层

```
ChatGPT.app
├── Resources/codex                    # rust agent（与 CLI 同源）
├── Resources/cua_node                 # 捆绑 Node 24 + playwright-core + @oai/sky
├── Resources/plugins/openai-bundled
│   ├── browser/   # in-app browser skill
│   ├── chrome/    # 用户 Chrome/Edge + native host
│   └── computer-use/
├── Frameworks/Codex Framework.framework   # Chromium 151，IAB 内核
└── native/browser-use-peer-authorization.node
```

用户配置（`~/.codex/config.toml`）打开：

- `[plugins."browser@openai-bundled"]` / `[plugins."chrome@openai-bundled"]`
- `[mcp_servers.node_repl]` → `cua_node/bin/node_repl`
- `NODE_REPL_TRUSTED_SERVICES.browser` → `browser-service.mjs`
- `BROWSER_USE_AVAILABLE_BACKENDS=chrome,iab`

feature flag：`browser_use` / `browser_use_full_cdp_access` / `browser_use_external` / `in_app_browser` / `computer_use`。

### Agent 怎么调

**没有** `browser_click` 这类 MCP。流程是：

1. 命中 skill `control-in-app-browser` 或 `control-chrome`
2. 调 `mcp__node_repl__js`
3. `import setupBrowserRuntime from <plugin>/scripts/browser-client.mjs`
4. `agent.browsers.get("iab"|"chrome"|"edge"|"extension")` 或 `getForUrl` / `getDefault`
5. `await browser.documentation()` 再操作 tab

默认：有 IAB 用 IAB，否则 Chrome。用户写 `@Browser` / `@Chrome` 则硬约束，不许静默换后端。

`list()` 返回的 backend 类型：`"iab" | "extension" | "cdp"`。

### Tab API（同一套，后端能力不同）

| API | 用途 | IAB / extension / cdp 差异 |
|---|---|---|
| `tab.playwright` | locator / evaluate / 等导航 | 三端都有；是 **in-skill Playwright 包装**，不是独立 Playwright MCP |
| `tab.cua` | 视口坐标点击拖拽 | 通用 |
| `tab.dom_cua` | 可见 DOM node id | 通用 |
| `tab.ax` | 系统无障碍树 | 默认 IAB/extension/cdp 都标 unsupported |
| `tab.screenshot` / `goto` / `reload` | 基础 | 通用 |
| `user.claimTab` / `openTabs` / `history` | 认领用户已开标签 | IAB/cdp 部分不可用 |
| `tab.capabilities.get("webmcp")` | 页面声明的工具 | 可选 |

Chrome 路径：扩展（id 见 `chrome-native-hosts-v2.json`，native host `com.openai.codexextension`）+ `ChatGPT for Chrome` helper。失败时引导 **Settings → Computer use** 装扩展，不自动改用 IAB。

Computer Use 是另一条线（桌面截图/点击），skill 明确写：有 Browser 插件时 **不要** 因为 CUA MCP 更好点就走桌面。

### 安全（`docs/browser-safety.md`）

页面内容不可覆盖指令；表单/WebMCP 外传先确认；验证码要用户点头；不改最终密码、不绕过付费墙。

---

## 和 Enso 的对照

Enso 现状：`McpManager` 把外部 MCP（stdio/http/sse）摊成 `mcp__<server>__<tool>`。这更接近 **Cursor 的工具面**（离散、可 schema 化），不像 Codex 的「一个 js REPL + 运行时文档」。

若 Enso 要做「内置浏览器」：

- **Cursor 路线更贴现有架构**：Electron 已有，进程内 MCP provider + snapshot/ref 工具，agent 零额外 runtime。
- **Codex 路线更强、更重**：要捆绑 Node REPL、Chrome 扩展、Chromium Framework，工具发现改成 skill+JS SDK。适合「用用户已登录的 Chrome」和 Playwright 级脚本。
- 不要照搬 Playwright MCP 当唯一方案：两边都把 Playwright 当可选层（Cursor 甚至不用），核心是 **自家 tab 宿主 + 稳定元素定位**。

## 本机证据

- `/Applications/Cursor.app/.../extensions/cursor-browser-automation/dist/extension.js`
- `/Applications/ChatGPT.app/Contents/Resources/{codex,cua_node,plugins,Frameworks}`
- `~/.codex/config.toml`、`~/.codex/plugins/cache/openai-bundled/{browser,chrome}/26.818.61809`
