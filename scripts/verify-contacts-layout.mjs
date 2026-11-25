#!/usr/bin/env node
// 设置 → 联系方式与主人：分组卡片布局真机验收。
// 隔离 userData + fake provider + fake telegram + contact-fail 插件，不碰真实数据，也不连 9222。
//   node scripts/verify-contacts-layout.mjs [--before|--after] [--keep]
// 截图：/tmp/contacts-layout-{owner,channels,warn,narrow,en}-{before,after}.png
// --before：断言失败是预期，截图照拍，收集明细后非零退出。默认 --after。
// 整体 3 分钟硬超时（含 dev 冷启动）。SEC_VERIFY_KEEP=1 或 --keep 只留隔离目录。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { uiElementElectron } from './verify-electron.mjs';
import {
  explicitPort,
  keepRequested,
  mergeOwnedPids,
  ownedProcessGroups,
  reservePorts,
} from './verify-secretary-isolation.mjs';

const startedAt = Date.now();
const REPO = path.resolve(import.meta.dirname, '..');
const PHASE = process.argv.includes('--before') ? 'before' : 'after';
const KEEP = keepRequested(process.env, process.argv);
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const CHANNEL = 'enso.contactfail:wechat';
const SHOT = (name) => `/tmp/contacts-layout-${name}-${PHASE}.png`;

const ART = process.env.SEC_VERIFY_DIR?.trim() || mkdtempSync('/tmp/contacts-layout-');
const ENV = `${ART}-env`;
const settingsFile = path.join(ENV, 'settings.json');
const registryFile = path.join(ENV, 'agent', 'source-registry.json');

let CDP_PORT = 0;
let FAKE_PORT = 0;
let PLUGIN_PORT = 0;
let RENDERER_PORT = 0;
let TG_PORT = 0;
let portLease = null;
let pluginServer = null;
let telegram = null;
const children = [];
const trackedPids = [];
const failures = [];

const log = (message) =>
  console.log(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

setTimeout(() => {
  console.error(`\nFAIL contacts-layout: 3 分钟硬超时 (${Date.now() - startedAt}ms)`);
  try {
    signalOwned('SIGKILL');
  } catch {
    // 进程表读不到就直接退出
  }
  if (!KEEP) removeIsolate();
  process.exit(2);
}, 180_000).unref();

function removeIsolate() {
  for (const dir of [ENV, `${ENV}-proj`, ART]) {
    if (dir.startsWith('/tmp/')) rmSync(dir, { recursive: true, force: true });
  }
}

function check(ok, label, detail) {
  if (ok) {
    log(`  PASS ${label}`);
    return;
  }
  failures.push({ label, detail });
  log(`  FAIL ${label} ${JSON.stringify(detail)}`);
}

function listProcesses() {
  const listed = spawnSync('ps', ['-ax', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' });
  if (listed.status !== 0) return [];
  const processes = [];
  for (const line of listed.stdout.split('\n')) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !ppid || !pgid) continue;
    processes.push({ pid, ppid, pgid });
  }
  return processes;
}

function signalOwned(signal) {
  const processes = listProcesses();
  const roots = children.flatMap(({ child }) => (Number.isInteger(child.pid) ? [child.pid] : []));
  const owned = mergeOwnedPids(trackedPids, processes, roots);
  trackedPids.length = 0;
  trackedPids.push(...owned);
  const selfGroup = processes.find((proc) => proc.pid === process.pid)?.pgid;
  for (const pgid of ownedProcessGroups(processes, owned)) {
    if (pgid === selfGroup) continue;
    try {
      process.kill(-pgid, signal);
    } catch {
      // 这一组已经没人
    }
  }
  for (const pid of owned) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, signal);
    } catch {
      // 已经退出
    }
  }
}

