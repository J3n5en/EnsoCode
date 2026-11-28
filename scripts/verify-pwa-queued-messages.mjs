#!/usr/bin/env node
// PWA 完整模式（/desk）里排队的消息能否同步到桌面并在轮次结束后自动发出。
//   pnpm build && (cd packages/phone && pnpm build) && node scripts/verify-pwa-queued-messages.mjs
// 拓扑同用户：隔离 userData 的桌面实例 A（ENSO_VERIFY，leader）经本地 relay-go 配对一个无头浏览器 B
// （/desk 完整模式，非 leader，禁用 WebRTC 只走中继）。模型用 scripts/fake-provider-issue-27.mjs。
// A 发一条慢回复让会话跑起来；B 排队一条消息时中继被 SIGSTOP（手机弱网/锁屏），
// 等这一轮在桌面收束后再放行，B 的排队写回晚于收束到达：
//   1. A 的界面出现这条排队消息；
//   2. 模型收到这条排队消息（fake provider 请求记录为准）；
//   3. 发出后 B 的排队条与磁盘行的 queuedMessages 都清空。
// --no-stall：不卡中继，排队写回在轮次进行中到达（对照组）。KEEP_OUT=1 保留隔离目录。
// 3 分钟硬超时；跑完杀子进程并删掉隔离目录。退出码：全部成立为 0，否则 1。

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uiElementElectron } from './verify-electron.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STALL = !process.argv.includes('--no-stall');
const OUT = mkdtempSync(path.join(os.tmpdir(), 'enso-pwa-queue-'));
const USER_DATA = path.join(OUT, 'userData');
const PROJ = path.join(OUT, 'proj');
const KEEP = process.env.KEEP_OUT === '1';
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(PROJ, { recursive: true });

const SLOW_MS = 6000;
const FIRST = `pwaq-first [[slow:${SLOW_MS}]]`;
const QUEUED = 'pwaq-queued-from-pwa';

const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => console.log(line);

function shutdown(code) {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
  if (KEEP) log(`kept ${OUT}`);
  else rmSync(OUT, { recursive: true, force: true });
  process.exit(code);
}

const hardTimeout = setTimeout(() => {
  console.error('hard timeout (180s)');
  shutdown(1);
}, 180_000);
hardTimeout.unref();

async function waitFor(fn, { timeout = 30_000, interval = 300, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(interval);
  }
  throw new Error(
    `timeout waiting for ${label}${last instanceof Error ? `: ${last.message}` : last ? `: ${JSON.stringify(last).slice(0, 400)}` : ''}`
  );
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

class Cdp {
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`ws open failed ${wsUrl}`));
    });
    return new Cdp(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const done = message.id && this.pending.get(message.id);
      if (!done) return;
      this.pending.delete(message.id);
      done(message);
    };
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp ${method} timeout`));
      }, 20_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)
      );
    }
    return result.result?.value;
  }
}

const HEADLESS_SHELL = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
);

/** PWA 端：独立 user-data-dir 的无头浏览器 */
async function launchBrowser(name) {
  if (!existsSync(HEADLESS_SHELL)) throw new Error(`missing chromium ${HEADLESS_SHELL}`);
  const debugPort = await freePort();
  const userDir = path.join(OUT, `chrome-${name}`);
  mkdirSync(userDir, { recursive: true });
  const logFd = openSync(path.join(OUT, `chromium-${name}.log`), 'a');
  const child = spawn(
    HEADLESS_SHELL,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDir}`,
      '--window-size=1280,860',
      '--no-first-run',
      'about:blank',
    ],
    { stdio: ['ignore', logFd, logFd] }
  );
  children.push(child);
  const pageTarget = await waitFor(
    async () => {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      return list.find((t) => t.type === 'page');
    },
    { label: `chromium ${name}` }
  );
  const cdp = await Cdp.open(pageTarget.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // 不走 WebRTC 直连：同机直连会绕过中继，卡中继就模拟不了手机弱网
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.RTCPeerConnection = undefined;',
  });
  return cdp;
}

const FRAME_DOC = `(document.querySelector('iframe.main')?.contentDocument ?? document)`;

