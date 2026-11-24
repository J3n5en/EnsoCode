// 右侧面板开合时聊天区闪烁验收。隔离 dev 实例（临时 userData、拒绝 9222）。
//
//   node scripts/verify-sidepanel-flicker.mjs [--root <repo>] [--keep]
//
// 截图：
//   /tmp/pr508-toggle-mid.png
//   /tmp/pr508-scrolled-up.png
//   /tmp/pr508-drag.png
//   /tmp/pr508-collapsed.png
//   /tmp/pr508-expanded.png
// 断言失败非零退出。--keep 保留临时 userData。

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { uiElementElectron } from './verify-electron.mjs';
import { mergeOwnedPids, ownedProcessGroups } from './verify-secretary-isolation.mjs';

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const ROOT = path.resolve(flag('--root') ?? path.resolve(import.meta.dirname, '..'));

const VIEWPORT = { width: 1400, height: 900 };
const GAP_FOLLOW_MAX = 40;
const REVERSAL_AMP = 40;
const SHOTS = {
  mid: '/tmp/pr508-toggle-mid.png',
  scrolled: '/tmp/pr508-scrolled-up.png',
  drag: '/tmp/pr508-drag.png',
  collapsed: '/tmp/pr508-collapsed.png',
  expanded: '/tmp/pr508-expanded.png',
};

const children = [];
const trackedPids = [];
let artDir = null;
let devLogTail = '';
let fakeServer = null;
const providerHits = [];

function flag(name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数`);
  return value;
}

function log(line) {
  console.log(line);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function rememberOwned() {
  const processes = listProcesses();
  const roots = children.flatMap((child) => (Number.isInteger(child.pid) ? [child.pid] : []));
  const owned = mergeOwnedPids(trackedPids, processes, roots);
  trackedPids.length = 0;
  trackedPids.push(...owned);
  return { processes, owned: new Set(owned) };
}

function signalOwned(signal) {
  const { processes, owned } = rememberOwned();
  const selfGroup = processes.find((proc) => proc.pid === process.pid)?.pgid;
  for (const pgid of ownedProcessGroups(processes, [...owned])) {
    if (pgid === selfGroup) continue;
    try {
      process.kill(-pgid, signal);
    } catch {
      // 进程组已经没了
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

function isFatalIsolation(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /不属于|对不上|拒绝连接 9222/.test(message);
}

async function waitFor(fn, { timeout = 30_000, interval = 200, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      if (isFatalIsolation(error)) throw error;
      last = error;
    }
    await sleep(interval);
  }
  const detail = last instanceof Error ? last.message : JSON.stringify(last);
  throw new Error(`等待超时 ${label}${detail ? `: ${detail}` : ''}`);
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

async function reserveCdpPort() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = await freePort();
    if (port !== 9222) return port;
  }
  throw new Error('挑不到 CDP 端口（拒绝 9222）');
}

function listenPids(port) {
  const listed = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
  });
  if (listed.status !== 0) return [];
  return [
    ...new Set(
      listed.stdout
        .split('\n')
        .map((line) => Number(line.trim()))
        .filter(Boolean)
    ),
  ];
}

function processEnvText(pid) {
  const listed = spawnSync('ps', ['-Eww', '-p', String(pid)], { encoding: 'utf8' });
  return listed.status === 0 ? listed.stdout : '';
}

function processHasUserData(pid, userData) {
  if (processEnvText(pid).includes(userData)) return true;
  const opened = spawnSync('lsof', ['-nP', '-p', String(pid)], { encoding: 'utf8' });
  return opened.status === 0 && opened.stdout.includes(userData);
}

function assertIsolatedListener(port, userData) {
  if (port === 9222) throw new Error('拒绝连接 9222');
  const pids = listenPids(port);
  if (pids.length === 0) throw new Error(`端口 ${port} 没有监听进程`);
  const { processes, owned } = rememberOwned();
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  for (const pid of pids) {
    if (!owned.has(pid)) throw new Error(`端口 ${port} 的监听进程 ${pid} 不属于本次实例`);
    const chain = [];
    let current = pid;
    const seen = new Set();
    while (current && owned.has(current) && !seen.has(current)) {
      seen.add(current);
      chain.push(current);
      current = byPid.get(current)?.ppid;
    }
    if (!chain.some((candidate) => processHasUserData(candidate, userData))) {
      throw new Error(`端口 ${port} 的进程 ${pid} 对不上临时 userData`);
    }
  }
  return pids;
}

class Cdp {
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`ws 连接失败 ${wsUrl}`));
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
    ws.onclose = () => {
      for (const done of this.pending.values()) done({ error: { message: 'CDP socket closed' } });
      this.pending.clear();
    };
  }

  send(method, params = {}, timeout = 30_000) {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`CDP 已关闭 ${method}`));
        return;
      }
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp ${method} 超时`));
      }, timeout);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result ?? {});
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
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'evaluate 失败'
      );
    }
    return result.result?.value;
  }

  close() {
    this.ws.close();
  }
}

function writeFakeSettings(userData, baseUrl) {
  mkdirSync(userData, { recursive: true });
  const state = {
    providers: [
      {
        id: 'pv-A',
        name: 'Provider A',
        api: 'anthropic-messages',
        apiKey: 'sk-fake-A',
        baseUrl,
        enabled: true,
        models: [{ id: 'fake-model-1' }],
      },
    ],
    defaultModel: { providerId: 'pv-A', modelId: 'fake-model-1' },
    onboarded: true,
    theme: 'system',
    language: 'zh-CN',
    titleSummaryEnabled: false,
    autoCollapseTurns: false,
    collapseLiveActivity: false,
  };
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({ 'enso-settings': { state, version: 18 } })
  );
}