function listenLoopback(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function waitFor(probe, label, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
}

function start(name, command, args, env) {
  const child = spawn(command, args, {
    cwd: REPO,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  const collect = (buf) => {
    chunks.push(buf.toString('utf8'));
    if (chunks.length > 400) chunks.shift();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  children.push({ name, child, chunks });
  return child;
}

async function stopAll() {
  await portLease?.release();
  portLease = null;
  pluginServer?.close();
  pluginServer = null;
  telegram?.server?.close();
  telegram = null;
  signalOwned('SIGTERM');
  await sleep(800);
  signalOwned('SIGKILL');
  await sleep(200);
}

let cleaning = null;
function cleanup() {
  if (!cleaning) {
    cleaning = (async () => {
      await stopAll();
      if (KEEP) {
        log(`  kept ${ART}`);
        return;
      }
      removeIsolate();
      log(`  removed ${ART}`);
    })();
  }
  return cleaning;
}

let finishing = null;
function finish(code) {
  if (!finishing) {
    finishing = (async () => {
      try {
        await cleanup();
      } catch (error) {
        console.error(error);
        code = 1;
      }
      process.exit(code);
    })();
  }
  return finishing;
}

const PRELUDE = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(80); }
  return null;
};
const box = (el) => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
};
const pxVar = (el, name) => {
  const raw = getComputedStyle(el).getPropertyValue(name).trim() || '1rem';
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;width:' + raw;
  el.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
};
`;

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const target = list.find((page) => page.type === 'page' && page.url.includes('index.html'));
  if (!target) throw new Error('index.html page target not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const resolve = pending.get(message.id);
    if (!resolve) return;
    pending.delete(message.id);
    resolve(message);
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const closedReply = () => ({ error: { message: 'CDP socket closed' } });
  socket.onclose = () => {
    for (const resolve of pending.values()) resolve(closedReply());
    pending.clear();
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      if (socket.readyState !== WebSocket.OPEN) return resolve(closedReply());
      const next = ++id;
      pending.set(next, resolve);
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (reply.error) throw new Error(`cdp ${reply.error.message}`);
    if (reply.result?.exceptionDetails) {
      const details = reply.result.exceptionDetails;
      throw new Error(
        `eval failed: ${details.exception?.description ?? JSON.stringify(details).slice(0, 800)}`
      );
    }
    return reply.result?.result?.value;
  };
  const writeShot = (file, data) => {
    if (!data) throw new Error(`empty screenshot ${file}`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    log(`  shot ${file}`);
  };
  return {
    send,
    evaluate,
    async json(body) {
      const raw = await evaluate(`(async () => { ${PRELUDE} ${body} })()`);
      return raw === undefined ? undefined : JSON.parse(raw);
    },
    async shot(file) {
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
      });
      writeShot(file, shot.result?.data);
    },
    async shotClip(file, rect) {
      const view = await evaluate(`({ w: window.innerWidth, h: window.innerHeight })`);
      const x = Math.max(0, Math.min(rect.x, Math.max(0, view.w - 1)));
      const y = Math.max(0, Math.min(rect.y, Math.max(0, view.h - 1)));
      const clip = {
        x,
        y,
        width: Math.max(1, Math.min(rect.width, view.w - x)),
        height: Math.max(1, Math.min(rect.height, view.h - y)),
        scale: 1,
      };
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        clip,
      });
      if (!shot.result?.data) throw new Error(`shotClip ${JSON.stringify(shot.error ?? clip)}`);
      writeShot(file, shot.result.data);
    },
    close: () => socket.close(),
  };
}

async function prepareEnv() {
  rmSync(ENV, { recursive: true, force: true });
  rmSync(ART, { recursive: true, force: true });
  mkdirSync(ART, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['.agents/skills/enso-cdp/scripts/mk-env.mjs', ENV, '1'],
      {
        cwd: REPO,
        stdio: 'inherit',
      }
    );
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`mk-env exited ${code}`))
    );
  });
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  settings['enso-settings'].state.secretaryEnabled = true;
  for (const provider of settings['enso-settings'].state.providers ?? []) {
    provider.baseUrl = `http://127.0.0.1:${FAKE_PORT}`;
  }
  writeFileSync(settingsFile, JSON.stringify(settings));
  log(`  ${ENV}`);
}

async function servePluginZip() {
  const source = path.join(REPO, 'scripts/fixtures/contact-fail-plugin');
  const target = path.join(ART, 'contact-fail-plugin.zip');
  await new Promise((resolve, reject) => {
    const child = spawn('zip', ['-qr', target, '.'], { cwd: source, stdio: 'ignore' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`zip exited ${code}`))));
  });
  const zip = readFileSync(target);
  const server = createHttpServer((request, response) => {
    if (request.url !== '/contact-fail-plugin.zip') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/zip' });
    response.end(zip);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PLUGIN_PORT, '127.0.0.1', resolve);
  });
  pluginServer = server;
  return `http://127.0.0.1:${PLUGIN_PORT}/contact-fail-plugin.zip`;
}

