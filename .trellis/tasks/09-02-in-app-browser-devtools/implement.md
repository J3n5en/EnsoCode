# 实现清单

1. 纯函数：`parseBrowserViewport` 保持；新增 `devtoolsBusyError` / 互斥判断可测字符串（TDD）。
2. `IPC_CHANNELS` + coverage fixture 排除项。
3. `BrowserTabState.devtoolsOpen`。
4. `browserHost`：DevTools view、setDevTools、双 viewport、destroy 清理、cdp 互斥。
5. `ipc/browser.ts` handler。
6. preload `browser.setDevTools` / `setDevToolsViewport`。
7. `BrowserView`：开关、分割条、第二洞。
8. i18n：Toggle Developer Tools / Developer Tools。
9. `pnpm typecheck && pnpm test`；真机：开控制台看 Elements/Console/Network。

回滚：删通道 + host DevTools view + 面板 UI。
