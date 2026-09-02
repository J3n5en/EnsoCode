# Codex Chrome 扩展原理

商店扩展：[ChatGPT](https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg)（本机 `1.2.27268.51612`）。Edge 另一 id `odlomjlbamekndcpllcnffbgeohgkmjh`。不是独立「Codex 扩展」，是 ChatGPT 扩展兼自动化宿主。

## 为什么用扩展

要的是**用户正在用的 Chrome 配置**：登录态、Cookie、其它扩展、已开标签。  
不能 `--remote-debugging-port` 新开一份空白 Chrome，也不能只靠 Playwright 连默认 profile（Chrome 不允许未授权远程调试）。

官方口子：

1. **Native Messaging**：扩展 ↔ 本机进程（stdio JSON）
2. **`chrome.debugger`**：扩展按 DevTools 协议附着到已有 tab（CDP 1.3）

## 链路

```
Codex agent
  └─ node_repl 里 import browser-client.mjs
       └─ browser-service（可信 Node）
            └─ 本机 app-server / 127.0.0.1 代理

Chrome service worker
  chrome.runtime.connectNative("com.openai.codexextension")
       └─ ~/.codex/.../ChatGPT for Chrome   # rust，约 1MB
            ├─ 读 ~/.codex/chrome-native-hosts-v2.json 选匹配的 Codex/ChatGPT 安装
            └─ 在 127.0.0.1 起 WebSocket，把扩展消息转到 Codex app-server（JSON-RPC）

同一 service worker
  chrome.debugger.attach({tabId}|{targetId}, "1.3")
  chrome.debugger.sendCommand(...)          # 原始 CDP
  自研 playwright_locator_* / tab_cdp_call   # 在扩展里实现 locator
  chrome.scripting.executeScript            # 少量注入
```

Native host manifest（本机 Chrome）：

- name: `com.openai.codexextension`
- type: `stdio`
- path: 插件缓存里的 `ChatGPT for Chrome`
- allowed_origins: 上述两个扩展 id（Chrome 只许这两个来连）

扩展 MV3：`nativeMessaging` + `debugger` + `<all_urls>` + `tabs`/`scripting`/`history`/`sidePanel`。CSP 允许扩展页连 `127.0.0.1` / `localhost` 的 http/ws。

## 运行时约定

- 扩展是**长连接客户端**：SW 连 native host，断了自动重连，dev/internal/prod 主机名可回退。
- native host **不装进 Chrome 自己**：由 ChatGPT/Codex App 写各浏览器的 `NativeMessagingHosts/com.openai.codexextension.json`（本机 Chrome/Edge/Brave/Opera/Vivaldi/Chromium 都有一份）。
- `chrome-native-hosts-v2.json` 按 `appServerProtocolVersion` / `nativeHostProtocolVersion` / 扩展 id 匹配安装；对不上就报 `no_matching_codex_install` / `chrome_extension_update_required`。
- Agent 侧 Playwright 是扩展里的 locator RPC，不是再起一个 Playwright 浏览器。
- 认领用户标签：`plugin://chrome@...?tabId&title&url`，`openTabs()` 对上再 `claimTab`，id 复用则失败。
- Agent 自己开的 tab 回合结束默认关；`markDeliverable` / `markHandoff` 才留。认领的用户 tab 不关，只释放控制。

## 和 Cursor 的差别

Cursor 页在 IDE 进程里，CDP 是 Electron 自己的。  
Codex 扩展是：**本机 native 桥 + 官方 debugger API 附着用户 Chrome**，所以能用已登录会话，但不能静默开远程调试端口。