async function startFakeTelegram(port) {
  const state = { sent: [], queue: [], waiters: [] };
  const me = { id: 424242, is_bot: true, username: 'enso_verify_bot', first_name: 'Enso Verify' };
  const push = (update) => {
    const waiter = state.waiters.shift();
    if (waiter) waiter(update ? [update] : []);
    else if (update) state.queue.push(update);
  };
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let done = false;
      const reply = (payload) => {
        if (done) return;
        done = true;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(
        new URL(request.url || '/', 'http://127.0.0.1').pathname
      );
      if (!match || match[1] !== TOKEN) {
        reply({ ok: false, error_code: 401, description: 'Unauthorized' });
        return;
      }
      const method = match[2];
      if (method === 'getMe') return reply({ ok: true, result: me });
      if (method === 'getUpdates') {
        if (state.queue.length > 0) return reply({ ok: true, result: state.queue.splice(0) });
        const timer = setTimeout(() => {
          state.waiters = state.waiters.filter((entry) => entry !== finish);
          reply({ ok: true, result: [] });
        }, 1500);
        const finish = (updates) => {
          clearTimeout(timer);
          reply({ ok: true, result: updates });
        };
        state.waiters.push(finish);
        response.on('close', () => {
          clearTimeout(timer);
          state.waiters = state.waiters.filter((entry) => entry !== finish);
        });
        return;
      }
      if (method === 'sendMessage') {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          body = {};
        }
        state.sent.push(body);
        return reply({ ok: true, result: { message_id: state.sent.length } });
      }
      reply({ ok: true, result: true });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { push, server, state };
}

async function startDev() {
  start('dev', 'pnpm', ['dev'], {
    ENSO_USER_DATA_DIR: ENV,
    ENSO_CDP_PORT: String(CDP_PORT),
    ENSO_RENDERER_PORT: String(RENDERER_PORT),
    ENSO_VERIFY: '1',
    ELECTRON_EXEC_PATH: uiElementElectron(createRequire(import.meta.url)('electron')),
    ENSO_TELEGRAM_API_BASE: `http://127.0.0.1:${TG_PORT}`,
  });
  await waitFor(
    async () => {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        return list.some((entry) => entry.type === 'page' && entry.url.includes('index.html'));
      } catch {
        return false;
      }
    },
    'dev CDP page',
    120_000,
    400
  );
  await waitFor(
    () => existsSync(path.join(ENV, 'DevToolsActivePort')) && existsSync(registryFile),
    'isolated userData markers',
    20_000,
    200
  );
  if (CDP_PORT === 9222) throw new Error('拒绝使用 9222');
  const portFile = path.join(ENV, 'DevToolsActivePort');
  const line = readFileSync(portFile, 'utf8').split(/\r?\n/)[0].trim();
  if (Number(line) !== CDP_PORT) {
    throw new Error(`DevToolsActivePort ${portFile} = ${line}，不是本次 CDP ${CDP_PORT}`);
  }
  log(`  DevToolsActivePort ${portFile} -> ${line}`);
}

async function waitForStableRenderer() {
  let page = null;
  let targetId = null;
  let streak = 0;
  try {
    return await waitFor(
      async () => {
        try {
          const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
          const target = list.find(
            (entry) => entry.type === 'page' && entry.url.includes('index.html')
          );
          if (!target) {
            streak = 0;
            return false;
          }
          if (!page || target.id !== targetId) {
            page?.close();
            page = await connect();
            targetId = target.id;
            streak = 0;
          }
          const ready = await page.evaluate(`(() => Boolean(
            window.__stores?.settings?.getState &&
            window.electronAPI?.secretary?.create &&
            document.readyState === 'complete' &&
            document.getElementById('root')
          ))()`);
          streak = ready === true ? streak + 1 : 0;
          return streak >= 2 ? page : false;
        } catch {
          streak = 0;
          page?.close();
          page = null;
          targetId = null;
          return false;
        }
      },
      'renderer ready',
      45_000,
      250
    );
  } catch (error) {
    page?.close();
    throw error;
  }
}

async function viewport(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return waitFor(
    async () => {
      const size = await cdp.evaluate(`(() => {
        window.dispatchEvent(new Event('resize'));
        return { w: window.innerWidth, h: window.innerHeight };
      })()`);
      return Math.abs(size.w - width) <= 2 && Math.abs(size.h - height) <= 2 ? size : null;
    },
    `viewport ${width}x${height}`,
    8_000,
    100
  );
}

