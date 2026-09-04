# agent worker 启动时未应用系统代理

## Goal

用户在设置里选「跟随系统代理」（默认值）时，pi 在 agent worker 里调用大模型的
`fetch` 必须真正经过系统代理。当前启动路径下 worker 直连，代理形同虚设。

## Background / 根因

- Main 进程 `ProxyConfig.initFromConfig()` 解析系统代理后 `pushWorker()` →
  `sendAgentCommand({type:'set-proxy-env'})`，但此刻 worker 尚未 fork，命令被静默丢弃。
- 之后 `startAgentWorker()` fork worker，env 里带了 `HTTP_PROXY/HTTPS_PROXY/NO_PROXY`，
  但 worker 入口（`src/agent/index.ts`）从不据此安装 undici dispatcher；
  `applyWorkerProxyEnv` 仅在收到 `set-proxy-env` 命令时调用。
- Node `fetch`（undici）默认不读取 `HTTP_PROXY` 环境变量 → worker 内所有 LLM 请求直连。
- 同样的丢失发生在 worker 崩溃重启后；`sendAgentCommand` 也不检查 `workerReady`，
  已 fork 未 spawn 的窗口内 postMessage 可能丢失。

## Requirements

- R1 worker 启动时根据继承的 `HTTP_PROXY/http_proxy`、`HTTPS_PROXY`、`NO_PROXY` 环境变量
  自举安装 undici 全局 dispatcher（复用 `applyWorkerProxyEnv`），无需等待 main 下发命令。
- R2 main 在 worker `spawn` 事件后补发一次当前代理 env（`set-proxy-env`），
  覆盖 fork 之后 main 侧代理又发生变化的窗口期，以及 worker 重启场景。
- R3 三种模式（system / none / custom）下，worker 的 dispatcher 与 main 保持一致：
  有代理 → `EnvHttpProxyAgent`；无代理 → 普通 `Agent`。
- R4 不改变现有 `set-proxy-env` 命令协议与 `ProxyConfig` 对外接口。

## Constraints

- 逻辑改动遵循 TDD：先写失败测试（`src/agent/proxyEnv.test.ts` /
  `src/main/services/agentHost` 相关），再实现。
- 小步提交，`pnpm typecheck && pnpm test && biome check` 通过。

## Acceptance Criteria

- [x] AC1 单测：`applyWorkerProxyEnv({})`（空 patch）在 `process.env.HTTP_PROXY` 已设时
  安装 `EnvHttpProxyAgent`；未设时安装普通 `Agent`。
- [x] AC2 单测：worker 入口启动路径会调用 `applyWorkerProxyEnv`（或等价的自举函数），
  以继承 env 为输入。
- [x] AC3 单测：`proxyEnvPatchFromEnv` 纯函数覆盖（`src/shared/proxy.test.ts`）；
  `startAgentWorker()` 的 spawn 补发因 agentHost 依赖 electron/`?modulePath` 未做单测，由 AC4 真机覆盖。
- [x] AC4 真机：系统代理开启、模式为「跟随系统代理」、冷启动后直接发一轮对话，
  代理软件（如 Clash）连接面板能看到 LLM 域名的请求经过代理。
- [x] AC5 真机：切到「不使用代理」后再发一轮，请求不再经过代理。
- [x] `pnpm typecheck && pnpm test` 通过（8 个失败文件为本机 Windows 既有失败，与本任务无关）；
  `biome check` 对本次改动文件仅报 CRLF 格式差异（本机 `core.autocrlf=true` 导致，全仓 646 处既有）。

## 真机验证记录

- 修复前 worker（PID 20728）连接 `198.18.0.9:443`（Clash fake-IP 直连，未经 127.0.0.1:7890）。
- 修复后重启，worker（PID 32584）LLM 连接为 `127.0.0.1:7890`。
- `proxy.apply({mode:"none"})` 后下一请求 `198.18.0.8:443` 直连；切回 system 后又回到 `127.0.0.1:7890`。
