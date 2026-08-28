# 技术设计

## 架构结论

- pi `ModelRuntime` 的 `CredentialStore` 是文件锁保护的 auth.json，明确支持跨进程互斥。因此 **Main 进程自建一个 runtime 实例专做认证操作**（login/logout/状态/catalog），与 agent worker 的 runtime 指向同一 `authPath`；worker 在每次请求时经 `getAuth` 从 store 解析凭证，登录后无需重启 worker。
- OAuth 会话请求不注入 `ENSO_USER_AGENT`：pi 的 api 层默认 `User-Agent: getPiUserAgent()`（`model.headers` 可覆盖，不覆盖即原生），走内置 provider 路径天然满足。

## 分层改动

### shared

- `ModelProvider` 新增 `oauthProviderId?: string`——存在即 OAuth 订阅条目，此时 `apiKey`/`baseUrl` 为空串，`api` 填 catalog 首模型的 api（仅展示用）。
- `SpawnModelConfig` 新增 `oauthProviderId?: string`。
- 新传输类型（`src/shared/types/oauthProviders.ts`）：
  - `OauthProviderInfo { id, name, loginLabel?, loggedIn, models: { id, api }[] }`
  - `OauthLoginPrompt { requestId, type: 'text'|'secret'|'select'|'manual_code', message, placeholder?, options? }`
  - `OauthLoginEvent`（main → renderer 单向推送）：`info | auth_url | device_code | progress | prompt | done | error`
- `IPC_CHANNELS` 新增：`OAUTH_PROVIDERS_LIST` / `OAUTH_LOGIN` / `OAUTH_LOGIN_RESPOND` / `OAUTH_LOGIN_CANCEL` / `OAUTH_LOGOUT`，事件通道 `OAUTH_LOGIN_EVENT`。

### main：`src/main/services/oauthProviders.ts`（新）

- 懒建 `ModelRuntime.create({ authPath: join(userData,'agent','pi-agent','auth.json'), modelsPath: null, refreshOnCreate: false })`。
- `list()`：`getProviders()` 过滤含 `auth.oauth` 的内置 provider，附 `hasConfiguredAuth`+`isUsingOAuth` 得出 `loggedIn`，模型取 `getModels(providerId)`。
- `login(providerId, webContents)`：`runtime.login(providerId, 'oauth', interaction)`。
  - `interaction.notify`：`auth_url` 事件先 `shell.openExternal(url)`，全部事件转发 renderer。
  - `interaction.prompt`：生成 requestId 发 renderer，挂起 Promise 等 `OAUTH_LOGIN_RESPOND`；`AuthPrompt.signal` 中止时取消该挂起。
  - 同一时刻仅允许一个进行中的 login；`OAUTH_LOGIN_CANCEL` 触发 AbortController。
  - 完成/失败发 `done`/`error` 事件。
- `logout(providerId)`：`runtime.logout`。
- IPC handler 扩展在 `src/main/ipc/providers.ts`；preload 暴露 `providers.oauth*` 方法与事件订阅。

### agent worker

- `supervisor.spawn`：`model.oauthProviderId` 存在时走新分支——不 `registerProvider`，直接 `runtime.getModel(oauthProviderId, model.modelId)`（取不到即抛错），后续 per-session 克隆 + `applyReasoningToModel` 复用现逻辑。内置 catalog 模型自带 contextWindow/cost/thinkingLevelMap，不用 enso 常量。
- subagent 绑定模型（`AgentTypeSpawnConfig.model`）同分支处理。

### main：`agentHost.spawnSession`

- provider 带 `oauthProviderId` → `model = { api, baseUrl: '', apiKey: '', modelId, oauthProviderId }`。

### renderer

- `ProvidersSettings`：按钮区新增「订阅登录」，打开新 `OauthProvidersDialog`。
- `OauthProvidersDialog`（新）：列出 `OauthProviderInfo`（名称 + loginLabel + 状态），登录/退出按钮；登录中内嵌进度区展示事件流，prompt 渲染输入框/选项并回传。登录成功后把条目写入 settings（`oauthProviderId`、catalog 模型、`enabled: true`），已存在则刷新其 models。
- `ProviderEditDialog`：`provider.oauthProviderId` 存在时隐藏 API type/baseUrl/apiKey/Fetch models/Test connection，仅保留名称与模型开关。
- settings store `addProviders` 指纹：oauth 条目改用 `oauth::<oauthProviderId>`，避免空 baseUrl+apiKey 互撞。

## 权衡与风险

- Main 进程引入 pi-coding-agent 会增大 main bundle；换来登录不依赖 worker 存活、实现最简。可接受。
- 内置 catalog 可能缺用户想用的模型：v1 不支持 OAuth 条目手填模型 id（getModel 取不到即失败），后续可加。
- 双 runtime 并发刷新 token 由 pi 文件锁保证串行，无需 enso 额外协调。

## 回滚

单 feature 分支式提交序列，revert 对应 commit 即可；不迁移持久化数据（`oauthProviderId` 为可选字段，旧数据天然兼容）。