async function frame(cdp, source) {
  return cdp.eval(`(async () => {
    const doc = ${FRAME_DOC};
    const view = doc.defaultView;
    if (!view) return { error: 'no view' };
    try {
      return await (async () => {
        ${source}
      })();
    } catch (error) {
      return { error: String(error && error.stack ? error.stack : error) };
    }
  })()`);
}

function prepareProject() {
  writeFileSync(path.join(PROJ, 'README.md'), 'pwa queue target\n');
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: PROJ, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} ${result.stderr}`);
  };
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init']);
}

function writeSettings(providerPort) {
  const state = {
    providers: [
      {
        id: 'pv-A',
        name: 'Provider A',
        api: 'anthropic-messages',
        apiKey: 'sk-fake-A',
        baseUrl: `http://127.0.0.1:${providerPort}`,
        enabled: true,
        models: [{ id: 'fake-model-1' }],
      },
    ],
    defaultModel: { providerId: 'pv-A', modelId: 'fake-model-1' },
    onboarded: true,
    language: 'zh',
    theme: 'light',
    projects: [{ id: randomUUID(), name: 'pwa-queue', path: PROJ }],
  };
  writeFileSync(
    path.join(USER_DATA, 'settings.json'),
    JSON.stringify({ 'enso-settings': { state, version: 18 } })
  );
}

async function startProvider() {
  const port = await freePort();
  const fd = openSync(path.join(OUT, 'provider.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/fake-provider-issue-27.mjs')], {
    env: { ...process.env, FAKE_PROVIDER_PORT: String(port) },
    stdio: ['ignore', fd, fd],
  });
  children.push(child);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/__requests`)).ok, {
    label: 'fake provider',
  });
  return {
    port,
    async userTexts() {
      const { requests } = await (await fetch(`http://127.0.0.1:${port}/__requests`)).json();
      return requests.map((r) => r.lastUserText);
    },
    async timeline(since) {
      const { requests } = await (await fetch(`http://127.0.0.1:${port}/__requests`)).json();
      return requests.map((r) => `${r.at - since}ms ${r.lastUserText.slice(0, 30)}`);
    },
  };
}

async function openDesk(cdp, origin, invite) {
  // 配对页按手机视口出输入框；进 /desk 后换成桌面宽度，侧栏与输入框同屏
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp.send('Page.navigate', { url: `${origin}/?mode=phone` });
  await waitFor(() => cdp.eval('document.readyState === "complete"'), { label: 'index' });
  await cdp.eval(`localStorage.setItem('enso-phone-ui-mode', 'desk'); true`);
  await cdp.send('Page.navigate', { url: `${origin}/?mode=phone` });
  await waitFor(() => cdp.eval(`!!document.querySelector('input')`), { label: 'pair input' });
  await cdp.eval(`(() => {
    const input = document.querySelector('input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(invite)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('button')].find((b) => /配对/.test(b.textContent ?? '') && b.offsetParent !== null)?.click();
    return true;
  })()`);
  await waitFor(async () => !!(await cdp.eval('localStorage.getItem("enso-phone-devices")')), {
    label: 'pairing',
  });
  await cdp.eval(`localStorage.setItem('enso-phone-ui-mode', 'desk'); true`);
  await cdp.send('Page.navigate', { url: `${origin}/` });
  await waitFor(async () => (await cdp.eval('location.pathname')).startsWith('/desk'), {
    label: 'redirect to /desk',
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 860,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(
    () =>
      cdp.eval(
        `!!document.querySelector('iframe.main')?.contentDocument?.querySelector('[data-enso="workbench"]')`
      ),
    { timeout: 40_000, label: 'remote renderer' }
  );
  await waitFor(() => cdp.eval(`!document.querySelector('iframe.snapshot')`), {
    timeout: 40_000,
    label: 'snapshot gone',
  });
}

async function type(cdp, text) {
  const focused = await frame(
    cdp,
    `const editor = doc.querySelector('[data-enso="composer"] [contenteditable="true"]'); editor?.focus(); return !!editor;`
  );
  if (focused !== true) throw new Error(`composer missing ${JSON.stringify(focused)}`);
  await cdp.send('Input.insertText', { text });
  await sleep(200);
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    text: '\r',
    windowsVirtualKeyCode: 13,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
  });
}

