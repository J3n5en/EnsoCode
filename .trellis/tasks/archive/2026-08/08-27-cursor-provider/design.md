# 技术设计

## 调研已确认的事实

- 扩展 default export `WS(api)` 内部调用 `api.registerProvider('cursor', config)`，`config` 即 pi 的 `ProviderConfigInput`（含 `oauth`（ExtensionOAuthConfig）+ 自定义 `streamSimple` + dynamic `refreshModels` + fallback `models`）。喂给 `runtime.registerProvider('cursor', config)` 即可让 pi runtime 自行适配 OAuth（登录走 `runtime.login('cursor','oauth',interaction)`，与 xai/anthropic 一致）。
- 扩展还调 `api.on(...)`（session 生命周期清理）、`api.registerCommand('cursor.models/usage/doctor')`、`api.ui`——enso 不需要，shim 提供 no-op。
- 扩展直接从 `@earendil-works/pi-coding-agent` import `getAgentDir`/`readStoredCredential` 读凭证。`getAgentDir()` = 环境变量 `PI_CODING_AGENT_DIR`（APP_NAME=pi），默认 `~/.pi/agent`。**enso 必须设 `PI_CODING_AGENT_DIR = <userData>/agent/pi-agent`** 让扩展凭证读写对齐 enso 的 auth.json。现有 runtime 显式传 `authPath`，不受该 env 影响。
- 扩展另调 `registerApiProvider({api:'cursor-native',...}, '@rahularya01/pi-cursor')`（来自 `@earendil-works/pi-ai/compat`，全局注册流实现）。加载一次即可，避免重复。
- 依赖：`@bufbuild/protobuf`（扩展 dep）+ 扩展 peerDeps 已由 enso 满足（pi-ai/pi-coding-agent 在树内）。

## 架构

新增 `src/agent/cursorExtension.ts`（worker 侧）与在 main `oauthProviders.ts` 复用同一 loader：

```ts
let loaded = false;
export async function loadCursorProvider(runtime: ModelRuntime): Promise<void> {
  if (loaded) return; loaded = true;
  try {
    const mod = await import('@rahularya01/pi-cursor');
    const shim = {
      registerProvider: (id, config) => runtime.registerProvider(id, config),
      on: () => () => {}, registerCommand: () => {}, ui: {/* no-op */},
    };
    (mod.default as (api: unknown) => void)(shim);
  } catch (e) { /* best-effort：装缺/加载失败静默 */ }
}
```

- 两处 runtime（worker `supervisor.getRuntime`、main `oauthProviders.getRuntime`）在 `ModelRuntime.create` 后各调一次 `loadCursorProvider(runtime)`。各进程独立 runtime，各注册一次，幂等由模块级 `loaded` 保证。
- `registerApiProvider` 全局副作用在扩展内部只跑一次（模块单例）。

## 环境对齐

- worker：`agentHost.startAgentWorker` fork env 增 `PI_CODING_AGENT_DIR`。
- main：`oauthProviders` 首次 getRuntime 前 `process.env.PI_CODING_AGENT_DIR ??= <path>`。
- 两处 path 同源：`join(app.getPath('userData'),'agent','pi-agent')`。

## 登录 / spawn 复用

- 订阅登录列表：`listOauthProviders` 过滤 `auth.oauth` 的 provider——cursor 注册后自带 oauth，自动出现。models 初始可能空（dynamic），登录成功后 pi `refreshModels` 拉取；`OauthProviderInfo.models` 取 `getModels()` 快照，登录后重列即有。
- spawn：provider.oauthProviderId='cursor' → 复用 `resolveBaseModel` 的 oauth 分支 `runtime.getModel('cursor', modelId)`。cursor 模型可能需先 `runtime.getAvailable('cursor')`/refresh 才进 catalog——如取不到，spawn 前对 oauth provider 调一次 refresh（待实现验证）。

## 风险与验证

1. 扩展在 electron utilityProcess 能否正常运行（http2/async_hooks/protobuf 均 node 内置，electron 支持，需实跑）。
2. 首个里程碑：node 环境 import 扩展 + shim 注册，确认 `getProvider('cursor')` 存在且 `getModels()` 返回 fallback 列表——不需真实账号。
3. 端到端（登录+对话）需真实 Cursor 账号，留用户冒烟。
4. 供应链：引入非官方逆向包进 dependencies，design 已标注，锁 lockfile 版本。

## 回滚

扩展加载全 try/catch，失败静默；卸载依赖 + revert 提交即可完全移除。
