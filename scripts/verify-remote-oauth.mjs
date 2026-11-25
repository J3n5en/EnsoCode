#!/usr/bin/env node
// 远程 OAuth 验收：ENSO_VERIFY=1 隔离 enso-server + 本地假 OAuth 站 + 无头 Chromium 走 /desk 远程链路。
// 前置：pnpm build && pnpm build:server && (cd packages/phone && pnpm build)。
//   node scripts/verify-remote-oauth.mjs [--keep] [--out /tmp/dir]
// 截图固定输出到 /tmp/remote-oauth-*.png。退出码：全部通过 0，否则 1。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const outFlag = argv.indexOf('--out');
const OUT =
  outFlag !== -1 ? argv[outFlag + 1] : mkdtempSync(path.join(os.tmpdir(), 'enso-roauth-'));
mkdirSync(OUT, { recursive: true });

const HARD_TIMEOUT_MS = 180_000;
const hardTimeout = setTimeout(() => {
  console.error('hard timeout');
  process.exit(1);
}, HARD_TIMEOUT_MS);
hardTimeout.unref();

const children = [];
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(line) {
  console.log(line);
}

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
    `timeout waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`
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
      }, 30_000);
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

  async shot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

/* ---------- 本地假 OAuth 站 ---------- */

function startFakeOauth() {
  const state = { lastAuthorize: null, deviceConfirmed: false };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/authorize') {
      state.lastAuthorize = Object.fromEntries(url.searchParams);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>fake authorize page</body></html>');
      return;
    }
    if (url.pathname === '/device') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>fake device page</body></html>');
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        if (!parsed.code || !parsed.state) return json(400, { error: 'missing' });
        json(200, {
          access_token: 'verify-access',
          refresh_token: 'verify-refresh',
          expires_in: 3600,
        });
      });
      return;
    }
    if (url.pathname === '/device/poll') {
      if (!state.deviceConfirmed) return json(428, {});
      json(200, {
        access_token: 'device-access',
        refresh_token: 'device-refresh',
        expires_in: 3600,
      });
      return;
    }
    if (url.pathname === '/confirm-device') {
      state.deviceConfirmed = true;
      return json(200, { ok: true });
    }
    json(404, { error: 'not found' });
  });
  return { server, state };
}

/* ---------- 无头 Chromium ---------- */

const HEADLESS_SHELL = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
);