/** 输入框上方的排队条：一行里有「排队」标签和这条消息的文字 */
const queueShown = (cdp) =>
  frame(
    cdp,
    `return [...doc.querySelectorAll('span')].some((span) => span.textContent === ${JSON.stringify(QUEUED)} && span.parentElement?.firstElementChild?.textContent === '排队');`
  );

function diskQueue() {
  try {
    const raw = JSON.parse(readFileSync(path.join(USER_DATA, 'settings.json'), 'utf8'));
    const conversations = raw['enso-conversations']?.state?.conversations ?? {};
    return Object.values(conversations).flatMap((c) =>
      (c.queuedMessages ?? []).map((q) => ({ id: c.id, status: c.status, text: q.text }))
    );
  } catch {
    return [];
  }
}

/** relay-go 带上手机端页面（frontend 换成 packages/phone/dist）现编，桌面经它配对 */
async function startRelay() {
  const src = path.join(OUT, 'relay-src');
  cpSync(path.join(ROOT, 'packages/relay-go'), src, { recursive: true });
  rmSync(path.join(src, 'frontend'), { recursive: true, force: true });
  cpSync(path.join(ROOT, 'packages/phone/dist'), path.join(src, 'frontend'), { recursive: true });
  const bin = path.join(OUT, 'enso-relay');
  execFileSync('go', ['build', '-o', bin, '.'], { cwd: src, stdio: 'ignore', timeout: 90_000 });
  const port = await freePort();
  const fd = openSync(path.join(OUT, 'relay.log'), 'a');
  const child = spawn(
    bin,
    [
      '--listen',
      `127.0.0.1:${port}`,
      '--db',
      path.join(OUT, 'relay.sqlite'),
      '--auto-update=false',
    ],
    { stdio: ['ignore', fd, fd] }
  );
  children.push(child);
  const origin = `http://127.0.0.1:${port}`;
  await waitFor(() => fetch(`${origin}/`).then((r) => r.ok), { label: 'relay' });
  return { origin, child };
}

/** 隔离 userData 的桌面实例（ENSO_VERIFY：不进 Dock、窗口不弹出），返回主窗口 renderer 的 CDP */
async function launchDesktop() {
  const cdpPort = await freePort();
  const electron = uiElementElectron(createRequire(path.join(ROOT, 'package.json'))('electron'));
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(ENSO_|ELECTRON_)/.test(key))
  );
  const fd = openSync(path.join(OUT, 'desktop.log'), 'a');
  const child = spawn(electron, ['.'], {
    cwd: ROOT,
    env: {
      ...clean,
      ENSO_USER_DATA_DIR: USER_DATA,
      ENSO_CDP_PORT: String(cdpPort),
      ENSO_VERIFY: '1',
    },
    stdio: ['ignore', fd, fd],
  });
  children.push(child);
  const target = await waitFor(
    async () => {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      return list.find((t) => t.type === 'page' && /\/renderer\/index\.html/.test(t.url));
    },
    { timeout: 60_000, label: 'desktop main window' }
  );
  const cdp = await Cdp.open(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await waitFor(
    () =>
      cdp.eval(
        `document.readyState === 'complete' && !!document.querySelector('[data-enso="workbench"]')`
      ),
    { timeout: 40_000, label: 'desktop workbench' }
  );
  return cdp;
}

