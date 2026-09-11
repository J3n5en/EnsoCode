# EnsoCode Phone（原生 iOS）

用 SwiftUI 重写的手机伴侣，协议与 `packages/phone` PWA 对齐：扫码配对、E2EE 中继、会话时间线、发消息、审批、提问、新建会话、多电脑切换。

## 直接运行

本机需要 Xcode 16+（已验证 Xcode 26）。

```bash
cd packages/phone-ios
make open          # 生成工程并打开 Xcode
# 或
make run           # 装到 iPhone 17 模拟器并启动
```

模拟器无需开发者账号。真机：在 Xcode Signing & Capabilities 里选自己的 Team，Bundle ID 为 `com.j3n5en.enso-code.phone`。

## 使用

1. 桌面 EnsoCode → 设置 → 手机，生成配对码。
2. App 内点「扫描二维码」，或把 `enso://pair?…` / `https://…#relay=…&pk=…` 粘贴后点配对。
3. 配对成功后自动连上桌面，左侧抽屉选会话，底部输入框发消息。

系统相机扫到 `https://enso-relay.j3.do/#…` 时，把链接粘进 App 或用 App 内扫码即可。URL Scheme `enso://` 已注册，可从其它 App 唤起。

## 分发

```bash
cd packages/phone-ios
make archive
```

然后在 Xcode Organizer 里 Distribute：

- **Ad Hoc / Development**：给测试设备
- **App Store Connect**：上架（需改 Team、证书、隐私问卷）

图标来自 `packages/phone/public/icons/icon-512.png`（1024 画板）。

## 测试

```bash
cd packages/phone-ios
make test
```

覆盖 base64url、AES-GCM 帧、NaCl box 换钥、配对 URI、设备列表、会话投影。

## 与 PWA 的差异

- 业务帧走同一套 AES-256-GCM，经中继 WebSocket。配对仍是 NaCl `crypto_box`。
- 推送：原生用系统通知权限 + 本地通知（App 在后台且 socket 仍活着时）。桌面当前的 Web Push/VAPID 不能直接打到 APNs；进程被系统杀掉后不会收到桌面直发。需要系统级推送时再给桌面加 APNs。
- 凭据存在 Keychain，游标在 UserDefaults。

## 工程结构

```
EnsoCodePhone/Pair/     加密、握手、协议、PairClient
EnsoCodePhone/App/      AppModel、主题
EnsoCodePhone/UI/       SwiftUI 屏幕
EnsoCodePhone/Vendor/   tweetnacl.c（公有领域）
```
