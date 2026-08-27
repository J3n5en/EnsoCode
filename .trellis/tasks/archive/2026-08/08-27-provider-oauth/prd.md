# Provider 支持 OAuth 订阅登录

## 背景

Provider 目前只支持静态 API key。底层 pi `ModelRuntime` 已内建 OAuth 能力（内置 provider 目录、login/refresh/credential store），enso 未暴露。用户希望能直接用 SuperGrok/X Premium、Claude Pro/Max、ChatGPT 订阅等 OAuth 认证。

## 需求

1. 设置页可查看 pi 内置的 OAuth provider 列表（xai、anthropic、openai-codex、github-copilot、kimi-coding、openrouter 等），并完成登录/退出。
2. 登录流程支持 pi 的全部交互形态：auth_url（自动开浏览器）、device_code（展示用户码）、manual_code/text/secret prompt（弹输入框）、progress 消息。
3. 登录成功的 OAuth provider 出现在 provider 列表，可与 API key provider 一样被会话选用；模型列表来自 pi 内置 catalog。
4. OAuth 请求的 User-Agent 按 pi 原生实现（不套用 ENSO_USER_AGENT 伪装）。
5. 凭证存储与 agent worker 共用同一 auth.json（`<userData>/agent/pi-agent/auth.json`），token 刷新由 pi runtime 处理。

## 验收标准

1. 设置页能列出可 OAuth 登录的内置 provider 及其登录状态。
2. 以 xai 为例：点登录 → 浏览器打开授权页 → 完成后应用内显示已登录，provider 条目自动入库并带 catalog 模型。
3. 用该 provider 新建会话能正常对话；请求 UA 为 pi 原生。
4. 退出登录后凭证删除，条目状态更新。
5. API key provider 的既有流程（导入/手动添加/编辑/spawn）不受影响。
6. `pnpm typecheck` 通过。