function inside(inner, outer, tol = 2) {
  if (!inner || !outer) return false;
  return (
    inner.x >= outer.x - tol &&
    inner.y >= outer.y - tol &&
    inner.right <= outer.right + tol &&
    inner.bottom <= outer.bottom + tol
  );
}

async function scene(cdp, zipUrl) {
  const page = (body) => cdp.json(body);
  log('== 建秘书');
  const created = await page(`
    const ready = await until(() => window.electronAPI?.secretary?.create, 15000);
    if (!ready) return JSON.stringify({ ok: false, error: 'secretary API missing' });
    const result = await window.electronAPI.secretary.create();
    if (!result.ok) return JSON.stringify(result);
    const state = await window.electronAPI.secretary.contactState(result.secretaryId);
    return JSON.stringify({
      ok: Boolean(state && result.secretaryId),
      secretaryId: result.secretaryId,
      enabled: state?.enabled ?? null,
      channels: (state?.channels ?? []).map((item) => item.id),
    });
  `);
  if (!created?.ok) throw new Error(`建秘书失败 ${JSON.stringify(created)}`);
  const secretaryId = created.secretaryId;
  log(`  secretary ${secretaryId}`);

  log('== 装微信样式失败插件');
  const installed = await page(`
    const staged = await window.electronAPI.extensionPlugins.stageFromUrl(${JSON.stringify(zipUrl)});
    if (!staged.ok) return JSON.stringify({ ok: false, error: staged.error, step: 'stage' });
    const committed = await window.electronAPI.extensionPlugins.commit(staged.preview.token);
    if (!committed.ok) return JSON.stringify({ ok: false, error: committed.error, step: 'commit' });
    const enabled = await window.electronAPI.extensionPlugins.setEnabled('enso.contactfail', true);
    if (!enabled.ok) return JSON.stringify({ ok: false, error: enabled.error, step: 'enable' });
    const api = window.electronAPI.secretary;
    const id = ${JSON.stringify(secretaryId)};
    const card = async () => (await api.contactState(id)).channels.find((item) => item.id === ${JSON.stringify(CHANNEL)});
    let connected = null;
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      connected = await card();
      if (connected?.status === 'connected') break;
      await sleep(200);
    }
    if (connected?.status !== 'connected') return JSON.stringify({ ok: false, error: 'not connected', card: connected });
    const master = await api.contactSettings({ enabled: true }, id);
    const prefs = await api.contactSettings({
      channelId: ${JSON.stringify(CHANNEL)},
      prefs: { enabled: true, push: true, syncMirror: true },
    }, id);
    return JSON.stringify({ ok: master.ok && prefs.ok, master, prefs, card: await card() });
  `);
  if (!installed?.ok) throw new Error(`插件渠道没就绪 ${JSON.stringify(installed)}`);
  log(`  ${CHANNEL} connected`);

  log('== 绑定 Telegram');
  const code = await page(`
    const api = window.electronAPI.secretary;
    const id = ${JSON.stringify(secretaryId)};
    const bound = await api.contactBind(${JSON.stringify(TOKEN)}, id);
    if (!bound.ok) return JSON.stringify({ ok: false, error: bound.error });
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      const state = await api.contactState(id);
      const value = state.telegram?.bind?.code;
      if (value) return JSON.stringify({ ok: true, code: value });
      await sleep(150);
    }
    return JSON.stringify({ ok: false, error: 'no bind code', state: await api.contactState(id) });
  `);
  if (!code?.ok) throw new Error(`没有绑定码 ${JSON.stringify(code)}`);
  telegram.push({
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: 777001, type: 'private' },
      from: { id: 777001, username: 'j3n5en', first_name: 'J' },
      text: `/start ${code.code}`,
    },
  });
  const bound = await waitFor(
    async () => {
      const probe = await page(`
        const state = await window.electronAPI.secretary.contactState(${JSON.stringify(secretaryId)});
        return JSON.stringify({ status: state?.telegram?.status ?? null });
      `);
      return probe.status === 'bound' ? probe : null;
    },
    'telegram bound',
    20_000,
    250
  );
  log(`  telegram ${bound.status}`);

  log('== 微信渠道发送失败一次');
  const tested = await page(`
    const api = window.electronAPI.secretary;
    const id = ${JSON.stringify(secretaryId)};
    const result = await api.contactTest(id, ${JSON.stringify(CHANNEL)});
    const end = Date.now() + 8000;
    let card = null;
    while (Date.now() < end) {
      card = (await api.contactState(id)).channels.find((item) => item.id === ${JSON.stringify(CHANNEL)});
      if (card?.outbound?.state === 'degraded') break;
      await sleep(200);
    }
    return JSON.stringify({
      ok: card?.outbound?.state === 'degraded',
      result,
      outbound: card?.outbound ?? null,
    });
  `);
  if (!tested?.ok) throw new Error(`出站没有进入 degraded ${JSON.stringify(tested)}`);
  log(`  outbound ${tested.outbound.state} ${tested.outbound.detail ?? ''}`);

  log('== 打开联系方式设置');
  await openContacts(cdp, secretaryId);

  const desktop = await measure(cdp);
  await shotCard(
    cdp,
    'owner',
    '[data-settings-row="contacts.owner"] [data-slot="settings-group"]',
    '[data-enso=secretary-contact-owner]'
  );
  await shotCard(
    cdp,
    'channels',
    '[data-settings-row="contacts.channels"] [data-slot="settings-group"]',
    '[data-enso=secretary-contact-channel]'
  );
  await shotWarn(cdp);

  log('== 窄宽度 480');
  await viewport(cdp, 480, 900);
  await sleep(150);
  const narrow = await measure(cdp);
  await cdp.shot(SHOT('narrow'));

  log('== 英文');
  let live = cdp;
  let english;
  try {
    english = await captureEnglish(live);
  } catch (error) {
    log(`  英文步骤中断，重连后再拍: ${error.message}`);
    try {
      live.close();
    } catch {
      // 原来的页已经没了
    }
    live = await waitForStableRenderer();
    await openContacts(live, secretaryId);
    english = await captureEnglish(live);
  }
  assertLayout(desktop, narrow, english);
  return live;
}