function pngSize(file) {
  const buf = readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function longChunks() {
  const chunks = [];
  for (let i = 1; i <= 420; i += 1) {
    if (i % 12 === 0) {
      chunks.push(
        `\n\n\`\`\`ts\nexport function block${i}(n: number) {\n  const value = n * ${i} + ${i * 17};\n  return value;\n}\n\`\`\`\n\n`
      );
    } else {
      chunks.push(
        `段落 ${i}。右侧面板开合时聊天区应贴底跟随，不应上下来回跳动。这一行故意写长以便换行撑高，序号 ${i}，虚拟列表要远高于视口。\n\n`
      );
    }
  }
  return chunks;
}

function sseWrite(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function textEvents(text) {
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: 'fake-model-1',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 8, output_tokens: 2 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
}

function messageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? []).map((part) => part?.text ?? '').join('\n');
}

function startFakeProvider() {
  const chunks = longChunks();
  const server = createHttpServer((req, res) => {
    const body = [];
    req.on('data', (chunk) => body.push(chunk));
    req.on('end', () => {
      const url = req.url || '';
      if (url.includes('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'fake-model-1' }] }));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(Buffer.concat(body).toString('utf8'));
      } catch {
        parsed = null;
      }
      const last = parsed?.messages?.at?.(-1);
      const text = messageText(last);
      const kind = text.includes('[[long]]')
        ? 'long'
        : text.includes('[[short]]')
          ? 'short'
          : 'other';
      providerHits.push({ at: Date.now(), url, kind, chars: text.length });
      log(`provider ${kind} ${url} chars=${text.length} n=${providerHits.length}`);
      if (kind !== 'long') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const reply = kind === 'short' ? `短答${providerHits.length}：先记下这一句。` : 'ok';
        for (const event of textEvents(reply)) sseWrite(res, event);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      sseWrite(res, textEvents('')[0]);
      sseWrite(res, {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      void (async () => {
        try {
          for (const chunk of chunks) {
            if (res.destroyed || res.writableEnded) return;
            sseWrite(res, {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: chunk },
            });
            await sleep(80);
          }
          if (res.destroyed || res.writableEnded) return;
          sseWrite(res, { type: 'content_block_stop', index: 0 });
          sseWrite(res, {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: chunks.length },
          });
          sseWrite(res, { type: 'message_stop' });
          res.end();
        } catch (error) {
          log(`provider stream ${error instanceof Error ? error.message : error}`);
          if (!res.writableEnded) res.end();
        }
      })();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      fakeServer = server;
      resolve(port);
    });
  });
}

async function pageTarget(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return (
    list.find((entry) => entry.type === 'page' && String(entry.url).includes('index.html')) ?? null
  );
}

async function connectPage(port) {
  const target = await pageTarget(port);
  if (!target?.webSocketDebuggerUrl) throw new Error('没有 index.html 页面目标');
  const cdp = await Cdp.open(target.webSocketDebuggerUrl);
  cdp.targetId = target.id;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return cdp;
}

async function waitForStablePage(port) {
  let page = null;
  let targetId = null;
  let streak = 0;
  try {
    return await waitFor(
      async () => {
        rememberOwned();
        const target = await pageTarget(port);
        if (!target) {
          streak = 0;
          return null;
        }
        if (!page || target.id !== targetId) {
          page?.close();
          page = await connectPage(port);
          targetId = target.id;
          streak = 0;
        }
        const ready = await page.eval(`(() => Boolean(
          window.__stores?.sessions?.getState &&
          window.__stores?.settings?.getState &&
          window.__stores?.sidePanel?.getState &&
          window.electronAPI &&
          document.readyState === 'complete' &&
          document.getElementById('root')
        ))()`);
        streak = ready === true ? streak + 1 : 0;
        return streak >= 3 ? page : null;
      },
      { timeout: 90_000, interval: 400, label: 'renderer 就绪' }
    );
  } catch (error) {
    page?.close();
    throw error;
  }
}

async function applyViewport(cdp) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return waitFor(
    async () => {
      const size = await cdp.eval(`(() => {
        window.dispatchEvent(new Event('resize'));
        return { w: window.innerWidth, h: window.innerHeight, v: document.visibilityState };
      })()`);
      const close =
        Math.abs(size.w - VIEWPORT.width) <= 2 && Math.abs(size.h - VIEWPORT.height) <= 2;
      return close ? size : null;
    },
    { timeout: 8_000, label: `视口 ${VIEWPORT.width}x${VIEWPORT.height}` }
  );
}

async function shoot(cdp, file) {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height, scale: 1 },
  });
  writeFileSync(file, Buffer.from(data, 'base64'));
  return pngSize(file);
}