async function launchBrowser() {
  const debugPort = await freePort();
  const userDir = mkdtempSync(path.join(os.tmpdir(), 'enso-roauth-chrome-'));
  const logFd = openSync(path.join(OUT, 'chromium.log'), 'a');
  const child = spawn(
    HEADLESS_SHELL,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDir}`,
      '--window-size=390,844',
      '--force-device-scale-factor=1',
      '--disable-features=Animation',
      '--no-first-run',
      'about:blank',
    ],
    { stdio: ['ignore', logFd, logFd] }
  );
  children.push(child);
  const pageTarget = await waitFor(
    async () => {
      const r = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const list = await r.json();
      return list.find((t) => t.type === 'page');
    },
    { label: 'chromium page target' }
  );
  const cdp = await Cdp.open(pageTarget.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  cdp.consoleLines = [];
  cdp.ws.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.consoleAPICalled') {
        const line = message.params.args
          .map((a) => a.value ?? a.description ?? '')
          .join(' ')
          .slice(0, 300);
        if (cdp.consoleLines.length < 200) cdp.consoleLines.push(line);
      }
    } catch {}
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return cdp;
}

/* ---------- 页面驱动 ---------- */

// 远程 renderer 在 /desk 壳的 iframe 里（同源）。设置开在独立 settings iframe，
// 主界面在 main iframe；统一解析：优先可见的 settings iframe，其次 main iframe，最后顶层 document。
const FRAME_DOC = `(() => {
  const settings = document.querySelector('iframe.settings');
  if (settings?.contentDocument) return settings.contentDocument;
  const main = document.querySelector('iframe.main');
  if (main?.contentDocument) return main.contentDocument;
  return document;
})()`;

async function docEval(cdp, expression) {
  return cdp.eval(`(() => {
    const doc = ${FRAME_DOC};
    return (${expression})(doc);
  })()`);
}

async function inDoc(cdp, expression) {
  return cdp.eval(`(() => {
    const doc = ${FRAME_DOC};
    ${expression}
  })()`);
}

async function nav(cdp, url) {
  await cdp.send('Page.navigate', { url });
}

async function evalJs(cdp, expression) {
  return cdp.eval(expression);
}

async function remoteDoc(cdp) {
  const found = await cdp.eval(`(() => {
    const frame = document.querySelector('iframe.main');
    const doc = frame?.contentDocument ?? (frame ? null : document);
    if (!doc) return { hasFrame: !!frame, doc: false };
    return { hasFrame: !!frame, doc: true, remote: !!doc.defaultView?.electronAPI?.remote, url: doc.location?.href ?? '' };
  })()`);
  return found;
}

async function clickText(cdp, selector, text) {
  const ok = await inDoc(
    cdp,
    `
    const nodes = [...doc.querySelectorAll(${JSON.stringify(selector)})];
    const visible = (n) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    // 文本常在 button 内的 span/strong 里：直接匹配不到就查任意元素再爬到最近的 button
    let target = nodes.find((n) => n.textContent && n.textContent.trim().includes(${JSON.stringify(text)}) && visible(n));
    if (!target && ${JSON.stringify(selector)} === 'button') {
      const any = [...doc.querySelectorAll('button, button *')].find(
        (n) => n.children.length === 0 && n.textContent && n.textContent.trim().includes(${JSON.stringify(text)}) && visible(n)
      );
      target = any?.closest('button') ?? null;
      if (!target) {
        const leafs = [...doc.querySelectorAll('button, button *')].filter(
          (n) => n.children.length === 0 && n.textContent && n.textContent.trim().includes(${JSON.stringify(text)})
        ).map((n) => ({ t: (n.textContent ?? '').trim().slice(0, 30), vis: visible(n), inBtn: !!n.closest('button') }));
        return { miss: leafs };
      }
    }
    if (!target) {
      const anyMatch = nodes.filter((n) => n.textContent && n.textContent.trim().includes(${JSON.stringify(text)})).map((n) => ({ t: (n.textContent ?? '').trim().slice(0, 40), r: n.getBoundingClientRect().width }));
      return { miss: anyMatch };
    }
    target.click();
    return { ok: true };
  `
  );
  if (!ok?.ok) {
    await dumpDiag(cdp, `clickText ${text}`);
    if (ok?.miss) console.log('candidates:', JSON.stringify(ok.miss));
    throw new Error(`clickText not found: ${selector} "${text}"`);
  }
}

async function hasText(cdp, text) {
  return inDoc(
    cdp,
    `
    return doc.body ? (doc.body.textContent ?? '').includes(${JSON.stringify(text)}) : false;
  `
  );
}

async function fillInput(cdp, value) {
  const ok = await inDoc(
    cdp,
    `
    const scope = doc.querySelector('[role="dialog"]') ?? doc;
    const input = scope.querySelector('input[type="text"], input:not([type])');
    if (!input) return { err: 'no input', inputs: scope.querySelectorAll('input').length };
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(doc.defaultView.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
    input.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
    return { err: null, now: input.value.slice(0, 80) };
  `
  );
  if (ok?.err) {
    await dumpDiag(cdp, 'fillInput');
    throw new Error(`fillInput: ${ok.err}`);
  }
  // React 受控输入：commit 可能比读回晚，轮询等落盘
  let readback = '';
  for (let i = 0; i < 8 && !readback; i++) {
    readback = await inDoc(
      cdp,
      `
      const scope = doc.querySelector('[role="dialog"]') ?? doc;
      const input = scope.querySelector('input[type="text"], input:not([type])');
      return input ? input.value : '';
    `
    );
    if (!readback) await sleep(100);
  }
  log('fillInput now: ' + (ok?.now ?? '').slice(0, 70) + ' | readback: ' + readback.slice(0, 60));
  if (!readback) {
    const probe = await inDoc(
      cdp,
      `
      const scope = doc.querySelector('[role="dialog"]') ?? doc;
      const input = scope.querySelector('input[type="text"], input:not([type])');
      if (!input) return { err: 'no input' };
      const seen = [];
      input.addEventListener('input', () => seen.push('elem-input'));
      input.addEventListener('change', () => seen.push('elem-change'));
      const setter = Object.getOwnPropertyDescriptor(doc.defaultView.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'PROBE');
      input.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
      const v1 = input.value;
      // React 重渲染是否清掉
      return new Promise((resolve) => setTimeout(() => resolve({ seen, v1, v2: input.value, proto: Object.getPrototypeOf(input).constructor.name }), 300));
    `
    );
    console.log('INPUT PROBE:', JSON.stringify(probe));
  }
}

async function dumpDiag(cdp, label) {
  const diag = await cdp.eval(`(() => {
    const pick = (cls) => {
      const f = document.querySelector('iframe.' + cls);
      return f?.contentDocument ? (f.contentDocument.body?.innerText ?? '').slice(0, 700) : null;
    };
    return { top: (document.body?.innerText ?? '').slice(0, 300), main: pick('main'), settings: pick('settings') };
  })()`);
  console.log(`DIAG[${label}]:`, JSON.stringify(diag, null, 1));
}

async function typeInput(cdp, value) {
  const focused = await inDoc(
    cdp,
    `
    const scope = doc.querySelector('[role="dialog"]') ?? doc;
    const input = scope.querySelector('input[type="text"], input:not([type])');
    if (!input) return false;
    input.focus();
    return scope.activeElement === input || doc.activeElement === input || true;
  `
  );
  if (!focused) throw new Error('typeInput: input not focused');
  await cdp.send('Input.insertText', { text: value });
  const readback = await inDoc(
    cdp,
    `
    const scope = doc.querySelector('[role="dialog"]') ?? doc;
    const input = scope.querySelector('input[type="text"], input:not([type])');
    return input ? input.value : '';
  `
  );
  log('typeInput readback: ' + readback.slice(0, 70));
  if (!readback.includes(value.slice(0, 20))) throw new Error('typeInput: value did not stick');
}

function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition });
  log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  return condition;
}

async function main() {
  /* 假 OAuth 站 */
  const fake = startFakeOauth();
  const fakePort = await freePort();
  await new Promise((resolve) => fake.server.listen(fakePort, '127.0.0.1', resolve));
  const fakeBase = `http://127.0.0.1:${fakePort}`;
  log(`fake oauth ${fakeBase}`);

  /* enso-server */
  const webPort = await freePort();
  const userData = path.join(OUT, 'userData');
  mkdirSync(userData, { recursive: true });
  writeFileSync(
    path.join(userData, 'settings.json'),
    // zustand persist 结构（enso-settings/state + 当前版本号），扁平写法不会生效
    JSON.stringify({ 'enso-settings': { state: { language: 'zh' }, version: 18 } })
  );
  const serverLog = openSync(path.join(OUT, 'server.log'), 'a');
  const serverEnv = {
    ...process.env,
    ENSO_VERIFY: '1',
    ENSO_PACKAGED: '0',
    ENSO_DATA_DIR: userData,
    ENSO_VERIFY_OAUTH_BASE: fakeBase,
  };
  delete serverEnv.ELECTRON_RUN_AS_NODE;
  const server = spawn(
    process.execPath,
    [
      path.join(ROOT, 'out/server/index.js'),
      'start',
      '--web-host',
      '127.0.0.1',
      '--web-port',
      String(webPort),
    ],
    { env: serverEnv, stdio: ['ignore', serverLog, serverLog], cwd: ROOT }
  );
  children.push(server);
  await waitFor(
    async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${webPort}/health`);
        return r.status < 500;
      } catch {
        return false;
      }
    },
    { timeout: 30_000, label: 'enso-server web' }
  ).catch(async () => {
    // health 路径不确定，退化为能连上端口
    await waitFor(
      async () => {
        try {
          await fetch(`http://127.0.0.1:${webPort}/`);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 10_000, label: 'enso-server web port' }
    );
  });
  log(`enso-server web 127.0.0.1:${webPort}`);

  /* 配对：拿邀请链接 */
  const invite = await new Promise((resolve, reject) => {
    const pairEnv = { ...serverEnv };
    const pair = spawn(process.execPath, [path.join(ROOT, 'out/server/index.js'), 'pair'], {
      env: pairEnv,
      cwd: ROOT,
    });
    children.push(pair);
    let buf = '';
    const timer = setTimeout(() => reject(new Error('pair invite timeout')), 20_000);
    pair.stdout.on('data', (chunk) => {
      buf += chunk;
      const match = buf.match(/enso-pair:\/\/\S+|https?:\/\/[^\s#]+#\S+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0].replace(/[)\].,，。]+$/, ''));
      }
    });
    pair.on('error', reject);
  });
  log(`invite ${invite.slice(0, 60)}…`);

  /* 无头 Chromium 走远程链路 */
  const cdp = await launchBrowser();

  // 拦截 window.open：远程自动打开授权页时记录 URL 而不真的开新标签
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    includeInAllFrames: true,
    source: `
      window.__openedUrls = [];
      const origOpen = window.open;
      window.open = function(url, ...rest) {
        try { window.__openedUrls.push(String(url)); } catch {}
        return { closed: false, close() {}, focus() {}, location: null };
      };
    `,
  });

  // 先种 uiMode=desk：配对后回到 / 时启动逻辑会跳 /desk
  const webOrigin = `http://127.0.0.1:${webPort}`;
  await nav(cdp, `${webOrigin}/?mode=phone`);
  await waitFor(async () => cdp.eval('document.readyState === "complete"'), {
    label: 'index loaded',
  });
  await cdp.eval(`localStorage.setItem('enso-phone-ui-mode', 'desk'); true`);
  // 手动走配对 UI：地址栏不带 hash，粘贴邀请链接进输入框点「配对」
  await nav(cdp, `${webOrigin}/?mode=phone`);
  await waitFor(
    async () => {
      return cdp.eval(`!!document.querySelector('input')`);
    },
    { timeout: 20_000, label: 'pair screen input' }
  );
  await cdp.eval(`(() => {
    const input = document.querySelector('input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(invite)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /配对/.test(b.textContent ?? '') && b.offsetParent !== null);
    btn?.click();
    return !!btn;
  })()`);
  await waitFor(async () => !!(await cdp.eval('localStorage.getItem("enso-phone-devices")')), {
    timeout: 30_000,
    label: 'pairing done (device stored)',
  }).catch(async (error) => {
    const diag = await cdp.eval(`({
      url: location.href,
      text: (document.body?.innerText ?? '').slice(0, 300),
      keys: Object.keys(localStorage),
    })`);
    console.log('PAIR DIAG:', JSON.stringify(diag, null, 2));
    console.log('PAGE CONSOLE:', (cdp.consoleLines ?? []).slice(-20).join('\n'));
    throw error;
  });
  log('paired');
  // 配对时落在精简模式：改回 desk 模式后重进 /，启动逻辑跳到 /desk?device=…
  await cdp.eval(`localStorage.setItem('enso-phone-ui-mode', 'desk'); true`);
  await nav(cdp, `${webOrigin}/`);
  await nav(cdp, `${webOrigin}/`);
  await waitFor(async () => (await cdp.eval('location.pathname')).startsWith('/desk'), {
    timeout: 15_000,
    label: 'redirect to /desk',
  }).catch(async (error) => {
    const diag = await cdp.eval(`({
      url: location.href,
      uiMode: localStorage.getItem('enso-phone-ui-mode'),
      keys: Object.keys(localStorage),
      devices: (localStorage.getItem('enso-phone-devices') ?? '').slice(0, 300),
      text: (document.body?.innerText ?? '').slice(0, 200),
    })`);
    console.log('DESK REDIRECT DIAG:', JSON.stringify(diag, null, 2));
    throw error;
  });
  // 等 iframe 出现且远程 API 就绪
  const boot = await waitFor(
    async () => {
      const state = await remoteDoc(cdp);
      return state.doc && state.remote ? state : null;
    },
    { timeout: 15_000, label: 'remote renderer boot' }
  ).catch(async (error) => {
    const diag = await cdp.eval(`(() => {
      const out = { url: location.href, title: document.title, iframes: [] };
      for (const f of document.querySelectorAll('iframe')) {
        let info = { cls: f.className, src: f.src.slice(0, 120) };
        try {
          const d = f.contentDocument;
          info.doc = !!d;
          if (d) {
            info.innerUrl = d.location?.href?.slice(0, 120);
            info.electronAPI = !!d.defaultView?.electronAPI;
            info.remote = !!d.defaultView?.electronAPI?.remote;
            info.bodyLen = d.body?.innerHTML?.length ?? 0;
            info.text = (d.body?.innerText ?? '').slice(0, 200);
          }
        } catch (e) { info.err = String(e).slice(0, 100); }
        out.iframes.push(info);
      }
      out.topText = (document.body?.innerText ?? '').slice(0, 200);
      return out;
    })()`);
    console.log('BOOT DIAG:', JSON.stringify(diag, null, 2));
    throw error;
  });
  log(`remote renderer ready: ${boot.url.slice(0, 80)}`);

  /* 进入设置 → 服务商 */
  await waitFor(
    async () => {
      return cdp.eval(`(() => {
        const doc = (document.querySelector('iframe.settings')?.contentDocument) ?? (document.querySelector('iframe.main')?.contentDocument) ?? document;
        return !!doc.querySelector('[data-enso="settings-button"]');
      })()`);
    },
    { label: 'settings button' }
  );
  await cdp.eval(`(() => {
    const doc = (document.querySelector('iframe.settings')?.contentDocument) ?? (document.querySelector('iframe.main')?.contentDocument) ?? document;
    doc.querySelector('[data-enso="settings-button"]').click();
    return true;
  })()`);
  await waitFor(() => hasText(cdp, '服务商'), { label: 'settings opened' }).catch(() => {});

  // 点进 providers 分类（设置侧栏）
  const navOk = await cdp.eval(`(() => {
    const doc = (document.querySelector('iframe.settings')?.contentDocument) ?? (document.querySelector('iframe.main')?.contentDocument) ?? document;
    const nodes = [...doc.querySelectorAll('button, a, [role="button"]')];
    const target = nodes.find((n) => /^(Model Providers|模型中心|服务商|模型服务)s*$/.test((n.textContent ?? '').trim()) && n.offsetParent !== null);
    if (target) { target.click(); return 'nav'; }
    return null;
  })()`);
  log(`settings nav: ${navOk ?? 'not found'}`);
  await sleep(800);

  /* 添加服务商 */
  await waitFor(async () => hasText(cdp, '添加模型') || hasText(cdp, 'Add model or provider'), {
    timeout: 10_000,
    label: 'providers page',
  }).catch(() => {});
  await clickText(cdp, 'button', '添加模型或服务商').catch(async () =>
    clickText(cdp, 'button', 'Add model or provider')
  );
  await sleep(1200);
  const dlg = await inDoc(
    cdp,
    `
    return {
      dialogs: [...doc.querySelectorAll('[role="dialog"], [data-state="open"]')].length,
      wizardText: doc.body.innerText.slice(0, 400),
    };
  `
  );
  const dlgText = await inDoc(
    cdp,
    `
    const d = doc.querySelector('[role="dialog"]');
    return d ? (d.textContent ?? '').slice(0, 800) : 'no-dialog';
  `
  );
  log('dialog text: ' + JSON.stringify(dlgText));
  log('after add click: ' + JSON.stringify(dlg).slice(0, 300));
  console.log('PAGE CONSOLE:', (cdp.consoleLines ?? []).slice(-15).join('\n'));
  await waitFor(() => hasText(cdp, '验证用 OAuth'), {
    label: 'wizard provider list',
    timeout: 12_000,
  }).catch(async (error) => {
    await dumpDiag(cdp, 'wizard');
    throw error;
  });
  /* 场景 4（先做，免得重开向导）：设备码显示 */
  await clickText(cdp, 'button', '验证用设备码').catch(async () =>
    clickText(cdp, 'button', 'Verify Device')
  );
  await clickText(cdp, 'button', '服务商订阅').catch(async () =>
    clickText(cdp, 'button', 'Provider subscription')
  );
  await sleep(600);
  await cdp.eval(`(() => {
    const doc = (document.querySelector('iframe.settings')?.contentDocument) ?? (document.querySelector('iframe.main')?.contentDocument) ?? document;
    const btn = [...doc.querySelectorAll('button')].find((b) => /Connect subscription|连接订阅/.test(b.textContent ?? '') && b.offsetParent !== null);
    btn?.click();
    return !!btn;
  })()`);
  await waitFor(() => hasText(cdp, 'WXYZ-1234'), {
    timeout: 12_000,
    label: 'device user code',
  }).catch(async () => {
    const dlgDev = await inDoc(
      cdp,
      `
      const d = doc.querySelector('[role="dialog"]');
      return d ? (d.textContent ?? '').slice(0, 400) : 'no-dialog';
    `
    );
    console.log('device step dialog:', JSON.stringify(dlgDev));
  });
  await sleep(500);
  await cdp.shot('/tmp/remote-oauth-zh-4-device-code.png');
  check('shot 4 device code', existsSync('/tmp/remote-oauth-zh-4-device-code.png'));
  check('device code displayed', await hasText(cdp, 'WXYZ-1234'));
  // 取消设备登录，Back 回服务商列表
  await inDoc(
    cdp,
    `
    const btn = [...doc.querySelectorAll('button')].find((b) => /Cancel authorization|取消授权/.test(b.textContent ?? '') && b.offsetParent !== null);
    btn?.click();
    return !!btn;
  `
  );
  await sleep(700);
  await inDoc(
    cdp,
    `
    const btn = [...doc.querySelectorAll('button')].find((b) => /^(Back|返回|上一步)$/.test((b.textContent ?? '').trim()) && b.offsetParent !== null);
    btn?.click();
    return !!btn;
  `
  );
  await sleep(500);
  await inDoc(
    cdp,
    `
    const btn = [...doc.querySelectorAll('button')].find((b) => /^(Back|返回|上一步)$/.test((b.textContent ?? '').trim()) && b.offsetParent !== null);
    btn?.click();
    return !!btn;
  `
  );
  await sleep(700);
  await waitFor(() => hasText(cdp, '验证用 OAuth'), {
    timeout: 8_000,
    label: 'back at provider list',
  }).catch(() => {});

  await clickText(cdp, 'button', '验证用 OAuth').catch(async () =>
    clickText(cdp, 'button', 'Verify OAuth')
  );
  await waitFor(() => hasText(cdp, '服务商订阅'), {
    label: 'method step',
  }).catch(async (error) => {
    const dlg2 = await inDoc(
      cdp,
      `
      const d = doc.querySelector('[role="dialog"]');
      return d ? (d.textContent ?? '').slice(0, 500) : 'no-dialog';
    `
    );
    console.log('method step dialog:', JSON.stringify(dlg2));
    throw error;
  });
  await clickText(cdp, 'button', '服务商订阅').catch(async () =>
    clickText(cdp, 'button', 'Provider subscription')
  );

  /* 开始登录：OauthProviderAccounts 里的登录按钮 */
  await waitFor(
    async () => {
      return cdp.eval(`(() => {
        const doc = (document.querySelector('iframe.settings')?.contentDocument) ?? (document.querySelector('iframe.main')?.contentDocument) ?? document;
        return [...doc.querySelectorAll('button')].some((b) => /Connect subscription|连接订阅|Sign in|Log in|登录/.test(b.textContent ?? '') && b.offsetParent !== null);
      })()`);
    },
    { label: 'oauth login button' }
  );
  const loginClick = await cdp.eval(`(() => {
    const doc = (document.querySelector('iframe.settings')?.contentDocument) ?? (document.querySelector('iframe.main')?.contentDocument) ?? document;
    const exact = (t) => (b) => (b.textContent ?? '').trim().includes(t);
    const all = [...doc.querySelectorAll('button')];
    const btns = all.filter(exact('连接订阅')).concat(all.filter(exact('Connect subscription')), all.filter(exact('添加其他账号')), all.filter(exact('Add another account')));
    const btn = btns.find((b) => b.offsetParent !== null) ?? btns[0];
    if (!btn) return { found: false };
    btn.click();
    return { found: true, text: (btn.textContent ?? '').trim().slice(0, 40), count: btns.length };
  })()`);
  log('login click: ' + JSON.stringify(loginClick));

  /* 场景 1：等待 + 粘贴输入框 */
  await waitFor(async () => hasText(cdp, '正在等待浏览器完成授权'), {
    label: 'waiting progress',
    timeout: 12_000,
  }).catch(async (error) => {
    const dlg3 = await inDoc(
      cdp,
      `
      const d = doc.querySelector('[role="dialog"]');
      return d ? (d.textContent ?? '').slice(0, 600) : 'no-dialog';
    `
    );
    console.log('waiting diag dialog:', JSON.stringify(dlg3));
    throw error;
  });
  await waitFor(
    async () => {
      return cdp.eval(`(() => {
        const doc = (document.querySelector('iframe.settings')?.contentDocument) ?? (document.querySelector('iframe.main')?.contentDocument) ?? document;
        return !!doc.querySelector('input[type="text"], input:not([type])');
      })()`);
    },
    { label: 'manual paste input' }
  );
  await sleep(400);
  await cdp.shot('/tmp/remote-oauth-zh-1-waiting-input.png');
  check('shot 1 waiting+input', existsSync('/tmp/remote-oauth-zh-1-waiting-input.png'));
  check('zh paste guidance visible', await hasText(cdp, '把地址栏里的完整链接粘贴到这里'));

  // 远程应已自动 window.open 完整授权链接（含 query）
  const opened = await waitFor(
    async () => {
      const urls = await inDoc(
        cdp,
        'return doc.defaultView?.__openedUrls ?? window.__openedUrls ?? []'
      );
      return urls.length ? urls : null;
    },
    { timeout: 10_000, label: 'remote window.open auth url' }
  ).catch(() => []);
  const authUrl = opened[0] ?? '';
  check(
    'remote auto-opened full auth url',
    /\/authorize\?/.test(authUrl) && /state=/.test(authUrl),
    authUrl.slice(0, 90)
  );
  check(
    'auth url keeps query (state/redirect_uri)',
    /redirect_uri=/.test(authUrl) && /client_id=/.test(authUrl)
  );

  /* 场景 2：state 错误被拒 */
  if (authUrl) {
    const parsed = new URL(authUrl);
    const redirect = decodeURIComponent(parsed.searchParams.get('redirect_uri') ?? '');
    const state = parsed.searchParams.get('state') ?? '';
    const badUrl = `${redirect}?code=verify-code-1&state=wrong-state`;
    await fillInput(cdp, badUrl);

    // 提交（回车或按钮）
    await cdp.eval(`(() => {
      const doc = (document.querySelector('iframe.settings')?.contentDocument) ?? (document.querySelector('iframe.main')?.contentDocument) ?? document;
      const input = doc.querySelector('input[type="text"], input:not([type])');
      const submit = [...doc.querySelectorAll('button')].find((b) => /^(Submit|提交)$/.test((b.textContent ?? '').trim()) && b.offsetParent !== null);
      if (submit) { submit.click(); return 'submit'; }
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      return 'enter';
    })()`);
    // 红字错误必须出现（state 不匹配）：等它出现再截图，截图里要看得见
    const redErr = await waitFor(() => hasText(cdp, '链接与本次授权不匹配'), {
      timeout: 8_000,
      label: 'red rejection error',
    }).catch(async () => {
      const dlgErr = await inDoc(
        cdp,
        `
        const d = doc.querySelector('[role="dialog"]');
        return d ? (d.textContent ?? '').slice(0, 500) : 'no-dialog';
      `
      );
      console.log('state error dialog:', JSON.stringify(dlgErr));
      return false;
    });
    check('red rejection error shown', !!redErr);
    // 被拒后状态行必须复位回「正在等待浏览器完成授权」，不能停在「正在验证」
    const statusReset = await hasText(cdp, '正在等待浏览器完成授权');
    const stuckVerifying = await inDoc(
      cdp,
      `
      const d = doc.querySelector('[role="dialog"]');
      return d ? (d.textContent ?? '').includes('正在验证') : false;
    `
    );
    check('status reset to waiting after rejection', !!statusReset && !stuckVerifying);
    await sleep(400);
    await cdp.shot('/tmp/remote-oauth-zh-2-state-error.png');
    check('shot 2 state error', existsSync('/tmp/remote-oauth-zh-2-state-error.png'));

    /* 场景 3：粘贴成功完成登录 */
    const goodUrl = `${redirect}?code=verify-code-1&state=${encodeURIComponent(state)}`;
    // 输入框可能被清空重新渲染，重新填
    await fillInput(cdp, goodUrl);
    await cdp.eval(`(() => {
      const doc = (document.querySelector('iframe.settings')?.contentDocument) ?? (document.querySelector('iframe.main')?.contentDocument) ?? document;
      const submit = [...doc.querySelectorAll('button')].find((b) => /^(Submit|提交)$/.test((b.textContent ?? '').trim()) && b.offsetParent !== null);
      if (submit) { submit.click(); return 'submit'; }
      const input = doc.querySelector('input[type="text"], input:not([type])');
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      return 'enter';
    })()`);
    await waitFor(async () => hasText(cdp, '正在用授权码换取令牌'), {
      timeout: 8_000,
      label: 'exchanging tokens',
    }).catch(() => {});
    // 换 token 很快，通常只能截到完成后的账号页：任一终态都算登录成功
    const done = await waitFor(
      async () =>
        (await hasText(cdp, '正在用授权码换取令牌')) ||
        (await hasText(cdp, '退出登录')) ||
        (await hasText(cdp, 'Log out')) ||
        (await hasText(cdp, 'Remove')),
      { timeout: 10_000, label: 'login terminal state' }
    ).catch(async () => {
      const dlg4 = await inDoc(
        cdp,
        `
        const d = doc.querySelector('[role="dialog"]');
        return d ? (d.textContent ?? '').slice(0, 500) : 'no-dialog';
      `
      );
      console.log('login terminal dialog:', JSON.stringify(dlg4));
      return false;
    });
    await sleep(400);
    await cdp.shot('/tmp/remote-oauth-zh-3-paste-success.png');
    check('shot 3 paste success', existsSync('/tmp/remote-oauth-zh-3-paste-success.png'));
    check('login reached exchange/done', !!done);
  }

  /* 收尾 */
  const failed = results.filter((r) => !r.ok);
  log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) log(`failed: ${f.name}`);
  log(`screenshots: /tmp/remote-oauth-zh-*.png ; logs: ${OUT}`);

  cdp.close();
  fake.server.close();
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
  clearTimeout(hardTimeout);
  if (KEEP) {
    log('--keep: leaving processes running, Ctrl+C to exit');
    return;
  }
  process.exit(failed.length ? 1 : 0);
}

process.on('SIGINT', () => {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
  process.exit(130);
});

main().catch((error) => {
  console.error(error);
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
  process.exit(1);
});