async function captureEnglish(cdp) {
  await viewport(cdp, 1280, 900);
  await cdp.evaluate(`window.__stores.settings.getState().setLanguage('en')`);
  await sleep(500);
  const english = await measure(cdp);
  await cdp.shot(SHOT('en'));
  await cdp.evaluate(`window.__stores.settings.getState().setLanguage('zh')`);
  return english;
}

async function openContacts(cdp, secretaryId) {
  await viewport(cdp, 1280, 900);
  const opened = await cdp.json(`
    localStorage.setItem('enso-settings-secretary', ${JSON.stringify(secretaryId)});
    localStorage.removeItem('enso.secretary.contact.collapsed');
    const view = await import('/stores/appView.ts');
    view.openSettings({ category: 'contacts' });
    const pick = () => document.querySelector('[data-enso=secretary-settings-pick][data-secretary-id=${JSON.stringify(secretaryId)}]');
    const sceneReady = () =>
      document.querySelector('[data-enso=secretary-contact-bound]') &&
      document.querySelector('[data-channel="${CHANNEL}"] [data-enso=secretary-contact-outbound]');
    let ready = await until(sceneReady, 4000);
    if (!ready) {
      pick()?.click();
      ready = await until(sceneReady, 8000);
    }
    const open = (id) => {
      const card = document.querySelector('[data-channel="' + id + '"]');
      const toggle = card?.querySelector('[data-enso=secretary-contact-channel-toggle]');
      if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click();
    };
    open('telegram');
    open(${JSON.stringify(CHANNEL)});
    await sleep(200);
    return JSON.stringify({
      owner: Boolean(document.querySelector('[data-enso=secretary-contact-github-logins]')),
      bound: Boolean(document.querySelector('[data-enso=secretary-contact-bound]')),
      warn: Boolean(document.querySelector('[data-channel="${CHANNEL}"] [data-enso=secretary-contact-outbound]')),
      picks: [...document.querySelectorAll('[data-enso=secretary-settings-pick]')].map((node) => ({
        id: node.getAttribute('data-secretary-id'),
        selected: node.getAttribute('data-selected') ?? null,
      })),
      tgExpanded: document.querySelector('[data-channel=telegram] [data-enso=secretary-contact-channel-toggle]')?.getAttribute('aria-expanded') ?? null,
      wxExpanded: document.querySelector('[data-channel="${CHANNEL}"] [data-enso=secretary-contact-channel-toggle]')?.getAttribute('aria-expanded') ?? null,
    });
  `);
  log(`  page ${JSON.stringify(opened)}`);
  if (!opened?.owner || !opened.bound || !opened.warn) {
    throw new Error(`联系方式页没有绑到这次的秘书 ${JSON.stringify(opened)}`);
  }
}

