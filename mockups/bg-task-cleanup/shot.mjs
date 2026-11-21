// 用法：node mockups/bg-task-cleanup/shot.mjs [输出目录=/tmp]
// 无头 Chrome 打开 site/*.html（浅色与 #dark），按 #page 的尺寸截 2x PNG：bg-cleanup-mockup-<id>-<theme>.png
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, 'site');
const out = process.argv[2] ?? '/tmp';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9341;

const proc = spawn(chrome, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'bg-mockup-'))}`,
  '--hide-scrollbars',
  '--no-first-run',
  'about:blank',
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('chrome 未就绪');
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((r, j) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? j(new Error(`${method}: ${m.error.message}`)) : r(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });

try {
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });
  const ids = readdirSync(site)
    .filter((f) => /^[A-Z]\.html$/.test(f))
    .map((f) => f[0]);
  for (const id of ids) {
    for (const theme of ['light', 'dark']) {
      const url = pathToFileURL(join(site, `${id}.html`)).href + (theme === 'dark' ? '#dark' : '');
      await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: theme }],
      });
      await send('Page.navigate', { url: 'about:blank' });
      await send('Page.navigate', { url });
      await sleep(700);
      const { result } = await send('Runtime.evaluate', {
        expression:
          'JSON.stringify((() => { const r = document.getElementById("page").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, dark: document.documentElement.classList.contains("dark") }; })())',
        returnByValue: true,
      });
      const box = JSON.parse(result.value);
      if (box.dark !== (theme === 'dark')) throw new Error(`${id} 主题未生效`);
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
      });
      const file = join(out, `bg-cleanup-mockup-${id}-${theme}.png`);
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log(file, `${Math.round(box.width)}x${Math.round(box.height)}`);
    }
  }
} finally {
  ws.close();
  proc.kill();
}