async function main() {
  log(`out ${OUT} stall=${STALL}`);
  prepareProject();
  const provider = await startProvider();
  writeSettings(provider.port);
  const relay = await startRelay();
  const A = await launchDesktop();
  log('A (desktop) ready');
  await A.eval(`window.electronAPI.pair.setRelayUrl(${JSON.stringify(relay.origin)})`);
  const pairing = await A.eval('window.electronAPI.pair.start()');
  if (!pairing?.ok || !pairing.inviteUri) throw new Error(`pair.start ${JSON.stringify(pairing)}`);
  const B = await launchBrowser('b');
  await openDesk(B, relay.origin, pairing.inviteUri);
  log('B (pwa) ready');
  const roles = {
    a: await frame(A, 'return view.electronAPI && !view.electronAPI.remote ? true : null;'),
    b: await frame(B, 'return view.electronAPI?.remote?.isLeader?.() ?? null;'),
  };
  log(`leader a=${roles.a} b=${roles.b}`);
  if (roles.a !== true || roles.b !== false) throw new Error('unexpected leader topology');

  // A 新建会话并发一条慢回复，让会话处于运行中
  await frame(
    A,
    `doc.querySelector('[data-enso="project-row"] svg.lucide-message-square-plus')?.closest('button')?.click(); return true;`
  );
  await waitFor(
    () =>
      frame(A, `return !!doc.querySelector('[data-enso="composer"] [contenteditable="true"]');`),
    {
      label: 'A composer',
    }
  );
  await type(A, FIRST);
  await waitFor(async () => (await provider.userTexts()).some((t) => t.includes('pwaq-first')), {
    label: 'first turn reached provider',
  });
  const firstAt = Date.now();
  log('first turn running');

  // B 打开这个会话，在完整模式里排队一条
  await waitFor(
    () =>
      frame(
        B,
        `const sidebar = doc.querySelector('[data-enso="sidebar"]');
        const hit = [...(sidebar?.querySelectorAll('*') ?? [])].filter((el) => el.children.length === 0 && el.textContent?.includes('pwaq-first'));
        if (!hit.length) return false;
        hit[0].click();
        return true;`
      ),
    { label: 'B sees conversation', timeout: 20_000 }
  );
  await waitFor(
    () =>
      frame(
        B,
        `return doc.body.innerText.includes('fake-ok') || !!doc.querySelector('[data-enso="message-user"]');`
      ),
    { label: 'B opened conversation', timeout: 20_000 }
  );
  let resumedAt = 0;
  if (STALL) {
    // 中继卡住（手机弱网/挂起）：B 还以为在跑，排队写回卡在路上，到宿主时这一轮已经结束
    relay.child.kill('SIGSTOP');
    await sleep(300);
  }
  await type(B, QUEUED);
  await waitFor(() => queueShown(B), { label: 'B shows queued item', timeout: 10_000 });
  log('B queued');
  if (STALL) {
    // 慢回复流完：等它在宿主上收束（多留 2.5s）再放行中继
    await sleep(Math.max(0, firstAt + SLOW_MS + 2500 - Date.now()));
    log(`first turn finished; A queue shown=${await queueShown(A)}`);
    relay.child.kill('SIGCONT');
    resumedAt = Date.now();
    log('relay resumed');
  }

  const result = { desktopSaw: false, sent: false, bCleared: false, diskCleared: false };
  // 桌面上看得到这条：排队条里，或已作为用户消息发出
  try {
    await waitFor(
      () => frame(A, `return doc.body.innerText.includes(${JSON.stringify(QUEUED)});`),
      {
        label: 'desktop shows the message',
        timeout: 15_000,
      }
    );
    result.desktopSaw = true;
  } catch (error) {
    log(`desktop never showed it: ${error.message}`);
  }
  try {
    await waitFor(async () => (await provider.userTexts()).some((t) => t.includes(QUEUED)), {
      label: 'queued message reached provider',
      timeout: 30_000,
      interval: 500,
    });
    result.sent = true;
  } catch (error) {
    log(`queued message not sent: ${error.message}`);
  }
  // 发出后两端都该清掉这条排队：B 的排队条消失、磁盘行的 queuedMessages 清空
  if (result.sent) {
    try {
      await waitFor(async () => !(await queueShown(B)), {
        label: 'B queue cleared',
        timeout: 15_000,
      });
      result.bCleared = true;
    } catch (error) {
      log(`B still shows queue: ${error.message}`);
    }
    try {
      await waitFor(() => diskQueue().length === 0, {
        label: 'disk queue cleared',
        timeout: 15_000,
      });
      result.diskCleared = true;
    } catch (error) {
      log(`disk still has queue: ${error.message}`);
    }
  }
  result.disk = diskQueue();
  result.providerTexts = await provider.userTexts();
  result.timeline = await provider.timeline(firstAt);
  if (STALL) result.resumedAt = resumedAt - firstAt;
  log(`RESULT ${JSON.stringify(result)}`);
  const ok = result.desktopSaw && result.sent && result.bCleared && result.diskCleared;
  log(ok ? 'PASS' : 'FAIL');
  shutdown(ok ? 0 : 1);
}

process.on('SIGINT', () => shutdown(130));
main().catch((error) => {
  console.error(error);
  shutdown(1);
});
