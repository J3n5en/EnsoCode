#!/usr/bin/env node
// EnsoCode CDP 驱动脚本（免依赖，node >= 22）。用法：
//   node cdp.mjs pages                          列出可连接的 page 目标
//   node cdp.mjs eval '<js>' [--page settings]  在页面里执行 JS（支持 await/Promise）
//   node cdp.mjs shot /tmp/x.png [--page ...]   截图存文件
//   node cdp.mjs keys ArrowDown ArrowDown Enter 受信任按键（走浏览器真实输入管线）
//   node cdp.mjs type '@rev'                    受信任文本输入（Input.insertText）
//   node cdp.mjs drag '<fromJS>' '<toJS>'       受信任鼠标拖拽（press→分段move→release）
//     from/to 是返回 {x,y} 的 JS 表达式，如 '(()=>{const r=document.querySelector("x").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()'
// --page 匹配 URL 子串，缺省 index.html（主窗口）；设置窗口用 --page settings.html。
//
// 何时用 keys/type 而非 eval 里的合成事件：合成 KeyboardEvent 的 isTrusted=false，
// 且不经过 IME/焦点管线；排查"真实键盘行为"必须用受信任事件。

const args = process.argv.slice(2);
const cmd = args[0];
const pageFlag = args.indexOf('--page');
const urlFilter = pageFlag !== -1 ? args[pageFlag + 1] : 'index.html';
const rest = (pageFlag !== -1 ? args.slice(0, pageFlag) : args).slice(1);

if (!cmd || !['pages', 'eval', 'shot', 'keys', 'type', 'drag'].includes(cmd)) {
  console.error('usage: cdp.mjs pages|eval|shot|keys|type|drag ... [--page <urlSubstring>]');
  process.exit(2);
}

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json().catch(() => null);
if (!list) {
  console.error('CDP 不可达：确认 pnpm dev 在跑（9222 不是 HMR，改了 main/agent 要重启）');
  process.exit(2);
}
if (cmd === 'pages') {
  for (const t of list.filter((x) => x.type === 'page')) console.log(t.url);
  process.exit(0);
}
const page = list.find((x) => x.type === 'page' && x.url.includes(urlFilter));
if (!page) {
  console.error(`NO_PAGE for "${urlFilter}"，可用：`);
  for (const t of list.filter((x) => x.type === 'page')) console.error(' ', t.url);
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

try {
  if (cmd === 'eval') {
    await send('Runtime.enable');
    const r = await send('Runtime.evaluate', {
      expression: rest[0],
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) {
      console.error('EXC', JSON.stringify(r.result.exceptionDetails).slice(0, 2000));
      process.exit(1);
    }
    const v = r.result?.result?.value;
    console.log(typeof v === 'string' ? v : JSON.stringify(v));
  } else if (cmd === 'shot') {
    const out = rest[0] || '/tmp/enso-shot.png';
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log(out);
  } else if (cmd === 'keys') {
    // 常用键的 keyCode 映射；其余按 key 名直接发（现代前端多读 event.key）
    const CODES = {
      ArrowDown: 40,
      ArrowUp: 38,
      ArrowLeft: 37,
      ArrowRight: 39,
      Enter: 13,
      Escape: 27,
      Tab: 9,
      Backspace: 8,
    };
    for (const key of rest) {
      const keyCode = CODES[key];
      const base = {
        key,
        code: key,
        ...(keyCode ? { windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode } : {}),
      };
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await new Promise((r) => setTimeout(r, 120));
    }
    console.log('sent:', rest.join(' '));
  } else if (cmd === 'type') {
    await send('Input.insertText', { text: rest[0] ?? '' });
    console.log('typed');
  } else if (cmd === 'drag') {
    // 陷阱：窗口被遮挡/后台（document.visibilityState === 'hidden'）时，
    // Chromium 会丢弃 CDP 的鼠标按键事件（move 照常送达），拖拽/点击静默失效。
    // 这里先检查并尝试把 Electron 带到前台（macOS）。
    await send('Runtime.enable');
    const evalJson = async (expr) => {
      const r = await send('Runtime.evaluate', {
        expression: `JSON.stringify((${expr}))`,
        returnByValue: true,
      });
      if (r.result?.exceptionDetails) {
        console.error('EXC', JSON.stringify(r.result.exceptionDetails).slice(0, 800));
        process.exit(1);
      }
      return JSON.parse(r.result.result.value);
    };
    if ((await evalJson('document.visibilityState')) === 'hidden') {
      if (process.platform === 'darwin') {
        const { execSync } = await import('node:child_process');
        try {
          execSync(
            `osascript -e 'tell application "System Events" to set frontmost of (first process whose name contains "Electron") to true'`
          );
          await new Promise((r) => setTimeout(r, 500));
        } catch {
          /* 降级到下面的硬错误提示 */
        }
      }
      if ((await evalJson('document.visibilityState')) === 'hidden') {
        console.error('窗口 hidden：鼠标按键事件会被丢弃，先把 EnsoCode 窗口带到前台再重试');
        process.exit(1);
      }
    }
    const from = await evalJson(rest[0]);
    const to = await evalJson(rest[1]);
    const mouse = (type, x, y, extra = {}) =>
      send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        buttons: 1,
        clickCount: type === 'mouseMoved' ? 0 : 1,
        pointerType: 'mouse',
        ...extra,
      });
    await mouse('mouseMoved', from.x, from.y, { buttons: 0 });
    await mouse('mousePressed', from.x, from.y);
    // 分段移动：dnd-kit PointerSensor 需要超过 activation 阈值的连续真实移动
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 150)); // 悬停让 droppable 识别
    await mouse('mouseReleased', to.x, to.y, { buttons: 0 });
    await new Promise((r) => setTimeout(r, 200));
    console.log('dragged', JSON.stringify(from), '->', JSON.stringify(to));
  }
} finally {
  ws.close();
}
