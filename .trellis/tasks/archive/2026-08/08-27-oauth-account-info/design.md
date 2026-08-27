# 技术设计

## 数据流

Renderer（订阅对话框） → IPC `OAUTH_ACCOUNT_INFO` → main `oauthProviders.ts` 新增 `getOauthAccountInfo(providerId)` → 各 provider 分支 fetch → 归一化返回。

## shared 类型（oauthProviders.ts 扩展）

```ts
interface OauthUsageWindow { label: string; usedPercent: number; resetsAt?: number } // epoch ms
interface OauthAccountInfo { email?: string; plan?: string; windows: OauthUsageWindow[] }
```

IPC_CHANNELS 增 `OAUTH_ACCOUNT_INFO`。

## main 实现（参照 @mtrojnar/pi-usage，MIT）

- **token 获取**：`runtime.getAuth(providerId)` → `auth.apiKey` 即有效 access token，刷新由 runtime 的锁内 refresh 处理，不读 auth.json 管过期。
- **anthropic**：`GET https://api.anthropic.com/api/oauth/usage`，头：`Authorization: Bearer`、`anthropic-beta: claude-code-20250219,oauth-2025-04-20`、`user-agent: claude-cli/<ver>`、`x-app: cli`、`anthropic-version: 2023-06-01`。响应 `five_hour`/`seven_day` 的 `utilization`（0-100）与 `resets_at`。
- **openai-codex**：`GET https://chatgpt.com/backend-api/wham/usage`，头：`Authorization: Bearer`、`ChatGPT-Account-Id`（从 access token JWT 的 `https://api.openai.com/auth`.chatgpt_account_id 取）。响应 `plan_type`、`rate_limit.primary_window/secondary_window` 的 `used_percent`/`reset_at`。
- **通用身份**：access token 按 JWT 解码（拆 `.` 取 payload base64url），取 `email` claim；无则不显示。
- 每分支 10s 超时，失败返回 `windows: []` 并尽量保留能取到的字段；整体 try/catch，不抛给渲染层。

## renderer

`OauthProvidersDialog`：`loggedIn` 条目挂载时并发拉取 accountInfo（缓存于组件 state，login done 后重拉该条），在 loginLabel 行下方显示：`email · plan`，及每个窗口一行小进度条（label + % + 重置时间，`Intl.DateTimeFormat` 短格式）。

## 权衡

- 端点均为各家非公开接口，随时可能变——所以全部 best-effort、静默降级，不做重试轮询（用户重开对话框即刷新）。
- copilot 额度需发探针请求且解析响应头，投入产出低，v1 不做；xai 无接口，仅 JWT 身份。
