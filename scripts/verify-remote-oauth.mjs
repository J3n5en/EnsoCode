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

const ROOT = path.dirname(fileURLToPath(new URL('./verify-remote-oauth.mjs', import.meta.url)));
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const outFlag = argv.indexOf('--out');
const OUT = outFlag !== -1 ? argv[outFlag + 1] : mkdtempSync(path.join(os.tmpdir(), 'enso-roauth-'));
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

// 远程 renderer 在 /desk 壳的 iframe 里（同源），统一从 iframe document 查；查不到就退回顶层 document
const DOC = `(frame) => {
  const doc = frame?.contentDocument ?? document;
  return doc;
}`;

async function nav(cdp, url) {
  await cdp.send('Page.navigate', { url });
}

async function evalJs(cdp, expression) {
  return cdp.eval(expression);
}

async function remoteDoc(cdp) {
  const found = await cdp.eval(`(() => {
    const frame = document.querySelector('iframe.main, iframe[class]');
    const doc = frame?.contentDocument ?? (frame ? null : document);
    if (!doc) return { hasFrame: !!frame, doc: false };
    return { hasFrame: !!frame, doc: true, remote: !!doc.defaultView?.electronAPI?.remote, url: doc.location?.href ?? '' };
  })()`);
  return found;
}

async function clickText(cdp, selector, text) {
  const ok = await cdp.eval(`(() => {
    const frame = document.querySelector('iframe.main, iframe[class]');
    const doc = frame?.contentDocument ?? document;
    const nodes = [...doc.querySelectorAll(${JSON.stringify(selector)})];
    const target = nodes.find((n) => n.textContent && n.textContent.trim().includes(${JSON.stringify(text)}) && n.offsetParent !== null);
    if (!target) return false;
    target.click();
    return true;
  })()`);
  if (!ok) throw new Error(`clickText not found: ${selector} "${text}"`);
}

async function hasText(cdp, text) {
  return cdp.eval(`(() => {
    const frame = document.querySelector('iframe.main, iframe[class]');
    const doc = frame?.contentDocument ?? document;
    return doc.body ? doc.body.innerText.includes(${JSON.stringify(text)}) : false;
  })()`);
}

