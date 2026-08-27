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

## Connect

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
