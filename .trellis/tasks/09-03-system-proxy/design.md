# 系统设计：系统代理

## 行为差距

现在：没有任何 `setProxy` / dispatcher / 代理设置。只有启动前已有的 `HTTP_PROXY` 会被部分 Node 库碰巧使用。

目标：主进程在 ready 后按设置解析代理，并同步 Chromium session、undici 全局 dispatcher、进程 env；worker 启动时继承 env，运行中通过命令再刷一遍。

## 层边界

- **纯逻辑**（可单测）：PAC 字符串解析、`NO_PROXY` 合并、URL 校验、模式归一化、env patch 计算。放 `src/shared/proxy.ts`，不碰 electron / undici。
- **主进程编排**：`src/main/services/proxyConfig.ts` 调 Electron `session.setProxy` / `resolveProxy`，装 undici dispatcher，写 `process.env`。
- **渲染层**：设置字段 + 通用页控件；改值后走现有 persist，并额外通知主进程立即 apply。
- **worker**：fork 时吃父进程 env；另收一条 `set-proxy-env` 命令，在 utilityProcess 里改 env 并重装 dispatcher。

## 数据

`SettingsState` 新增：

- `proxyMode: 'system' | 'none' | 'custom'`，缺省 `'system'`
- `customProxyUrl: string`，缺省 `''`

走 zustand persist。`SETTINGS_STATE_FIELDS` 登记，便于 Enso `patchSettingsState`。
旧数据缺字段 = 系统代理。不必升 `SETTINGS_VERSION`（缺省与 migrate 等价）。

产品面：`general.proxy-mode`、`general.custom-proxy-url`。

## 解析流程

1. `none` → `setProxy({ mode: 'direct' })`，清 env，undici 普通 `Agent`
2. `custom` 且 URL 合法 → `setProxy({ proxyRules })`，dispatcher + env
3. `system` → `setProxy({ mode: 'system' })`，`resolveProxy('https://www.google.com')`
   - 首段 `PROXY host:port` / `HTTPS host:port` → `http(s)://host:port`
   - `DIRECT` 或无法映射 → 直连（清 env）
4. resolve 串行排队：后发起的模式覆盖先完成的过期结果
5. resolve 抛错：不重建 dispatcher

作用 session：`session.defaultSession` + 已创建的 browser guest session。

`NO_PROXY` 默认：`localhost, 127.0.0.1, ::1, 192.168.*.*, 10.*.*.*, *.local, host.docker.internal`，再并启动快照。

写入 env：`http_proxy` / `https_proxy` / `HTTP_PROXY` / `HTTPS_PROXY` / `GRPC_PROXY` / `grpc_proxy` / `no_proxy` / `NO_PROXY`。

## worker 同步

`utilityProcess.fork` 已 `...process.env`。启动顺序改为 `await proxyConfig.whenReady()` 后再 `startAgentWorker()`。

运行中：`AgentCommand` 增加 `set-proxy-env`：

```ts
{ type: 'set-proxy-env', env: Record<string, string | null> }
```

`null` 表示删除该键。worker 改 `process.env` 并 `setGlobalDispatcher`。MCP stdio 每次 spawn 读当前 `process.env`，无需重启会话。
**不**为改代理而重启 worker。

## IPC

`proxy:apply`：渲染层改模式/URL 后立刻调用。入参 `{ mode, customUrl }`。主进程校验后 `setProxyMode` / `setCustomProxyUrl` + `resolveProxy`，成功后再给 worker 发 `set-proxy-env`。

启动：`readSettings()` 读 persist，`initFromConfig`，不经 IPC。

## 明确不做

- SOCKS 的 Node fetch 隧道
- 自定义 PAC 文本
- 按 provider 分流代理
- 改 electron-updater 内部代理 API
- 把代理密码当密钥系统存（用户明文写在 settings 里，与 DeepChat 相同）
