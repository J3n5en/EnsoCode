---
name: enso-cdp
description: >
  Drive the EnsoCode Electron renderer via Chrome DevTools Protocol on port 9222.
  Use when verifying UI in the running app, sending a composer chat turn, reading
  conversation/timeline state, screenshots, CDP, 真机验证, remote-debugging-port,
  or after changing renderer/main/agent/preload. Use when the user runs /enso-cdp.
---

# EnsoCode CDP

Dev (`!app.isPackaged`) already opens **9222** in `src/main/index.ts`. Do not inject `TEMP-DEBUG`. Packaged builds stay closed.

## Scripts first

免依赖脚本在 `scripts/`（相对本 skill 目录），优先用它们，不要重写 connect 样板：

```bash
node scripts/cdp.mjs pages                          # 列出 page 目标
node scripts/cdp.mjs eval '(async()=>{...})()'      # 主窗口执行 JS（支持 await）
node scripts/cdp.mjs eval '...' --page settings.html # 设置窗口
node scripts/cdp.mjs shot /tmp/x.png                # 截图
node scripts/cdp.mjs keys ArrowDown Enter           # 受信任按键（真实输入管线）
node scripts/cdp.mjs type '@rev'                    # 受信任文本输入
node scripts/cdp.mjs drag '<fromJS>' '<toJS>'       # 受信任鼠标拖拽（from/to 为返回 {x,y} 的 JS）
```

合成事件（eval 里 dispatchEvent）`isTrusted=false` 且不过 IME/焦点管线；排查“真实键盘行为”用 `keys`/`type`。

## 鼠标拖拽 / 点击（Input.dispatchMouseEvent）

**窗口必须可见**：`document.visibilityState === 'hidden'`（窗口被遮挡/后台/另一 Space）时，
Chromium 会静默丢弃 CDP 的 `mousePressed`/`mouseReleased`（`mouseMoved` 照常送达）——
表现为拖拽/点击“时好时坏”，极易误判为产品 bug。`Page.bringToFront` 无效，要 OS 级激活：

```bash
osascript -e 'tell application "System Events" to set frontmost of (first process whose name contains "Electron") to true'
```

`cdp.mjs drag` 已内置这个检查与自动激活；手写鼠标序列时先 eval `document.visibilityState` 确认。

其它要点：
- dnd-kit 等 PointerSensor 库必须走真实指针管线；eval 里合成 PointerEvent/HTML5 drag 事件无效。
- 拖拽需要 press 后**分段** move（越过 activation 距离阈值），落点前悬停 ~150ms 让 droppable 识别。
- 拖到“拖动中才出现的落点”（如临时 drop bar）：先 press+小幅 move 激活拖拽，再 query 落点坐标继续 move。
- 验证断言别用 class 子串（如 `border-ring`）：Tailwind 的 `focus-within:border-ring` 会让 `className.includes()` 永真。

隔离验证环境（不碰真实 userData）：

```bash
node scripts/mk-env.mjs /tmp/enso-x 2      # 2 个 fake provider（凭证尾号可区分）
node <repo>/scripts/fake-provider-issue-27.mjs &   # 8899；支持 [[tool:name {json}]] 指令
ENSO_USER_DATA_DIR=/tmp/enso-x pnpm dev
curl -s http://127.0.0.1:8899/__requests   # 每个请求实际带的凭证尾号
```

常用 store 入口（eval 里）：`window.__stores.sessions.getState()` / `window.__stores.settings.getState()`；`window.electronAPI.*` 是 preload API。

## Connect（手写时才看）

1. `pnpm dev` is running.
2. `curl -s http://127.0.0.1:9222/json/version` — if this fails, restart dev (port is not HMR).
3. Pick **`type === "page"`**, not `json/list[0]` (a `browser` target may come first). Main window is `http://localhost:5173/index.html`.

```bash
curl -s http://127.0.0.1:9222/json/list \
  | python3 -c "import json,sys; d=json.load(sys.stdin); p=next(x for x in d if x.get('type')=='page'); print(p['webSocketDebuggerUrl'])"
```

Node ≥ 22 has global `WebSocket`. Enable CDP, then evaluate with monotonic ids:

```js
await send('Runtime.enable');
async function evalExpr(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
  return res.result?.result?.value;
}
```

`send` must map replies by `id`. Renderer vite root is `src/renderer`: dynamic import `/stores/...`, never `/src/renderer/stores/...`.

## Read

- Live chat: `document.body.innerText` (tail `slice(-1200)` for the latest turn). Messages are **not** in localStorage.
- Metadata only: `localStorage['enso-conversations']` — `messages` is always `[]`.
- Composer: `document.querySelector('textarea')`.
- Diff widgets: read `el.shadowRoot`, not light DOM.
- Viewport: chat scroller is `[data-slot=scroll-area-viewport]`, not `window`.
- Screenshot: `Page.captureScreenshot` `{ format: 'png' }`.

## Send (composer)

Controlled React textarea: assigning `.value` does not update state. Native setter + `input` + Enter (no Shift):

```js
await evalExpr(`(() => {
  const ta = document.querySelector('textarea');
  const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
  proto.set.call(ta, 'YOUR_PROMPT');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  ta.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true,
  }));
  return ta.value;
})()`);
```

Wait **5–25s** for the turn, then read the text tail. Do not assert immediately.

Failed assistant text stays in the transcript. Judge “no error” on **new timestamps** or the tail, not the whole `innerText`.

## After code changes

- Renderer: HMR.
- `src/main` / `src/agent` / `src/preload`: restart `pnpm dev` or CDP is still the old worker.

Do not leave test sessions, scratch scripts, or mutated `settings.json` / `userData` behind. Backup real user files before touching them; restore and checksum after.
