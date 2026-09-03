# 实施清单

## 0. 变更边界

- 行为：无系统代理处理 → 默认跟随 OS，并同步 session / fetch / env / worker
- 逻辑住在 `shared/proxy.ts` + `main/services/proxyConfig.ts`
- 不做：SOCKS Node 隧道、PAC 编辑器、updater 专用代理 API

## 1. TDD（shared 纯函数）

coworker 角色分离：测试先行者只写 `src/shared/proxy.test.ts`，确认红灯；主会话只写实现。

覆盖：

- `parseResolveProxy`：`DIRECT` / `PROXY` / `HTTPS` / 多规则取首段 / 空串
- `mergeNoProxy`：默认 + 继承去重，空继承原样
- `isValidProxyUrl`：http(s) 合法、缺 scheme、空串
- `normalizeProxyMode`：脏值回 `system`
- `proxyEnvPatch`：写入与清除的键集合

`pnpm exec vitest run src/shared/proxy.test.ts` 先红后绿。

## 2. 主进程编排

- 加依赖 `undici`
- `src/main/services/proxyConfig.ts`：排队 resolve、session 列表、dispatcher、env commit
- `test/stubs/electron.ts` 补 `session.defaultSession.setProxy/resolveProxy`
- `src/main/index.ts`：ready 后 `initFromConfig`，`whenReady` 后再 fork worker
- `browserHost.getSession()` 创建后登记到 proxyConfig
- `src/main/ipc/proxy.ts` + `IPC_CHANNELS.PROXY_APPLY` + preload

## 3. worker

- `AgentCommand` / `parseAgentCommand` 增加 `set-proxy-env`
- supervisor 旁路串行门，立刻改 env + dispatcher
- `agentHost` 在 resolve 完成后 postMessage

## 4. 设置与 Enso

- `SettingsState` 字段 + setter + initialState
- `SETTINGS_STATE_FIELDS`
- `GeneralSettings` 增加代理小节
- `src/shared/i18n.ts` 中文
- product surface / catalog / gateway / coverage fixture
- Enso 改 mode/url 后走同一 apply（gateway handler 调 `proxyConfig`，不要只写盘）

## 5. 验证

```bash
pnpm typecheck && pnpm lint && pnpm test
```

## 回滚

删除 `shared/proxy.ts`、`main/services/proxyConfig.ts`、IPC/设置字段即可回到直连。settings 里多出来的字段无害。
