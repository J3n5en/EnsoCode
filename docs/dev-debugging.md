# 开发调试：CDP 连接 renderer

开发环境（`!app.isPackaged`）下，主进程在 `src/main/index.ts` 里开放了 Chrome DevTools Protocol 端口 **9222**（打包后不开）。可用它连上运行中的 renderer，直接读状态、驱动交互、截图，无需改代码埋日志。

## 前置

- 跑起 dev：`pnpm dev`
- 确认端口：`curl -s http://127.0.0.1:9222/json/version`
- 取 renderer 的 WebSocket 调试地址：

```bash
curl -s http://127.0.0.1:9222/json/list \
  | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['webSocketDebuggerUrl'])"
```

## 执行表达式（Runtime.evaluate）

Node ≥ 22 自带全局 `WebSocket`，无需装 `ws`。一个最小求值器：

```js
// cdpx.mjs —— node cdpx.mjs <wsUrl> "<js 表达式>"
const ws = new WebSocket(process.argv[2]);
const expr = process.argv[3];
ws.addEventListener('open', () =>
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
    params: { expression: expr, returnByValue: true, awaitPromise: true } })));
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id === 1) { console.log(JSON.stringify(m.result?.result?.value ?? m.result?.exceptionDetails?.text ?? null)); process.exit(0); }
});
ws.addEventListener('error', () => process.exit(1));
```

常用查询：

```bash
# 读会话 store 持久化元数据（注意：messages 不进 localStorage，恒为 []）
node cdpx.mjs "$WS" "(()=>{const s=JSON.parse(localStorage.getItem('enso-conversations')).state;return JSON.stringify({active:s.activeId,count:Object.keys(s.conversations).length})})()"

# 点击某个会话 / 工具行（用文本定位）
node cdpx.mjs "$WS" "[...document.querySelectorAll('div.cursor-pointer')].find(e=>e.textContent.includes('标题')).click()"
```

## 注意事项

- **live 状态 vs localStorage**：消息内容只在内存的 zustand store，`localStorage` 只存元数据。要看消息用 DOM（`[data-slot=\"scroll-area-viewport\"]`）。
- **web component 的 shadow DOM**：`@pierre/diffs` 的 `<diffs-container>` 内容在 `shadowRoot` 里，`textContent`/`innerHTML` 读 light DOM 会是空的，要读 `el.shadowRoot`。
- **IntersectionObserver 的 root**：聊天滚动容器是内层 `[data-slot=scroll-area-viewport]`，判断元素是否“出视口”要以它为准，不是 window。
- **main/agent 进程不热重载**：改了 `src/main` / `src/agent` / `src/preload` 必须重启 `pnpm dev` 才生效；renderer 改动走 HMR。
- **截图**：`Page.captureScreenshot`（`format:'png'`，`result.data` 是 base64）。
- 用完记得清理注入的测试会话、临时脚本，不要把调试产物留在用户真实数据里。
