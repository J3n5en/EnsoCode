# 开发调试：CDP 连接 renderer

开发环境（`!app.isPackaged`）下，主进程在 `src/main/index.ts` 里开放了 Chrome DevTools Protocol 端口 **9222**（打包后不开）。可用它连上运行中的 renderer，直接读状态、驱动交互、截图，无需改代码埋日志。

## 前置

- 跑起 dev：`pnpm dev`
- 确认端口：`curl -s http://127.0.0.1:9222/json/version`
- 取 **page** 的 WebSocket 地址（不要默认 `json/list[0]`，列表里可能有 `browser` 等非页面目标）：

```bash
curl -s http://127.0.0.1:9222/json/list \
  | python3 -c "import json,sys; d=json.load(sys.stdin); p=next(x for x in d if x.get('type')=='page'); print(p['webSocketDebuggerUrl'])"
```

主窗口 renderer 一般是 `http://localhost:5173/index.html`。

## 执行表达式（Runtime.evaluate）

Node ≥ 22 自带全局 `WebSocket`，无需装 `ws`。多步求值必须自己分配递增 `id`，并先 `Runtime.enable`：

```js
// cdpx.mjs —— 单次：node cdpx.mjs <wsUrl> "<js 表达式>"
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

连续发送 / 等待回复时用会话式求值器（消息可能乱序，按 id 对账）：

```js
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  const n = ++id;
  ws.send(JSON.stringify({ id: n, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(n, { resolve, reject });
    setTimeout(() => reject(new Error('timeout ' + method)), 20000);
  });
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg);
    pending.delete(msg.id);
  }
};
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
await send('Runtime.enable');
async function evalExpr(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
  return res.result?.result?.value;
}
```

## 读

```bash
# 持久化元数据（messages 不进 storage，恒为 []）
node cdpx.mjs "$WS" "(()=>{const s=JSON.parse(localStorage.getItem('enso-conversations')).state;return JSON.stringify({active:s.activeId,count:Object.keys(s.conversations).length})})()"

# 点击某个会话 / 工具行（用文本定位）
node cdpx.mjs "$WS" "[...document.querySelectorAll('div.cursor-pointer')].find(e=>e.textContent.includes('标题')).click()"
```

对话内容在内存 zustand，不在 localStorage。要看当前屏：

```js
await evalExpr(`document.body.innerText.slice(0, 2500)`);
// 只看尾部（最新一轮）
await evalExpr(`document.body.innerText.slice(-1200)`);
```

composer 输入框：

```js
await evalExpr(`document.querySelector('textarea')?.placeholder`);
```

## 发（往 composer 打字并发送）

输入框是 React 受控 `textarea`，直接 `textarea.value = '...'` **不会**进 React state。必须走原生 setter + `input`，再合成 Enter：

```js
await evalExpr(`(() => {
  const ta = document.querySelector('textarea');
  const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
  proto.set.call(ta, 'Reply with only the word pong');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  ta.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true,
  }));
  return ta.value;
})()`);
```

然后 **等一轮结束再读**（模型调用常要 5–25s，不要立刻断言）：

```js
await new Promise((r) => setTimeout(r, 12000));
const tail = await evalExpr(`document.body.innerText.slice(-800)`);
```

Composer 里 Enter 且不按 Shift 会 `handleSend`；合成 `KeyboardEvent` 即可，不必点发送按钮。

## 注意事项

- **live 状态 vs localStorage**：消息内容只在内存的 zustand store，`localStorage` / `settings.json` 只存元数据。要看消息用 DOM（`[data-slot="scroll-area-viewport"]` 或 `document.body.innerText`）。
- **web component 的 shadow DOM**：`@pierre/diffs` 的 `<diffs-container>` 内容在 `shadowRoot` 里，`textContent`/`innerHTML` 读 light DOM 会是空的，要读 `el.shadowRoot`。
- **IntersectionObserver 的 root**：聊天滚动容器是内层 `[data-slot=scroll-area-viewport]`，判断元素是否“出视口”要以它为准，不是 window。
- **main/agent 进程不热重载**：改了 `src/main` / `src/agent` / `src/preload` 必须重启 `pnpm dev` 才生效；renderer 改动走 HMR。否则 CDP 测的仍是旧 worker（agent 工具/桥接尤其容易被这个假象掩盖）。
- **历史报错还在 DOM**：失败过的 assistant 文本会留在会话里。断言「没有 Bridge connection lost」时要带上**新时间戳**或只看 `innerText` 尾部，避免把上一轮错误当成本轮失败。
- **截图**：`Page.captureScreenshot`（`format:'png'`，`result.data` 是 base64）。
- 用完记得清理注入的测试会话、临时脚本，不要把调试产物留在用户真实数据里。