function startDev(userData, cdpPort) {
  const electron = uiElementElectron(createRequire(path.join(ROOT, 'package.json'))('electron'));
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(ENSO_|ELECTRON_)/.test(key))
  );
  const child = spawn('pnpm', ['dev'], {
    cwd: ROOT,
    detached: true,
    env: {
      ...clean,
      ENSO_USER_DATA_DIR: userData,
      ENSO_CDP_PORT: String(cdpPort),
      ENSO_VERIFY: '1',
      ELECTRON_EXEC_PATH: electron,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  const collect = (buf) => {
    chunks.push(buf);
    if (chunks.length > 400) chunks.shift();
    devLogTail = Buffer.concat(chunks).toString('utf8').slice(-4000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  children.push(child);
  return child;
}

async function cleanup() {
  signalOwned('SIGTERM');
  await sleep(800);
  signalOwned('SIGKILL');
  await sleep(200);
  if (fakeServer) {
    await new Promise((resolve) => fakeServer.close(() => resolve()));
    fakeServer = null;
  }
  if (!artDir) return;
  if (KEEP) {
    log(`保留 ${artDir}`);
    return;
  }
  rmSync(artDir, { recursive: true, force: true });
  log(`已删除 ${artDir}`);
}

async function bootSession(cdp, projectPath) {
  const raw = await cdp.eval(`(async () => {
    const settings = window.__stores.settings;
    const sessions = window.__stores.sessions;
    const side = window.__stores.sidePanel;
    settings.setState({
      onboarded: true,
      language: 'zh-CN',
      titleSummaryEnabled: false,
      autoCollapseTurns: false,
      collapseLiveActivity: false,
    });
    const project = await settings.getState().addProject(${JSON.stringify(projectPath)});
    const id = await sessions.getState().newConversation(project.id);
    if (!id) return JSON.stringify({ ok: false, error: 'newConversation 返回空' });
    side.setState((state) => ({
      fullscreen: false,
      lastWidth: 420,
      uiByConversation: {
        ...state.uiByConversation,
        [id]: { ...(state.uiByConversation[id] ?? {}), open: false, width: 420 },
      },
      fullscreenByConversation: { ...state.fullscreenByConversation, [id]: false },
    }));
    return JSON.stringify({ ok: true, id, cwd: project.path });
  })()`);
  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error || '建会话失败');
  return parsed;
}

async function sendTurn(cdp, id, text, cwd) {
  const raw = await cdp.eval(`(async () => {
    const err = await window.__stores.sessions.getState().send(${JSON.stringify(text)}, {
      providerId: 'pv-A',
      modelId: 'fake-model-1',
      cwd: ${JSON.stringify(cwd)},
    }, undefined, ${JSON.stringify(id)});
    const row = window.__stores.sessions.getState().conversations[${JSON.stringify(id)}];
    return JSON.stringify({ err: err ?? null, status: row?.status ?? null, error: row?.error ?? null });
  })()`);
  const parsed = JSON.parse(raw);
  if (parsed.err) throw new Error(`send 被拒绝: ${parsed.err}`);
  return parsed;
}

function liveExpr(id) {
  return `(() => {
    const row = window.__stores.sessions.getState().conversations[${JSON.stringify(id)}];
    const scroller = document.querySelector('[data-enso="timeline"] [data-virtuoso-scroller]');
    const main = document.querySelector('[data-enso="main"]');
    const side = document.querySelector('[data-enso="side-panel"]');
    const gap = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : null;
    const back = [...document.querySelectorAll('button')].some((node) => (node.textContent || '').includes('回到底部'));
    return {
      status: row?.status ?? null,
      error: row?.error ?? null,
      messages: row?.messages?.length ?? 0,
      virtuoso: Boolean(scroller),
      sh: scroller ? scroller.scrollHeight : 0,
      ch: scroller ? scroller.clientHeight : 0,
      gap,
      back,
      text: scroller ? (scroller.innerText || '').length : 0,
      main: main ? Math.round(main.getBoundingClientRect().width) : 0,
      side: side ? Math.round(side.getBoundingClientRect().width) : 0,
      visibility: document.visibilityState,
    };
  })()`;
}

async function installProbe(cdp) {
  const ok = await cdp.eval(`(async () => {
    const mod = await import('/stores/layoutAnimation.ts');
    window.__layoutAnim = () => mod.isLayoutAnimating();
    window.__flicker = { frames: [], marks: [], opens: [], wheels: [], clicks: [], on: false, raf: 0 };
    const readBox = () => {
      const scroller = document.querySelector('[data-enso="timeline"] [data-virtuoso-scroller]');
      const main = document.querySelector('[data-enso="main"]');
      const side = document.querySelector('[data-enso="side-panel"]');
      const back = [...document.querySelectorAll('button')].some((node) =>
        (node.textContent || '').includes('回到底部')
      );
      let last = null;
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        let best = null;
        for (const el of scroller.querySelectorAll('[data-index]')) {
          const rect = el.getBoundingClientRect();
          if (rect.bottom <= box.top + 1 || rect.top >= box.bottom - 1) continue;
          if (!best || rect.bottom > best) best = rect.bottom;
        }
        if (best != null) last = Math.round((best - box.bottom) * 10) / 10;
      }
      const gap = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : null;
      return {
        t: Math.round(performance.now()),
        top: scroller ? Math.round(scroller.scrollTop * 10) / 10 : null,
        sh: scroller ? scroller.scrollHeight : null,
        ch: scroller ? scroller.clientHeight : null,
        gap: gap == null ? null : Math.round(gap * 10) / 10,
        last,
        main: main ? Math.round(main.getBoundingClientRect().width * 10) / 10 : null,
        side: side ? Math.round(side.getBoundingClientRect().width * 10) / 10 : null,
        back,
        anim: window.__layoutAnim(),
      };
    };
    const loop = () => {
      window.__flicker.frames.push(readBox());
      if (window.__flicker.frames.length > 6000) window.__flicker.frames.splice(0, 1000);
      if (window.__flicker.on) window.__flicker.raf = requestAnimationFrame(loop);
    };
    window.__flicker.start = () => {
      if (window.__flicker.on) return;
      window.__flicker.on = true;
      window.__flicker.raf = requestAnimationFrame(loop);
    };
    document.addEventListener('click', (event) => {
      const button = event.target?.closest?.('button[aria-label="折叠/展开右侧面板"], button[aria-label="Toggle side panel"]');
      if (!button) return;
      const box = () => {
        const main = document.querySelector('[data-enso="main"]');
        const side = document.querySelector('[data-enso="side-panel"]');
        return {
          main: main ? Math.round(main.getBoundingClientRect().width * 10) / 10 : null,
          side: side ? Math.round(side.getBoundingClientRect().width * 10) / 10 : null,
        };
      };
      const sync = box();
      const raf = [];
      let n = 0;
      window.__flicker.clicks.push({ i: window.__flicker.frames.length, t: Math.round(performance.now()) });
      const step = () => {
        raf.push(box());
        n += 1;
        if (n < 5) requestAnimationFrame(step);
        else window.__flicker.opens.push({ sync, raf, t: Math.round(performance.now()) });
      };
      requestAnimationFrame(step);
    }, true);
    window.addEventListener('wheel', (event) => {
      window.__flicker.wheels.push({
        i: window.__flicker.frames.length,
        t: Math.round(performance.now()),
        dy: event.deltaY,
        trusted: event.isTrusted,
      });
    }, { capture: true, passive: true });
    window.__flicker.start();
    return window.__layoutAnim() === false;
  })()`);
  if (ok !== true) throw new Error('layoutAnimation 探针没挂上');
}

async function mark(cdp, name) {
  await cdp.eval(
    `window.__flicker.marks.push({ name: ${JSON.stringify(name)}, i: window.__flicker.frames.length, t: Math.round(performance.now()) })`
  );
}

async function togglePoint(cdp) {
  return cdp.eval(`(() => {
    const button = [...document.querySelectorAll('button[aria-label="折叠/展开右侧面板"], button[aria-label="Toggle side panel"]')].find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    });
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
}

async function clickToggle(cdp) {
  const before = await cdp.eval(`(() => {
    const id = window.__stores.sessions.getState().activeId;
    return window.__stores.sidePanel.getState().uiByConversation[id]?.open === true;
  })()`);
  let point = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    point = await togglePoint(cdp);
    if (!point) throw new Error('找不到「折叠/展开右侧面板」');
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
    const flipped = await waitFor(
      async () => {
        const open = await cdp.eval(`(() => {
          const id = window.__stores.sessions.getState().activeId;
          return window.__stores.sidePanel.getState().uiByConversation[id]?.open === true;
        })()`);
        return open !== before ? true : null;
      },
      { timeout: 400, interval: 40, label: '侧栏开关生效' }
    ).catch(() => null);
    if (flipped) return point;
  }
  throw new Error('点击没有切换侧栏');
}

async function pressToggle(cdp) {
  const point = await togglePoint(cdp);
  if (!point) throw new Error('找不到「折叠/展开右侧面板」');
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
  return point;
}

async function scrollerPoint(cdp) {
  return cdp.eval(`(() => {
    const scroller = document.querySelector('[data-enso="timeline"] [data-virtuoso-scroller]');
    if (!scroller) return null;
    const rect = scroller.getBoundingClientRect();
    return {
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + Math.min(rect.height * 0.42, rect.height - 90)),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
  })()`);
}

async function handlePoint(cdp) {
  return cdp.eval(`(() => {
    const main = document.querySelector('[data-enso="main"]');
    if (!main) return null;
    const right = main.getBoundingClientRect().right;
    const mainBox = main.getBoundingClientRect();
    const grip = main.nextElementSibling?.querySelector?.('.cursor-col-resize') ?? null;
    const nodes = grip ? [grip] : [...document.querySelectorAll('.cursor-col-resize')];
    const hits = nodes.map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        x: rect.x + rect.width / 2,
        y: Math.min(Math.max(rect.y + 80, mainBox.top + 120), rect.bottom - 20),
        left: rect.left,
        h: rect.height,
        blocked: Boolean(el.closest('.pointer-events-none')),
      };
    }).filter((hit) => !hit.blocked && hit.h > 40 && hit.x > right - 16 && hit.x < right + 20);
    if (!hits[0]) return null;
    return { x: hits[0].x, y: hits[0].y, n: hits.length };
  })()`);
}

async function dragHandle(cdp, point) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
  const steps = [];
  for (let i = 1; i <= 8; i += 1) steps.push({ x: point.x - i * 14, y: point.y });
  for (let i = 1; i <= 6; i += 1) steps.push({ x: point.x - 112 + i * 10, y: point.y });
  let shot = null;
  for (let i = 0; i < steps.length; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: steps[i].x,
      y: steps[i].y,
      button: 'left',
      buttons: 1,
    });
    if (i === 6) shot = await shoot(cdp, SHOTS.drag);
    await sleep(90);
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: steps.at(-1).x,
    y: steps.at(-1).y,
    button: 'left',
    clickCount: 1,
  });
  return shot;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/** 离开贴底带后至少连续 2 帧才算一次，再回到带内计 1 次。单帧流式增量忽略。 */
function sustainedAway(series, band) {
  let away = 0;
  let trips = 0;
  let seen = false;
  for (const value of series) {
    if (typeof value !== 'number') continue;
    if (value > band) {
      away += 1;
      if (away === 2) seen = true;
    } else {
      if (seen) trips += 1;
      away = 0;
      seen = false;
    }
  }
  return trips;
}

function near(value, target, tol = 0.6) {
  return Math.abs(Math.abs(value) - target) <= tol;
}

function roundTrips(values, amp) {
  const nums = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (nums.length < 2) return { trips: 0, signFlips: 0, min: null, max: null };
  let trips = 0;
  let dir = 0;
  let extreme = nums[0];
  let sign = 0;
  let signAnchor = nums[0];
  let signFlips = 0;
  for (const value of nums) {
    const s = Math.abs(value) <= 8 ? 0 : Math.sign(value);
    if (
      s !== 0 &&
      sign !== 0 &&
      s !== sign &&
      Math.abs(value) > amp &&
      Math.abs(signAnchor) > amp
    ) {
      signFlips += 1;
    }
    if (s !== 0) {
      sign = s;
      signAnchor = value;
    }
    if (dir === 0) {
      if (Math.abs(value - extreme) >= amp) {
        dir = Math.sign(value - extreme);
        extreme = value;
      }
      continue;
    }
    const onward = dir > 0 ? value >= extreme : value <= extreme;
    if (onward) {
      extreme = value;
      continue;
    }
    if (Math.abs(value - extreme) >= amp) {
      trips += 1;
      dir = Math.sign(value - extreme);
      extreme = value;
    }
  }
  return { trips, signFlips, min: Math.min(...nums), max: Math.max(...nums) };
}

function sliceMarks(frames, marks, from, to) {
  const start = marks.find((mark) => mark.name === from);
  const end = to ? marks.find((mark) => mark.name === to) : null;
  if (!start) return [];
  return frames.filter((frame) => frame.t >= start.t && (!end || frame.t < end.t));
}

function firstFrameReport(sample) {
  const seq = [sample.sync, ...sample.raf];
  const steps = [];
  for (let i = 1; i < seq.length; i += 1) {
    steps.push({
      dm: round1(seq[i].main - seq[i - 1].main),
      ds: round1(seq[i].side - seq[i - 1].side),
    });
  }
  const issues = [];
  const travel = Math.abs(seq.at(-1).main - seq[0].main);
  steps.forEach((step, index) => {
    const residual = round1(step.dm + step.ds);
    const later = steps.slice(index + 1).some((item) => Math.abs(item.dm) > 12);
    const lone = (near(step.dm, 1, 0.35) || near(step.dm, 8, 0.35)) && Math.abs(step.ds) <= 0.35;
    if (lone && (later || travel > 20)) {
      issues.push(`第${index + 1}步主区单独跳 ${step.dm}px（侧栏 ${step.ds}）`);
    }
    if ((near(residual, 1, 0.35) || near(residual, 8, 0.35)) && Math.abs(step.ds) > 5) {
      issues.push(`第${index + 1}步主区+侧栏残余 ${residual}px`);
    }
  });
  return {
    sync: sample.sync,
    raf: sample.raf,
    issues,
    firstSame: Math.abs(sample.raf[0].main - sample.sync.main) <= 0.5,
  };
}

function summarizeToggles(frames, marks) {
  const toggles = marks.filter((mark) => mark.name.startsWith('toggle-'));
  return toggles
    .filter((mark) => mark.name !== 'toggle-wheel')
    .map((mark, index) => {
      const next = toggles[index + 1];
      const segment = frames.filter((frame) => frame.t >= mark.t && (!next || frame.t < next.t));
      let saw = false;
      const during = [];
      for (const frame of segment) {
        if (frame.anim) saw = true;
        if (saw && !frame.anim && during.length > 0 && during.at(-1).anim === false) break;
        during.push(frame);
        if (saw && !frame.anim) break;
      }
      const used = during.length >= 3 ? during : segment.slice(0, 24);
      const gap = roundTrips(
        used.map((frame) => frame.gap),
        REVERSAL_AMP
      );
      const top = roundTrips(
        used.map((frame) => frame.top),
        REVERSAL_AMP
      );
      const last = roundTrips(
        used.map((frame) => frame.last).filter((value) => value != null),
        REVERSAL_AMP
      );
      return {
        name: mark.name,
        frames: used.length,
        animFrames: used.filter((frame) => frame.anim).length,
        gap,
        top,
        last,
        main: used.slice(0, 5).map((frame) => frame.main),
        side: used.slice(0, 5).map((frame) => frame.side),
        gapSeries: used.map((frame) => Math.round(frame.gap ?? 0)),
        topSeries: used.map((frame) => Math.round(frame.top ?? 0)),
      };
    });
}

async function pullProbe(cdp) {
  const raw = await cdp.eval(`JSON.stringify({
    frames: window.__flicker.frames,
    marks: window.__flicker.marks,
    opens: window.__flicker.opens,
    wheels: window.__flicker.wheels,
    clicks: window.__flicker.clicks,
  })`);
  return JSON.parse(raw);
}

async function clickBack(cdp) {
  const point = await cdp.eval(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) =>
      (node.textContent || '').includes('回到底部')
    );
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  if (!point) throw new Error('没有「回到底部」按钮可点');
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
}

async function main() {
  if (!existsSync(path.join(ROOT, 'package.json'))) throw new Error(`找不到仓库 ${ROOT}`);
  if (!existsSync(path.join(ROOT, 'node_modules/.bin/electron-vite'))) {
    throw new Error(`缺少 ${path.join(ROOT, 'node_modules/.bin/electron-vite')}`);
  }
  artDir = mkdtempSync('/tmp/enso-pr508-');
  const userData = path.join(artDir, 'user-data');
  const projectPath = path.join(artDir, 'project');
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(path.join(projectPath, 'README.md'), 'side panel flicker verify\n');
  const providerPort = await startFakeProvider();
  writeFakeSettings(userData, `http://127.0.0.1:${providerPort}`);
  const cdpPort = await reserveCdpPort();
  log(`root ${ROOT}`);
  log(`userData ${userData}`);
  log(`provider ${providerPort}`);
  log(`cdp ${cdpPort}`);
  startDev(userData, cdpPort);

  await waitFor(
    async () => {
      rememberOwned();
      try {
        const target = await pageTarget(cdpPort);
        if (!target) return null;
        assertIsolatedListener(cdpPort, userData);
        return target;
      } catch (error) {
        if (String(error.message).includes('不属于') || String(error.message).includes('对不上'))
          throw error;
        return null;
      }
    },
    { timeout: 90_000, interval: 500, label: '隔离 CDP 页面' }
  );

  const cdp = await waitForStablePage(cdpPort);
  try {
    const size = await applyViewport(cdp);
    if (size.v !== 'visible') throw new Error(`visibility=${size.v}，焦点模拟没生效，鼠标验收无效`);
    const session = await bootSession(cdp, projectPath);
    log(`会话 ${session.id}`);
    await sendTurn(cdp, session.id, '用一句话回答。 [[short]]', session.cwd);
    await waitFor(
      async () => {
        const live = await cdp.eval(liveExpr(session.id));
        if (live.status === 'failed') throw new Error(`短答失败 ${live.error}`);
        return live.status === 'idle' && live.messages >= 2 ? live : null;
      },
      { timeout: 45_000, interval: 300, label: '短答结束' }
    );
    await sendTurn(cdp, session.id, '再答一句。 [[short]]', session.cwd);
    await waitFor(
      async () => {
        const live = await cdp.eval(liveExpr(session.id));
        if (live.status === 'failed') throw new Error(`第二句失败 ${live.error}`);
        return live.status === 'idle' && live.messages >= 4 ? live : null;
      },
      { timeout: 30_000, interval: 300, label: '第二句结束' }
    );
    await sendTurn(cdp, session.id, '请写很长的说明，慢慢写。 [[long]]', session.cwd);
    const tall = await waitFor(
      async () => {
        const live = await cdp.eval(liveExpr(session.id));
        if (live.status === 'failed') throw new Error(`长回复失败 ${live.error}`);
        if (!live.virtuoso) return null;
        if (
          live.sh > live.ch + 800 &&
          live.gap != null &&
          live.gap <= GAP_FOLLOW_MAX &&
          live.status === 'running'
        ) {
          return live;
        }
        return null;
      },
      { timeout: 40_000, interval: 200, label: '流式撑高并贴底' }
    );
    log(`贴底前 sh=${tall.sh} ch=${tall.ch} gap=${tall.gap} main=${tall.main} side=${tall.side}`);
    await installProbe(cdp);

    const gaps = [280, 45, 70, 35, 420, 80, 50, 380];
    for (let i = 0; i < gaps.length; i += 1) {
      await mark(cdp, `toggle-${i + 1}`);
      await clickToggle(cdp);
      if (i === 0) {
        await sleep(110);
        const png = await shoot(cdp, SHOTS.mid);
        log(`${SHOTS.mid} ${png.width}x${png.height}`);
      }
      await sleep(gaps[i]);
    }
    await sleep(500);
    await mark(cdp, 'follow-start');
    await sleep(350);
    await mark(cdp, 'follow-end');
    let collapsed = await cdp.eval(liveExpr(session.id));
    if (collapsed.side > 2) {
      await clickToggle(cdp);
      collapsed = await waitFor(
        async () => {
          const live = await cdp.eval(liveExpr(session.id));
          return live.side <= 2 ? live : null;
        },
        { timeout: 4_000, interval: 50, label: '收到收起态' }
      );
    }
    const collapsedPng = await shoot(cdp, SHOTS.collapsed);
    log(
      `${SHOTS.collapsed} ${collapsedPng.width}x${collapsedPng.height} main=${collapsed.main} side=${collapsed.side} gap=${collapsed.gap} back=${collapsed.back}`
    );

    const wheelAt = await scrollerPoint(cdp);
    if (!wheelAt) throw new Error('没有 Virtuoso scroller，不能上滚');
    await mark(cdp, 'toggle-wheel');
    const point = await togglePoint(cdp);
    if (!point) throw new Error('找不到「折叠/展开右侧面板」');
    const burst = [
      cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: point.x,
        y: point.y,
        button: 'left',
        clickCount: 1,
      }),
      cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: point.x,
        y: point.y,
        button: 'left',
        clickCount: 1,
      }),
      ...[-220, -220, -220].map((deltaY) =>
        cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: wheelAt.x,
          y: wheelAt.y,
          deltaX: 0,
          deltaY,
          pointerType: 'mouse',
        })
      ),
    ];
    await Promise.all(burst);
    await mark(cdp, 'after-wheel');
    await sleep(2000);
    await mark(cdp, 'after-wheel-wait');
    const scrolledPng = await shoot(cdp, SHOTS.scrolled);
    log(`${SHOTS.scrolled} ${scrolledPng.width}x${scrolledPng.height}`);

    await clickBack(cdp);
    await waitFor(
      async () => {
        const live = await cdp.eval(liveExpr(session.id));
        return live.gap != null && live.gap <= GAP_FOLLOW_MAX && !live.back ? live : null;
      },
      { timeout: 8_000, interval: 100, label: '点回到底部后重新贴底' }
    );
    let opened = await cdp.eval(liveExpr(session.id));
    if (opened.side < 200) {
      await pressToggle(cdp);
      opened = await waitFor(
        async () => {
          const live = await cdp.eval(liveExpr(session.id));
          return live.side > 200 ? live : null;
        },
        { timeout: 4_000, interval: 50, label: '拖拽前展开侧栏' }
      );
    }
    const expandedPng = await shoot(cdp, SHOTS.expanded);
    log(`${SHOTS.expanded} ${expandedPng.width}x${expandedPng.height}`);
    const handle = await waitFor(async () => handlePoint(cdp), {
      timeout: 3_000,
      interval: 80,
      label: '展开态 ResizeHandle',
    }).catch(async (error) => {
      const debug = await cdp.eval(`(() => {
        const main = document.querySelector('[data-enso="main"]');
        const next = main?.nextElementSibling;
        return {
          nextClass: next?.className ?? null,
          grips: [...document.querySelectorAll('.cursor-col-resize')].map((el) => {
            const rect = el.getBoundingClientRect();
            return { w: rect.width, h: rect.height, x: rect.x, blocked: Boolean(el.closest('.pointer-events-none')) };
          }),
        };
      })()`);
      throw new Error(`${error.message} ${JSON.stringify(debug)}`);
    });
    if (!handle) throw new Error('展开态找不到可拖的 ResizeHandle');
    await mark(cdp, 'drag-start');
    const dragPng = await dragHandle(cdp, handle);
    log(`${SHOTS.drag} ${dragPng.width}x${dragPng.height}`);
    await sleep(350);
    await mark(cdp, 'drag-end');
    const liveAfter = await cdp.eval(liveExpr(session.id));
    const probe = await pullProbe(cdp);

    const toggles = summarizeToggles(probe.frames, probe.marks);
    const follow = sliceMarks(probe.frames, probe.marks, 'follow-start', 'follow-end');
    const followTail = follow.filter((frame) => !frame.anim).slice(-12);
    const wheelFrames = sliceMarks(probe.frames, probe.marks, 'after-wheel', 'after-wheel-wait');
    const wheelMark = probe.marks.find((item) => item.name === 'toggle-wheel');
    const wheelClick = (probe.clicks ?? []).find((hit) => wheelMark && hit.t >= wheelMark.t);
    const wheelHit =
      probe.wheels.find((hit) => wheelMark && hit.t >= wheelMark.t) ?? probe.wheels.at(-1);
    const dragFrames = sliceMarks(probe.frames, probe.marks, 'drag-start', 'drag-end');
    const opens = probe.opens.map(firstFrameReport);
    const errors = [];

    if (!toggles.length) errors.push('没有采到开合片段');
    if (opens.length < 8) errors.push(`首帧样本只有 ${opens.length} 次点击，开关可能没点到`);
    const animTotal = toggles.reduce((sum, item) => sum + item.animFrames, 0);
    if (animTotal < 4) errors.push(`动画标记几乎没亮 animFrames=${animTotal}`);
    for (const item of toggles) {
      if (item.top.trips > 1) {
        errors.push(
          `${item.name} scrollTop 往返 ${item.top.trips} 次 >1（振幅>${REVERSAL_AMP}）${JSON.stringify(item.top)} ${item.topSeries.join(',')}`
        );
      }
      const sustained = sustainedAway(item.gapSeries, GAP_FOLLOW_MAX);
      if (sustained > 1) {
        errors.push(
          `${item.name} 距底离开 >${GAP_FOLLOW_MAX} 后再回来 ${sustained} 次（不含单帧流式增量）`
        );
      }
    }
    if (!followTail.length) errors.push('开合结束后没有静止采样');
    else {
      const gaps = followTail.map((frame) => frame.gap ?? 999).sort((a, b) => a - b);
      const gapMed = gaps[Math.floor(gaps.length / 2)];
      const gapLast = followTail.at(-1).gap ?? 999;
      const backed = followTail.some((frame) => frame.back);
      const grew = followTail.at(-1).sh > follow[0].sh - 1 || liveAfter.status === 'running';
      if (gapMed > GAP_FOLLOW_MAX) {
        errors.push(`开合结束后距底中位 ${gapMed} > ${GAP_FOLLOW_MAX}（末帧 ${gapLast}）`);
      }
      if (backed) errors.push('开合结束后仍显示回到底部');
      if (!grew) errors.push('开合结束后流式没有继续');
    }
    if (collapsed.side > 2) errors.push(`收起态侧栏宽 ${collapsed.side}，预期约 0`);
    opens.forEach((item, index) => {
      if (item.issues.length) errors.push(`开合${index + 1} 首帧: ${item.issues.join('；')}`);
    });
    let wheelNote = null;
    if (!wheelHit) errors.push(`滚轮没送到 visibility=${size.v} point=${JSON.stringify(wheelAt)}`);
    else {
      const origin = wheelClick?.i ?? wheelMark?.i ?? wheelHit.i;
      const frameDelta = wheelHit.i - origin;
      if (!wheelHit.trusted) errors.push('滚轮事件不是 trusted');
      if (frameDelta > 8) errors.push(`滚轮落在开合后第 ${frameDelta} 帧，已离开动画开头`);
      const tops = wheelFrames.map((frame) => frame.top).filter((value) => value != null);
      const gaps = wheelFrames.map((frame) => frame.gap).filter((value) => value != null);
      const beforeTop =
        probe.frames.find((frame) => frame.t >= (wheelMark?.t ?? 0))?.top ?? tops[0];
      const lifted = beforeTop != null && tops.length ? beforeTop - Math.min(...tops) : 0;
      if (lifted < 150) errors.push(`上滚只移动了 ${Math.round(lifted)}px`);
      if (!gaps.length || Math.min(...gaps) <= GAP_FOLLOW_MAX) {
        errors.push(`上滚后距底回到了 ${gaps.length ? Math.min(...gaps) : '空'}`);
      }
      if (!wheelFrames.at(-1)?.back) errors.push('上滚 2 秒后没有「回到底部」');
      let peak = gaps[0] ?? 0;
      let pulled = 0;
      let worstDrop = 0;
      for (const gap of gaps) {
        if (gap + 30 < peak) {
          pulled += 1;
          worstDrop = Math.max(worstDrop, peak - gap);
        }
        peak = Math.max(peak, gap);
      }
      if (gaps.length && Math.min(...gaps) < 120) {
        errors.push(
          `上滚后距底回到 ${Math.round(Math.min(...gaps))}（相对峰值回落 ${pulled} 帧，最大 ${Math.round(worstDrop)}px）`
        );
      }
      wheelNote = { pulled, worstDrop: Math.round(worstDrop) };
    }
    const dragSides = dragFrames.map((frame) => frame.side).filter((value) => value != null);
    const dragGaps = dragFrames.map((frame) => frame.gap).filter((value) => value != null);
    const dragTravel = dragSides.length ? Math.max(...dragSides) - Math.min(...dragSides) : 0;
    if (dragTravel < 40)
      errors.push(`拖拽侧栏只变了 ${Math.round(dragTravel)}px handle=${JSON.stringify(handle)}`);
    const dragSorted = [...dragGaps].sort((a, b) => a - b);
    const dragMed = dragSorted.length ? dragSorted[Math.floor(dragSorted.length / 2)] : 999;
    const dragLast = dragFrames.at(-1)?.gap ?? 999;
    const dragHot = dragGaps.filter((gap) => gap > 80).length;
    if (dragMed > GAP_FOLLOW_MAX || (dragGaps.length && dragHot > dragGaps.length * 0.2)) {
      errors.push(
        `拖拽距底中位 ${dragMed} last=${dragLast} max=${dragGaps.length ? Math.max(...dragGaps) : null} 尖峰帧 ${dragHot}`
      );
    }
    if (dragFrames.some((frame) => frame.back)) errors.push('拖拽期间出现回到底部');
    if (liveAfter.status !== 'running') errors.push(`结束时会话状态 ${liveAfter.status}，流式已停`);

    const report = {
      threshold: {
        reversalAmp: REVERSAL_AMP,
        failTrips:
          'scrollTop 振幅>40px 的往返 >1 次失败；距底只计持续 ≥2 帧的离开，单帧 ~50px 流式增量不算来回跳',
        followGap: `中位 <=${GAP_FOLLOW_MAX}，且不出现回到底部`,
        firstFrame: '首帧主区宽==动作前，或与侧栏同帧对冲；不允许单独 ±1/±8 后再平滑',
        wheel:
          '滚轮须在开合后 8 帧内（CDP 同批下发，实测往往落在第 4–6 帧，仍在 220ms 动画内）；之后 2s 距底不回到 ≤40 且出现回到底部',
        drag: `拖拽中位距底<=${GAP_FOLLOW_MAX}、无按钮；>80px 的帧不超过 20%`,
      },
      toggles: toggles.map((item) => ({
        name: item.name,
        frames: item.frames,
        animFrames: item.animFrames,
        gapTrips: item.gap.trips,
        gap: [item.gap.min, item.gap.max],
        topTrips: item.top.trips,
        top: [item.top.min, item.top.max],
        lastTrips: item.last.trips,
        lastSign: item.last.signFlips,
        last: [item.last.min, item.last.max],
        main5: item.main,
        side5: item.side,
        gapSeries: item.gapSeries,
        topSeries: item.topSeries,
      })),
      follow: {
        frames: followTail.length,
        gapMax: followTail.length ? Math.max(...followTail.map((frame) => frame.gap)) : null,
        gapLast: followTail.at(-1)?.gap ?? null,
        back: followTail.some((frame) => frame.back),
        sh0: follow[0]?.sh ?? null,
        sh1: followTail.at(-1)?.sh ?? null,
      },
      collapsed: {
        main: collapsed.main,
        side: collapsed.side,
        gap: collapsed.gap,
        back: collapsed.back,
      },
      firstFrames: opens.map((item) => ({
        sync: item.sync,
        raf: item.raf,
        firstSame: item.firstSame,
        issues: item.issues,
      })),
      wheel: wheelHit
        ? {
            frameDelta: wheelHit.i - (wheelClick?.i ?? wheelMark?.i ?? wheelHit.i),
            trusted: wheelHit.trusted,
            dy: wheelHit.dy,
            gapMin: wheelFrames.length ? Math.min(...wheelFrames.map((frame) => frame.gap)) : null,
            gapMax: wheelFrames.length ? Math.max(...wheelFrames.map((frame) => frame.gap)) : null,
            back: Boolean(wheelFrames.at(-1)?.back),
            ...(wheelNote ?? {}),
          }
        : null,
      drag: {
        travel: Math.round(dragTravel),
        gapMax: dragGaps.length ? Math.max(...dragGaps) : null,
        gapLast: dragFrames.at(-1)?.gap ?? null,
        back: dragFrames.some((frame) => frame.back),
        handle,
      },
      shots: SHOTS,
      providerHits: providerHits.length,
    };
    log(JSON.stringify(report, null, 2));
    assert.deepEqual(errors, []);
    log('PASS');
  } finally {
    cdp.close();
  }
}

let finishing = null;
function finish(code) {
  if (!finishing) {
    finishing = cleanup()
      .catch((error) => {
        console.error(error);
        code = 1;
      })
      .finally(() => process.exit(code));
  }
  return finishing;
}

process.on('SIGINT', () => void finish(130));
process.on('SIGTERM', () => void finish(143));
process.on('uncaughtException', (error) => {
  console.error(error);
  if (devLogTail) console.error(devLogTail);
  void finish(1);
});
process.on('unhandledRejection', (error) => {
  console.error(error);
  if (devLogTail) console.error(devLogTail);
  void finish(1);
});

setTimeout(() => {
  console.error('内部超时 175s');
  if (devLogTail) console.error(devLogTail);
  void finish(124);
}, 175_000);

main()
  .then(() => finish(0))
  .catch((error) => {
    console.error(error);
    if (devLogTail) console.error(devLogTail);
    return finish(1);
  });
