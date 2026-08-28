# 接入 Cursor 订阅 provider

## 背景

用户希望用 Cursor 订阅（Composer/Claude/GPT/Grok）的模型。Cursor 无公开 API，pi 无内置 provider，但社区扩展 `@rahularya01/pi-cursor`（MIT）已逆向 Cursor 私有协议（Connect/protobuf over HTTP/2）并封装为标准 pi extension。用户已知悉这是**非官方逆向集成**，Cursor 可能随时改协议或按 ToS 处理账号，自负风险。

## 需求

1. 复用 `@rahularya01/pi-cursor` 扩展，让 `cursor` 作为一个 OAuth 订阅 provider 出现在 enso 的订阅登录对话框，可登录、可选模型对话。
2. 凭证与 enso 现有 auth.json 对齐；若本机已登录 Cursor（CLI Keychain / IDE 本地库），扩展的凭证级联可零配置直接用。
3. 登录/spawn 复用已有 OAuth 链路（provider.oauthProviderId = 'cursor'）。
4. 账户信息（额度/身份）本轮不做，后续可接扩展的 cursor.usage 能力。

## 验收标准

1. 订阅登录对话框出现 Cursor 条目，可发起登录并落库到 enso auth.json。
2. 已登录后 Cursor 模型出现在列表，可新建会话对话（需真实 Cursor 账号实测）。
3. 未装 / 加载失败时不影响其它 provider 与 app 启动（best-effort，静默降级）。
4. `pnpm typecheck`、`pnpm build` 通过。

## 非目标

- 不做 Cursor 额度/账户信息展示（本轮）。
- 不移植协议层自研（用现成扩展）。