async function shotWarn(cdp) {
  const rect = await cdp.json(`
    const notice = document.querySelector('[data-channel="${CHANNEL}"] [data-enso=secretary-contact-outbound]');
    notice?.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(80);
    const node = document.querySelector('[data-channel="${CHANNEL}"] [data-enso=secretary-contact-outbound]');
    const card = node?.closest('[data-slot="settings-group"]');
    const n = box(node);
    const g = box(card);
    if (!n) return JSON.stringify(null);
    return JSON.stringify({
      x: g ? g.x : n.x,
      y: Math.max(0, n.y - 12),
      width: g ? g.width : n.width,
      height: n.height + 24,
    });
  `);
  const file = SHOT('warn');
  if (!rect) {
    log('  warn 没有可截区域，改拍整页');
    await cdp.shot(file);
    failures.push({ label: 'warn clip', detail: null });
    return;
  }
  try {
    await cdp.shotClip(file, rect);
  } catch (error) {
    log(`  warn clip 失败，改拍整页: ${error.message}`);
    await cdp.shot(file);
    failures.push({ label: 'warn clip', detail: error.message });
  }
}

async function measure(cdp) {
  return cdp.json(`
    const ownerSection = document.querySelector('[data-settings-row="contacts.owner"]');
    const ownerCard = ownerSection?.querySelector('[data-slot="settings-group"]')
      ?? document.querySelector('[data-enso=secretary-contact-owner]')?.closest('[data-slot="settings-group"]');
    const input = document.querySelector('[data-enso=secretary-contact-github-logins]');
    const save = document.querySelector('[data-enso=secretary-contact-github-save]');
    const inputBox = box(input);
    const cardBox = box(ownerCard);
    const hairlines = [];
    if (ownerCard) {
      const seen = new Set();
      for (const el of [
        ...ownerCard.querySelectorAll(':scope > *'),
        ...ownerCard.querySelectorAll('[data-slot="settings-row"]'),
      ]) {
        if (seen.has(el)) continue;
        seen.add(el);
        const style = getComputedStyle(el, '::before');
        const content = style.content;
        const height = Number.parseFloat(style.height);
        if (content && content !== 'none' && content !== 'normal' && height === 1) {
          hairlines.push({
            slot: el.getAttribute('data-slot'),
            enso: el.getAttribute('data-enso'),
            height: style.height,
          });
        }
      }
    }
    const radio = ownerSection?.querySelector('[role="radiogroup"]');
    const warn = document.querySelector('[data-channel="${CHANNEL}"] [data-enso=secretary-contact-outbound]');
    const warnBoxEl = warn?.closest('[data-slot="settings-group"]') ?? warn?.closest('[data-enso=secretary-contact-channel]');
    const warnBox = box(warn);
    const warnCard = box(warnBoxEl);
    const channels = ['telegram', ${JSON.stringify(CHANNEL)}].map((id) => {
      const card = document.querySelector('[data-channel="' + id + '"]');
      const group = card?.closest('[data-slot="settings-group"]');
      const sub = card?.querySelector('[data-slot="settings-sub-group"]')
        ?? card?.closest('[data-slot="settings-expandable"]')?.querySelector('[data-slot="settings-sub-group"]');
      const subBox = box(sub);
      const inset = group ? pxVar(group, '--settings-divider-inset') : null;
      const rows = [...(card?.querySelectorAll('[data-slot="settings-row"]') ?? [])].map((row) => {
        const style = getComputedStyle(row);
        return {
          enso: row.parentElement?.getAttribute('data-enso') ?? row.getAttribute('data-enso'),
          padL: Number.parseFloat(style.paddingLeft) || 0,
          padR: Number.parseFloat(style.paddingRight) || 0,
        };
      });
      return {
        id,
        expanded: card?.querySelector('[data-enso=secretary-contact-channel-toggle]')?.getAttribute('aria-expanded') ?? null,
        subGroup: Boolean(subBox && subBox.height > 8),
        inset,
        rows,
      };
    });
    const scroller = document.querySelector('[data-enso=settings-scroll]');
    return JSON.stringify({
      viewport: {
        w: window.innerWidth,
        h: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        settingsScrollWidth: scroller?.scrollWidth ?? null,
        settingsClientWidth: scroller?.clientWidth ?? null,
      },
      owner: {
        card: cardBox,
        input: inputBox,
        save: box(save),
        inputInset: cardBox && inputBox
          ? { left: inputBox.x - cardBox.x, right: cardBox.right - inputBox.right }
          : null,
        hairlines,
        radiogroup: {
          found: Boolean(radio),
          radios: radio ? radio.querySelectorAll('[role="radio"]').length : 0,
          label: radio?.getAttribute('aria-label') ?? null,
        },
      },
      warn: {
        found: Boolean(warn),
        left: warnBox && warnCard ? warnBox.x - warnCard.x : null,
        right: warnBox && warnCard ? warnCard.right - warnBox.right : null,
        padL: warn ? Number.parseFloat(getComputedStyle(warn).paddingLeft) || 0 : null,
        text: warn?.innerText?.slice(0, 180) ?? null,
      },
      channels,
    });
  `);
}