async function fillInput(cdp, value) {
  const ok = await cdp.eval(`(() => {
    const frame = document.querySelector('iframe.main, iframe[class]');
    const doc = frame?.contentDocument ?? document;
    const input = doc.querySelector('input[type="text"], input:not([type])');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!ok) throw new Error('fillInput: no text input found');
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
    JSON.stringify({ language: 'zh' })
  );
  const serverLog = openSync(path.join(OUT, 'server.log'), 'a');
  const serverEnv = {
    ...process.env,
    ENSO_VERIFY: '1',
    ENSO_PACKAGED: '0',
    ENSO_USER_DATA_DIR: userData,
    ENSO_VERIFY_OAUTH_BASE: fakeBase,
  };
  delete serverEnv.ELECTRON_RUN_AS_NODE;
  const server = spawn(
    process.execPath,
    [path.join(ROOT, 'out/server/index.js'), 'start', '--web-host', '127.0.0.1', '--web-port', String(webPort)],
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
    const pair = spawn(
      process.execPath,
      [path.join(ROOT, 'out/server/index.js'), 'pair'],
      { env: pairEnv, cwd: ROOT }
    );
    children.push(pair);
    let buf = '';
    const timer = setTimeout(() => reject(new Error('pair invite timeout')), 20_000);
    pair.stdout.on('data', (chunk) => {
      buf += chunk;
      const match = buf.match(/enso-pair:\/\/\S+|https?:\/\/\S+#pair=\S+/);
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
    source: `
      window.__openedUrls = [];
      const origOpen = window.open;
      window.open = function(url, ...rest) {
        try { window.__openedUrls.push(String(url)); } catch {}
        return { closed: false, close() {}, focus() {}, location: null };
      };
    `,
  });

  await nav(cdp, invite);
  // 等 iframe 出现且远程 API 就绪
  const boot = await waitFor(
    async () => {
      const state = await remoteDoc(cdp);
      return state.doc && state.remote ? state : null;
    },
    { timeout: 60_000, label: 'remote renderer boot' }
  );
  log(`remote renderer ready: ${boot.url.slice(0, 80)}`);

  /* 进入设置 → 服务商 */
  await waitFor(
    async () => {
      return cdp.eval(`(() => {
        const frame = document.querySelector('iframe.main, iframe[class]');
        const doc = frame?.contentDocument ?? document;
        return !!doc.querySelector('[data-enso="settings-button"]');
      })()`);
    },
    { label: 'settings button' }
  );
  await cdp.eval(`(() => {
    const frame = document.querySelector('iframe.main, iframe[class]');
    const doc = frame?.contentDocument ?? document;
    doc.querySelector('[data-enso="settings-button"]').click();
    return true;
  })()`);
  await waitFor(() => hasText(cdp, '服务商'), { label: 'settings opened' }).catch(() => {});

  // 点进 providers 分类（设置侧栏）
  const navOk = await cdp.eval(`(() => {
    const frame = document.querySelector('iframe.main, iframe[class]');
    const doc = frame?.contentDocument ?? document;
    const nodes = [...doc.querySelectorAll('button, a, [role="button"]')];
    const target = nodes.find((n) => /服务商|模型/.test(n.textContent ?? '') && n.offsetParent !== null && n.closest('[class*="nav"], [class*="sidebar"], aside'));
    if (target) { target.click(); return 'nav'; }
    return null;
  })()`);
  if (navOk) await sleep(500);

  /* 添加服务商 */
  await waitFor(async () => hasText(cdp, 'Add model or provider') || hasText(cdp, '添加'), {
    timeout: 10_000,
    label: 'providers page',
  }).catch(() => {});
  await clickText(cdp, 'button', 'Add model or provider').catch(async () =>
    clickText(cdp, 'button', '添加')
  );
  await waitFor(() => hasText(cdp, 'Verify OAuth'), { label: 'wizard provider list' });
  await clickText(cdp, 'button', 'Verify OAuth');
  await waitFor(() => hasText(cdp, 'Provider subscription') || hasText(cdp, '订阅'), {
    label: 'method step',
  });
  await clickText(cdp, 'button', 'Provider subscription').catch(async () =>
    clickText(cdp, 'button', '订阅')
  );

  /* 开始登录：OauthProviderAccounts 里的登录按钮 */
  await waitFor(
    async () => {
      return cdp.eval(`(() => {
        const frame = document.querySelector('iframe.main, iframe[class]');
        const doc = frame?.contentDocument ?? document;
        return [...doc.querySelectorAll('button')].some((b) => /Sign in|Log in|登录|授权/.test(b.textContent ?? '') && b.offsetParent !== null);
      })()`);
    },
    { label: 'oauth login button' }
  );
  await cdp.eval(`(() => {
    const frame = document.querySelector('iframe.main, iframe[class]');
    const doc = frame?.contentDocument ?? document;
    const btn = [...doc.querySelectorAll('button')].find((b) => /Sign in|Log in|登录|授权/.test(b.textContent ?? '') && b.offsetParent !== null);
    btn.click();
    return true;
  })()`);

  /* 场景 1：等待 + 粘贴输入框 */
  await waitFor(async () => hasText(cdp, 'Waiting for browser authentication'), {
    label: 'waiting progress',
  });
  await waitFor(
    async () => {
      return cdp.eval(`(() => {
        const frame = document.querySelector('iframe.main, iframe[class]');
        const doc = frame?.contentDocument ?? document;
        return !!doc.querySelector('input[type="text"], input:not([type])');
      })()`);
    },
    { label: 'manual paste input' }
  );
  await sleep(400);
  await cdp.shot('/tmp/remote-oauth-1-waiting-input.png');
  check('shot 1 waiting+input', existsSync('/tmp/remote-oauth-1-waiting-input.png'));

  // 远程应已自动 window.open 完整授权链接（含 query）
  const opened = await waitFor(
    async () => {
      const urls = await cdp.eval('window.__openedUrls ?? []');
      return urls.length ? urls : null;
    },
    { timeout: 10_000, label: 'remote window.open auth url' }
  ).catch(() => []);
  const authUrl = opened[0] ?? '';
  check('remote auto-opened full auth url', /\/authorize\?/.test(authUrl) && /state=/.test(authUrl), authUrl.slice(0, 90));
  check('auth url keeps query (state/redirect_uri)', /redirect_uri=/.test(authUrl) && /client_id=/.test(authUrl));

  /* 场景 2：state 错误被拒 */
  if (authUrl) {
    const parsed = new URL(authUrl);
    const redirect = decodeURIComponent(parsed.searchParams.get('redirect_uri') ?? '');
    const state = parsed.searchParams.get('state') ?? '';
    const badUrl = `${redirect}?code=verify-code-1&state=wrong-state`;
    await fillInput(cdp, badUrl);
    // 提交（回车或按钮）
    await cdp.eval(`(() => {
      const frame = document.querySelector('iframe.main, iframe[class]');
      const doc = frame?.contentDocument ?? document;
      const input = doc.querySelector('input[type="text"], input:not([type])');
      const submit = [...doc.querySelectorAll('button')].find((b) => /^(Submit|提交)$/.test((b.textContent ?? '').trim()) && b.offsetParent !== null);
      if (submit) { submit.click(); return 'submit'; }
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      return 'enter';
    })()`);
    await sleep(900);
    await cdp.shot('/tmp/remote-oauth-2-state-error.png');
    check('shot 2 state error', existsSync('/tmp/remote-oauth-2-state-error.png'));

    /* 场景 3：粘贴成功完成登录 */
    const goodUrl = `${redirect}?code=verify-code-1&state=${encodeURIComponent(state)}`;
    // 输入框可能被清空重新渲染，重新填
    await fillInput(cdp, goodUrl).catch(() => {});
    await cdp.eval(`(() => {
      const frame = document.querySelector('iframe.main, iframe[class]');
      const doc = frame?.contentDocument ?? document;
      const submit = [...doc.querySelectorAll('button')].find((b) => /^(Submit|提交)$/.test((b.textContent ?? '').trim()) && b.offsetParent !== null);
      if (submit) { submit.click(); return 'submit'; }
      const input = doc.querySelector('input[type="text"], input:not([type])');
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      return 'enter';
    })()`);
    await waitFor(async () => hasText(cdp, 'Exchanging authorization code'), {
      timeout: 8_000,
      label: 'exchanging tokens',
    }).catch(() => {});
    const done = await waitFor(
      async () => (await hasText(cdp, 'Verify OAuth')) && !(await hasText(cdp, 'Waiting for browser')),
      { timeout: 10_000, label: 'login done' }
    ).catch(() => false);
    await sleep(600);
    await cdp.shot('/tmp/remote-oauth-3-paste-success.png');
    check('shot 3 paste success', existsSync('/tmp/remote-oauth-3-paste-success.png'));
    check('login reached exchange/done', !!done);
  }

  /* 场景 4：设备码显示 */
  // 回到服务商列表，选 Verify Device
  await cdp.eval(`(() => {
    const frame = document.querySelector('iframe.main, iframe[class]');
    const doc = frame?.contentDocument ?? document;
    const back = [...doc.querySelectorAll('button')].find((b) => /Back|返回/.test(b.textContent ?? '') && b.offsetParent !== null);
    back?.click();
    return !!back;
  })()`).catch(() => {});
  await sleep(400);
  // 关闭当前对话框再重开更稳：直接重开向导
  await cdp.eval(`(() => {
    const frame = document.querySelector('iframe.main, iframe[class]');
    const doc = frame?.contentDocument ?? document;
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  })()`).catch(() => {});
  await sleep(500);
  await clickText(cdp, 'button', 'Add model or provider').catch(async () =>
    clickText(cdp, 'button', '添加').catch(() => {})
  );
  const deviceVisible = await waitFor(() => hasText(cdp, 'Verify Device'), {
    timeout: 8_000,
    label: 'wizard verify device',
  }).catch(() => false);
  if (deviceVisible) {
    await clickText(cdp, 'button', 'Verify Device');
    await clickText(cdp, 'button', 'Provider subscription').catch(async () =>
      clickText(cdp, 'button', '订阅').catch(() => {})
    );
    await sleep(400);
    await cdp.eval(`(() => {
      const frame = document.querySelector('iframe.main, iframe[class]');
      const doc = frame?.contentDocument ?? document;
      const btn = [...doc.querySelectorAll('button')].find((b) => /Sign in|Log in|登录|授权/.test(b.textContent ?? '') && b.offsetParent !== null);
      btn?.click();
      return !!btn;
    })()`);
    await waitFor(() => hasText(cdp, 'WXYZ-1234'), { timeout: 10_000, label: 'device user code' }).catch(() => {});
    await sleep(500);
    await cdp.shot('/tmp/remote-oauth-4-device-code.png');
    check('shot 4 device code', existsSync('/tmp/remote-oauth-4-device-code.png'));
    const deviceShown = await hasText(cdp, 'WXYZ-1234');
    check('device code displayed', deviceShown);
  } else {
    check('shot 4 device code', false, 'Verify Device wizard not reached');
  }

  /* 收尾 */
  const failed = results.filter((r) => !r.ok);
  log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) log(`failed: ${f.name}`);
  log(`screenshots: /tmp/remote-oauth-*.png ; logs: ${OUT}`);

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
