# 实现清单

验证：`pnpm typecheck && pnpm test`；改协议后必跑 `src/shared/types/agent.test.ts`。

## 刀 1 — 宿主 + 无头工具（agent 能测 localhost）

1. **RED** `src/shared/browser/urlPolicy.test.ts`：`assertAllowedUrl`
2. **GREEN** `src/shared/browser/urlPolicy.ts`
3. **RED** snapshot/ref 编解码测试
4. **GREEN** `src/shared/browser/snapshot.ts`（纯函数，不碰 Electron）
5. **RED** `parseBrowserInvoke` / `parseBrowserResult` 脏输入（扩 `agent.test.ts`）
6. **GREEN** `src/shared/types/agent.ts` 加 `browser-invoke` 事件、`browser-result` 命令；解析器三处对齐
7. `src/main/services/browserHost.ts`：partition、tab 表、navigate/snapshot/click/type/screenshot/close、flush、clear*
8. Main 收 `browser-invoke`（`agent.ts` 或独立桥，仿 `capability-invoke`），回 `browser-result`
9. Worker：`src/agent/tools/browser.ts` + supervisor 注入 + 等 result 超时
10. 设置：`clearCookies` / `clearCache` / `clearAllData` 先可只走临时 IPC 或设置页按钮（没有面板也能清）

关卡：本地静态页，worker 单测用 fake invoke；真机 dev 里手动 `browser_navigate` localhost。

回滚点：revert 协议分支 + 不注册工具；partition 目录可留。

## 刀 2 — 可见面板

1. 主窗口容器 + 把 bounds IPC 给 BrowserHost
2. `IPC_CHANNELS` + `ipc/browser.ts` + preload `electronAPI.browser`
3. 用户能在面板登录；重启后 Cookie 还在（手验）

## 刀 3 — 产品收口

1. `browser_tabs` / `browser_lock`
2. 回合结束关未锁无头 tab
3. 无头上限
4. spec：`windows.md` 补 guest view；`services.md` 补 BrowserHost

## 不要做

- Playwright MCP、Chrome 扩展、裸 CDP 工具
- 把 guest 建成 `createAppWindow` 窗口
- 把浏览塞进 capabilityGateway

## 建议提交切分

1. `feat(shared): browser url policy + snapshot refs`
2. `feat(agent): browser-invoke protocol`
3. `feat(main): BrowserHost persist session`
4. `feat(agent): builtin browser_* tools`
5. `feat(renderer): in-app browser pane`（刀 2）
6. `docs(spec): guest BrowserView`（刀 3）