async function shotCard(cdp, name, selector, fallback) {
  const read = () =>
    cdp.json(`
    const el = document.querySelector(${JSON.stringify(selector)})
      ?? document.querySelector(${JSON.stringify(fallback)});
    el?.scrollIntoView({ block: 'start', inline: 'nearest' });
    await sleep(80);
    const target = document.querySelector(${JSON.stringify(selector)})
      ?? document.querySelector(${JSON.stringify(fallback)});
    return JSON.stringify(box(target));
  `);
  let rect = await read();
  const file = SHOT(name);
  if (!rect || rect.width < 2 || rect.height < 2) {
    log(`  ${name} 没有可截区域，改拍整页`);
    await cdp.shot(file);
    failures.push({ label: `${name} clip`, detail: rect });
    return;
  }
  if (rect.y < 0 || rect.y + rect.height > 860) {
    await viewport(cdp, 1280, Math.min(2600, Math.max(900, Math.ceil(rect.height + 280))));
    rect = await read();
  }
  try {
    await cdp.shotClip(file, rect);
  } catch (error) {
    log(`  ${name} clip 失败，改拍整页: ${error.message}`);
    await cdp.shot(file);
    failures.push({ label: `${name} clip`, detail: error.message });
  }
}

function assertLayout(desktop, narrow, english) {
  const owner = desktop?.owner;
  // 分组行范式：输入框与保存按钮同行排在尾部，只要求「不越出卡片」而不是对称全宽
  const inputInside = inside(owner?.input, owner?.card, 2);
  const saveInside = inside(owner?.save, owner?.card, 2);
  const enInputInside = inside(english?.owner?.input, english?.owner?.card, 2);
  const enSaveInside = inside(english?.owner?.save, english?.owner?.card, 2);
  check(
    Boolean(inputInside && saveInside && enInputInside && enSaveInside),
    '主人身份卡：输入框与保存按钮完整收进卡片（中英文同）',
    {
      input: owner?.input,
      save: owner?.save,
      card: owner?.card,
      enInput: english?.owner?.input ?? null,
      enSave: english?.owner?.save ?? null,
      enCard: english?.owner?.card ?? null,
    }
  );
  check(
    (owner?.hairlines?.length ?? 0) >= 1,
    '主人身份卡：相邻行之间有 1px 发丝线',
    owner?.hairlines ?? null
  );
  check(
    owner?.radiogroup?.found === true && owner.radiogroup.radios >= 2,
    '外部渠道的非主人消息：分段控件 role=radiogroup',
    owner?.radiogroup ?? null
  );
  const warn = desktop?.warn;
  // 通栏横幅（左右 inset 相等且 ≤2）或左右对称内嵌（>0 且差 ≤4）都算对齐；
  // 破版是 before 那种左贴边右留空的单边距
  const warnAligned =
    typeof warn?.left === 'number' &&
    typeof warn?.right === 'number' &&
    Math.abs(warn.left - warn.right) <= 4 &&
    (warn.left <= 2 ? warn.padL >= 10 : warn.left > 0);
  check(warn?.found === true && warnAligned, '微信警告块左右间距对称，文字不贴边', warn);
  const channelProblems = [];
  for (const channel of desktop?.channels ?? []) {
    if (channel.expanded === 'false') {
      channelProblems.push({ id: channel.id, error: 'collapsed' });
      continue;
    }
    if (channel.subGroup) continue;
    const insetPx = channel.inset;
    const rows = channel.rows ?? [];
    const aligned =
      rows.length > 0 &&
      rows.every(
        (row) =>
          Math.abs(row.padL - row.padR) <= 2 &&
          insetPx !== null &&
          Math.abs(row.padL - insetPx) <= 2
      );
    if (!aligned) channelProblems.push({ id: channel.id, subGroup: false, inset: insetPx, rows });
  }
  check(
    channelProblems.length === 0,
    '渠道展开区是 settings-sub-group，或开关行左右 inset 与卡片间距一致',
    {
      channels: desktop?.channels,
      problems: channelProblems,
    }
  );

  const narrowOwner = narrow?.owner;
  const docOk = (narrow?.viewport?.scrollWidth ?? 9999) <= 481;
  const scrollerOverflow =
    narrow?.viewport?.settingsScrollWidth != null &&
    narrow.viewport.settingsScrollWidth > narrow.viewport.settingsClientWidth + 1;
  const inputOk = inside(narrowOwner?.input, narrowOwner?.card, 2);
  check(docOk && !scrollerOverflow && inputOk, '480px 无横向滚动，输入框不溢出卡片', {
    viewport: narrow?.viewport,
    inputInset: narrowOwner?.inputInset,
    input: narrowOwner?.input,
    card: narrowOwner?.card,
  });
}

