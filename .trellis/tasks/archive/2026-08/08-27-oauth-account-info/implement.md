# 执行计划

小步提交；每步 `pnpm typecheck`。

## 1. shared
- [x] `oauthProviders.ts` 类型：`OauthUsageWindow` / `OauthAccountInfo`；`IPC_CHANNELS.OAUTH_ACCOUNT_INFO`

## 2. main
- [x] `services/oauthProviders.ts`：`getOauthAccountInfo(providerId)`（JWT 解码 helper、anthropic/codex 分支、10s 超时、静默降级）
- [x] `ipc/providers.ts` 注册 handler；preload 暴露 `oauthAccountInfo`

## 3. renderer
- [x] `OauthProvidersDialog`：已登录条目拉取并展示 email/plan/用量窗口；login done 后重拉
- [x] i18n 文案

## 4. 验证
- [x] `pnpm typecheck` + `pnpm lint`（无新增告警）
- [ ] 手动冒烟留待用户（需真实订阅账号）

## 回滚点
每步独立 commit，revert 即可。
