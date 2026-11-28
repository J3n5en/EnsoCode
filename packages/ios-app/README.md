# EnsoCode iOS App（原生 QUIC + WKWebView 壳）

将 `packages/phone`（精简版 + Desk 完整版）封装为 iOS 原生应用，并在连接支持 QUIC 的自建 Go 中继（`packages/relay-go --quic-listen :443`）时通过 Apple 原生 **Network.framework（`NWProtocolQUIC`）** 提供：

- **多独立双向流**：`control (0x00)` + `ctrl (0x01)` + `bulk (0x02)`，彻底消除大包与小 RPC 之间的传输层队头阻塞；
- **0-RTT 与 Wi-Fi ↔ 5G 连接迁移**：由 iOS Network.framework 原生支持；
- **250ms Happy Eyeballs 自动回落**：连接 Cloudflare Workers 中继或被运营商封锁 UDP 443 时无感切回 WSS；
- **嵌入式本地 HTTP 代理（`LocalWebServer`）**：将 App Bundle 内的前端静态资源托管在 `http://127.0.0.1:<port>`，并缓存/代理 `/desk/*` 加密隧道资源，在 WKWebView 缺少 Service Worker 时完整运行 Desk 完整版；
- **原生 AVFoundation 二维码扫码**与系统持久存储（不再受 iOS Safari 7 天未访问清理影响）。

## 本地构建与运行

```bash
# 1. 构建前端并同步到 packages/ios-app/WebApp，同时生成 Xcode 工程
bash packages/ios-app/scripts/sync-web.sh

# 2. 跑 Swift 核心库单测（EnsoCore）
(cd packages/ios-app && swift test)

# 3. 打开 Xcode 运行到模拟器或真机
open packages/ios-app/EnsoCode.xcodeproj
```

或使用命令行编译 iOS 模拟器包：

```bash
xcodebuild -project packages/ios-app/EnsoCode.xcodeproj \
  -scheme EnsoCode \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  build
```
