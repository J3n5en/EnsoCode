# OAuth 账户信息展示（额度/身份）

## 背景

订阅登录（08-27-provider-oauth）已完成，但已登录条目只有一个「已登录」徽标。pi 生态的 usage 扩展（@mtrojnar/pi-usage 等，MIT）已逆向好各家订阅额度端点，可参照移植到 enso 的 main 服务。

## 需求

1. 订阅登录对话框中，已登录的 provider 显示账户信息（best-effort，取不到的项不显示）：
   - 身份：邮箱、套餐（如 ChatGPT Plus/Pro）
   - 额度：用量窗口百分比 + 重置时间（如 Claude 的 5 小时/7 天窗口，Codex 的 primary/secondary 窗口）
2. v1 覆盖范围：
   - anthropic：`GET api.anthropic.com/api/oauth/usage`（five_hour/seven_day）
   - openai-codex：`GET chatgpt.com/backend-api/wham/usage`（plan_type + rate_limit 窗口）
   - 身份信息通用：access token 为 JWT 时本地解码 email/plan 类 claim（codex/xai 适用）
   - github-copilot 额度（需请求探针）与 xai 额度（无公开接口）不做
3. access token 过期自动刷新（走 runtime.getAuth，不自己管刷新）。
4. 查询失败静默降级：不阻塞登录/退出操作，不弹错误。

## 验收标准

1. 打开订阅登录对话框，已登录的 anthropic/openai-codex 条目显示额度百分比与重置时间；codex 另显示套餐。
2. access token 是 JWT 且含 email 时显示邮箱（xai/codex）。
3. 未登录条目、查询失败条目 UI 与之前一致，无报错。
4. 登录成功后自动加载该条目的账户信息。
5. `pnpm typecheck`、`pnpm lint` 通过（不引入新告警）。