async function main() {
  const requested = {
    cdp: explicitPort('SEC_VERIFY_CDP_PORT', process.env.SEC_VERIFY_CDP_PORT),
    fake: explicitPort('SEC_VERIFY_FAKE_PORT', process.env.SEC_VERIFY_FAKE_PORT),
    plugin: explicitPort('SEC_VERIFY_PLUGIN_PORT', process.env.SEC_VERIFY_PLUGIN_PORT),
    renderer: explicitPort('SEC_VERIFY_RENDERER_PORT', process.env.SEC_VERIFY_RENDERER_PORT),
    telegram: explicitPort('SEC_VERIFY_TG_PORT', process.env.SEC_VERIFY_TG_PORT),
  };
  if (requested.cdp === 9222) throw new Error('拒绝使用 9222');
  for (let attempt = 1; attempt <= 5; attempt++) {
    portLease = await reservePorts(requested, listenLoopback);
    if (portLease.ports.cdp !== 9222) break;
    await portLease.release();
    portLease = null;
    if (attempt === 5) throw new Error('拒绝使用 9222');
  }
  CDP_PORT = portLease.ports.cdp;
  FAKE_PORT = portLease.ports.fake;
  PLUGIN_PORT = portLease.ports.plugin;
  RENDERER_PORT = portLease.ports.renderer;
  TG_PORT = portLease.ports.telegram;
  log(`== contacts layout (${PHASE})`);
  log(`  dir ${ART}`);
  log(
    `  ports cdp=${CDP_PORT} fake=${FAKE_PORT} plugin=${PLUGIN_PORT} renderer=${RENDERER_PORT} telegram=${TG_PORT}`
  );

  await prepareEnv();
  await portLease.release('plugin');
  const zipUrl = await servePluginZip();
  await portLease.release('fake');
  start('fake-provider', process.execPath, ['scripts/fake-provider-issue-27.mjs'], {
    FAKE_PROVIDER_PORT: String(FAKE_PORT),
  });
  await waitFor(
    async () => {
      try {
        return (await fetch(`http://127.0.0.1:${FAKE_PORT}/__requests`)).ok;
      } catch {
        return false;
      }
    },
    'fake provider',
    15_000
  );
  await portLease.release('telegram');
  telegram = await startFakeTelegram(TG_PORT);
  await portLease.release('cdp');
  await portLease.release('renderer');
  await startDev();
  const cdp = await waitForStableRenderer();
  try {
    const live = await scene(cdp, zipUrl);
    if (live && live !== cdp) cdp.close = live.close.bind(live);
  } finally {
    cdp.close();
  }
  log(`\n== ${PHASE} 断言失败 ${failures.length} 条，耗时 ${Date.now() - startedAt}ms`);
  if (failures.length > 0) {
    console.error(JSON.stringify(failures, null, 2));
    if (PHASE === 'before') log('RED（--before 预期失败），截图已拍');
    await finish(1);
    return;
  }
  log('PASS');
  await finish(0);
}

process.on('SIGINT', () => {
  void finish(130);
});
process.on('SIGTERM', () => {
  void finish(143);
});
process.on('uncaughtException', (error) => {
  console.error(error);
  void finish(1);
});
process.on('unhandledRejection', (error) => {
  console.error(error);
  void finish(1);
});

main().catch(async (error) => {
  console.error(`\nFAIL ${error.message}`);
  for (const { name, chunks } of children) {
    if (chunks.length === 0) continue;
    console.error(`--- ${name} (tail) ---`);
    console.error(chunks.join('').slice(-2000));
  }
  await finish(1);
});
