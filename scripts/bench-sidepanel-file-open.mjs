// 会话区文件超链接打开侧栏 Files tab 的掉帧基准。隔离实例（临时 userData、拒绝 9222）。
//
//   node scripts/bench-sidepanel-file-open.mjs [--prod] [--runs 3] [--profile] [--label x] [--json out.json] [--keep]
//
// --prod 跑 out/ 产物（先 `VITE_ENSO_EXPOSE_STORES=1 pnpm build`），缺省跑 pnpm dev。
// 场景：collapsed（侧栏收起）、open-no-files（侧栏开、无 Files tab）、files-md / files-ts-line（已有 Files tab）。
// 每个场景记录点击后 rAF 帧间隔 p50/p95/max、>50ms 帧数、LongTask/TBT、点击到目标内容可见耗时。
// --profile 额外各跑一遍 CPU Profile（不计入帧统计），输出自耗时与包含耗时排行。

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
const PROD = argv.includes('--prod');
const PROFILE = argv.includes('--profile');
const HOLD = argv.includes('--hold');
const ROOT = path.resolve(flag('--root') ?? path.resolve(import.meta.dirname, '..'));
const RUNS = Number(flag('--runs') ?? 3);
const LABEL = flag('--label') ?? (PROD ? 'prod' : 'dev');
const JSON_OUT = flag('--json');
const FIXTURE_REF = 'aa13684fcbfe6bef9bc5d93311567ee25f18ac8b';
const VIEWPORT = { width: 1440, height: 900 };
const PANEL_WIDTH = 640;
const WINDOW_MS = 2500;
const TURNS = 12;

const LINKS = {
  tsLine: {
    label: 'FilesView.tsx 第 900 行',
    rel: 'src/renderer/components/sidepanel/FilesView.tsx',
    line: 900,
  },
  tsBig: { label: 'agent.ts 入口', rel: 'src/main/ipc/agent.ts', line: 1 },
  md: { label: '秘书实施计划', rel: 'docs/project-history/2026-11-13-secretary-impl-plan.md' },
  tsLine2: {
    label: 'SidePanel.tsx 第 1200 行',
    rel: 'src/renderer/components/sidepanel/SidePanel.tsx',
    line: 1200,
  },
};
const SCENARIOS = [
  { id: 'collapsed', link: 'tsLine', setup: 'collapsed' },
  { id: 'open-no-files', link: 'tsBig', setup: 'open' },
  { id: 'files-md', link: 'md', setup: 'keep' },
  { id: 'files-ts-line', link: 'tsLine2', setup: 'keep' },
];

const children = [];
const trackedPids = [];
let artDir = null;
let devLogTail = '';
let fakeServer = null;
let finishing = null;

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
    secretaryEnabled: false,
    autoCollapseTurns: false,
    collapseLiveActivity: false,
  };
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({ 'enso-settings': { state, version: 18 } })
  );
}

/** 会话链接的行号写法是 `path:行`（`#L` 片段按设计剥掉，见 markdownLinks.test.ts） */
function linkHref(link) {
  return link.line && link.line > 1 ? `${link.rel}:${link.line}` : link.rel;
}

function replyText(turn) {
  const parts = [`## 第 ${turn} 轮排查记录\n`];
  for (let i = 1; i <= 24; i += 1) {
    if (i % 6 === 0) {
      parts.push(
        `\`\`\`ts\nexport function step${turn}_${i}(input: string[]): number {\n  let total = 0;\n  for (const item of input) total += item.length * ${i};\n  return total;\n}\n\`\`\`\n`
      );
    } else {
      parts.push(
        `- 第 ${turn}.${i} 条：会话区里的文件链接点开后应在右侧 Files 面板里直接显示源码，这一行写长一点让它换行撑高，序号 ${turn}-${i}。\n`
      );
    }
  }
  parts.push('\n相关文件：\n');
  for (const link of Object.values(LINKS)) parts.push(`- [${link.label}](${linkHref(link)})\n`);
  return parts.join('\n');
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

function startFakeProvider() {
  let turn = 0;
  const server = createHttpServer((req, res) => {
    req.on('data', () => {});
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
      turn += 1;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      for (const event of textEvents(replyText(turn))) sseWrite(res, event);
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      fakeServer = server;
      resolve(server.address().port);
    });
  });
}

function writeFixture(projectPath) {
  const paths = [
    'src/renderer/components/sidepanel',
    'src/renderer/components/chat',
    'src/main/ipc',
    'docs/project-history/2026-11-13-secretary-impl-plan.md',
  ];
  const archive = spawnSync('git', ['archive', FIXTURE_REF, ...paths], {
    cwd: ROOT,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (archive.status !== 0) throw new Error(`git archive 失败 ${archive.stderr}`);
  const untar = spawnSync('tar', ['-x', '-C', projectPath], { input: archive.stdout });
  if (untar.status !== 0) throw new Error(`tar 失败 ${untar.stderr}`);
  writeFileSync(path.join(projectPath, 'README.md'), 'file link open bench\n');
  for (const link of Object.values(LINKS)) {
    const text = readFileSync(path.join(projectPath, link.rel), 'utf8');
    if (link.rel.endsWith('.md')) {
      const heading = text.split('\n').find((line) => /^#{1,3} \S/.test(line));
      link.expect = { kind: 'md', text: heading.replace(/^#+\s*/, '').trim() };
    } else {
      const lines = text.split('\n');
      let line = link.line;
      while (!lines[line - 1]?.trim()) line += 1;
      link.expect = { kind: 'code', line, text: lines[line - 1].trim().slice(0, 40) };
    }
    link.bytes = Buffer.byteLength(text);
    link.original = text;
  }
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
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return cdp;
}

const READY_EXPR = `(() => Boolean(
  window.__stores?.sessions?.getState &&
  window.__stores?.settings?.getState &&
  window.__stores?.sidePanel?.getState &&
  window.electronAPI &&
  document.readyState === 'complete' &&
  document.getElementById('root')
))()`;

async function waitForStablePage(port) {
  let page = null;
  let targetId = null;
  let streak = 0;
  return waitFor(
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
      streak = (await page.eval(READY_EXPR)) === true ? streak + 1 : 0;
      return streak >= 3 ? page : null;
    },
    { timeout: 120_000, interval: 400, label: 'renderer 就绪' }
  );
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

function launch(userData, cdpPort) {
  const electron = uiElementElectron(createRequire(path.join(ROOT, 'package.json'))('electron'));
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(ENSO_|ELECTRON_)/.test(key))
  );
  const env = {
    ...clean,
    ENSO_USER_DATA_DIR: userData,
    ENSO_CDP_PORT: String(cdpPort),
    ENSO_VERIFY: '1',
  };
  const child = PROD
    ? spawn(electron, ['.'], { cwd: ROOT, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('pnpm', ['dev'], {
        cwd: ROOT,
        detached: true,
        env: { ...env, ELECTRON_EXEC_PATH: electron },
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
}

async function bootSession(cdp, projectPath) {
  const raw = await cdp.eval(`(async () => {
    const settings = window.__stores.settings;
    const sessions = window.__stores.sessions;
    settings.setState({ onboarded: true, language: 'zh-CN', titleSummaryEnabled: false });
    const project = await settings.getState().addProject(${JSON.stringify(projectPath)});
    const id = await sessions.getState().newConversation(project.id);
    if (!id) return JSON.stringify({ ok: false, error: 'newConversation 返回空' });
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
    return JSON.stringify({ err: err ?? null });
  })()`);
  const parsed = JSON.parse(raw);
  if (parsed.err) throw new Error(`send 被拒绝: ${parsed.err}`);
}

function convExpr(id) {
  return `(() => {
    const row = window.__stores.sessions.getState().conversations[${JSON.stringify(id)}];
    return { status: row?.status ?? null, error: row?.error ?? null, messages: row?.messages?.length ?? 0 };
  })()`;
}

const PROBE = `(() => {
  if (window.__bench) return true;
  const b = (window.__bench = { frames: [], lts: [], expect: null, hit: null, downAt: null });
  const side = () => document.querySelector('[data-enso="side-panel"]');
  const check = (t) => {
    const e = b.expect;
    const panel = side();
    if (!panel) return;
    if (e.kind === 'md') {
      if (panel.textContent.includes(e.text)) b.hit = { visible: t, highlighted: t };
      return;
    }
    const box = panel.getBoundingClientRect();
    for (const host of panel.querySelectorAll('diffs-container')) {
      const line = host.shadowRoot?.querySelector('[data-line="' + e.line + '"]');
      if (!line || !line.textContent.includes(e.text)) continue;
      const r = line.getBoundingClientRect();
      if (r.height <= 0 || r.top < box.top || r.bottom > box.bottom) continue;
      if (!b.hit) b.hit = { visible: t };
      if (line.querySelector('span[style]')) b.hit.highlighted = t;
    }
  };
  const loop = (t) => {
    const panel = side();
    b.frames.push([t, panel ? Math.round(panel.getBoundingClientRect().width) : 0]);
    if (b.frames.length > 30000) b.frames.splice(0, 10000);
    if (b.expect && b.downAt != null && !b.hit?.highlighted) check(t);
    requestAnimationFrame(loop);
  };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) b.lts.push([entry.startTime, entry.duration]);
  }).observe({ type: 'longtask' });
  document.addEventListener('pointerdown', () => {
    if (b.expect && b.downAt == null) b.downAt = performance.now();
  }, true);
  requestAnimationFrame(loop);
  return true;
})()`;

async function linkPoint(cdp, label) {
  return cdp.eval(`(() => {
    const anchors = [...document.querySelectorAll('[data-enso="timeline"] a')].filter(
      (node) => (node.textContent || '').trim() === ${JSON.stringify(label)}
    );
    const node = anchors.at(-1);
    if (!node) return null;
    let rect = node.getBoundingClientRect();
    if (rect.top < 60 || rect.bottom > innerHeight - 160) {
      node.scrollIntoView({ block: 'center' });
      rect = node.getBoundingClientRect();
    }
    return { x: rect.x + Math.min(rect.width / 2, 30), y: rect.y + rect.height / 2 };
  })()`);
}

async function click(cdp, point) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: point.x,
      y: point.y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
    });
  }
}

const SIDE_EXPR = (id) => `(() => {
  const side = window.__stores.sidePanel.getState();
  const panel = document.querySelector('[data-enso="side-panel"]');
  return {
    active: window.__stores.sessions.getState().activeId,
    open: side.uiByConversation[${JSON.stringify(id)}]?.open === true,
    width: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
    tabs: panel ? panel.querySelectorAll('.dv-tab').length : 0,
    menu: document.querySelectorAll('[role="menu"]').length,
  };
})()`;

/** 清掉会话的面板布局并按 open 设定开合，再整页重载：每轮都从冷 renderer、无 Files tab 开始 */
async function resetAndReload(cdp, id, open) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await cdp.eval(`(() => {
      const id = ${JSON.stringify(id)};
      window.__stores.sidePanel.setState((s) => ({
        fullscreen: false,
        layouts: { ...s.layouts, [id]: undefined },
        lastWidth: ${PANEL_WIDTH},
        uiByConversation: { ...s.uiByConversation, [id]: { open: ${open}, width: ${PANEL_WIDTH} } },
        fullscreenByConversation: { ...s.fullscreenByConversation, [id]: false },
        newTabMenuPrompt: null,
      }));
      return true;
    })()`);
    await sleep(400);
    await cdp.send('Page.reload', {});
    await sleep(500);
    await waitFor(async () => ((await cdp.eval(READY_EXPR)) === true ? true : null), {
      timeout: 60_000,
      interval: 300,
      label: '重载就绪',
    });
    await applyViewport(cdp);
    const side = await waitFor(
      async () => {
        const state = await cdp.eval(SIDE_EXPR(id));
        if (state.active !== id) return null;
        return state;
      },
      { timeout: 20_000, interval: 300, label: '会话恢复' }
    );
    if (side.tabs === 0 && side.open === open) {
      await cdp.eval(PROBE);
      await waitFor(async () => linkPoint(cdp, LINKS.tsLine.label), {
        timeout: 30_000,
        label: '文件链接渲染',
      });
      if (side.menu > 0) {
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Escape',
          code: 'Escape',
          windowsVirtualKeyCode: 27,
        });
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Escape',
          code: 'Escape',
          windowsVirtualKeyCode: 27,
        });
      }
      await sleep(2000);
      const settled = await cdp.eval(SIDE_EXPR(id));
      if (settled.menu > 0) throw new Error('新建标签菜单没关掉，会吃掉链接点击');
      return settled;
    }
    log(`重置未生效 tabs=${side.tabs} open=${side.open}，重试`);
  }
  throw new Error('重置侧栏失败');
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function frameStats(frames, from, to) {
  const inWin = frames.filter(([t]) => t >= from && t <= to);
  const before = frames.filter(([t]) => t < from).at(-1);
  const seq = before ? [before, ...inWin] : inWin;
  const gaps = [];
  for (let i = 1; i < seq.length; i += 1) gaps.push(seq[i][0] - seq[i - 1][0]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    frames: gaps.length,
    p50: r1(pct(sorted, 0.5)),
    p95: r1(pct(sorted, 0.95)),
    max: r1(sorted.at(-1) ?? 0),
    over50: gaps.filter((g) => g > 50).length,
    dropped: gaps.reduce((sum, g) => sum + Math.max(0, Math.round(g / 16.67) - 1), 0),
  };
}

function animWindow(frames, from, to) {
  const inWin = frames.filter(([t]) => t >= from && t <= to);
  let start = null;
  let end = null;
  for (let i = 1; i < inWin.length; i += 1) {
    if (inWin[i][1] !== inWin[i - 1][1]) {
      start ??= inWin[i - 1][0];
      end = inWin[i][0];
    }
  }
  return start == null ? null : { start, end };
}

async function measure(cdp, scenario, { profile } = {}) {
  const link = LINKS[scenario.link];
  await cdp.eval(
    `(() => { const b = window.__bench; b.expect = ${JSON.stringify(link.expect)}; b.hit = null; b.downAt = null; return true; })()`
  );
  const point = await linkPoint(cdp, link.label);
  if (!point) throw new Error(`找不到链接 ${link.label}`);
  await sleep(300);
  if (profile) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');
  }
  await click(cdp, point);
  const hit = await waitFor(
    async () => {
      const state = await cdp.eval(
        '(() => ({ hit: window.__bench.hit, downAt: window.__bench.downAt, now: performance.now() }))()'
      );
      if (state.downAt == null) return null;
      if (state.hit?.highlighted) return state;
      return state.now - state.downAt > 6_000 ? state : null;
    },
    { timeout: 15_000, interval: 50, label: `${scenario.id} 内容可见` }
  );
  const floor = Math.max(hit.downAt + WINDOW_MS, (hit.hit?.highlighted ?? hit.downAt) + 600);
  const stats = await collectWindow(cdp, hit.downAt, floor, profile);
  const miss = hit.hit?.highlighted
    ? null
    : await cdp.eval(`(() => {
        const e = window.__bench.expect;
        const panel = document.querySelector('[data-enso="side-panel"]');
        const hosts = panel ? [...panel.querySelectorAll('diffs-container')] : [];
        return hosts.map((host) => {
          const lines = [...(host.shadowRoot?.querySelectorAll('[data-line]') ?? [])].map((n) => Number(n.getAttribute('data-line')));
          const target = host.shadowRoot?.querySelector('[data-line="' + e.line + '"]');
          const scroller = host.closest('[style*="overflow"]');
          return {
            lines: lines.length,
            min: Math.min(...lines),
            max: Math.max(...lines),
            target: target ? { text: target.textContent.slice(0, 60), top: Math.round(target.getBoundingClientRect().top), spans: target.querySelectorAll('span[style]').length } : null,
            scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
            scrollHeight: scroller ? scroller.scrollHeight : null,
            editable: Boolean(host.shadowRoot?.querySelector('[contenteditable="true"]')),
            active: document.activeElement ? document.activeElement.tagName + (document.activeElement === host ? ':host' : '') : null,
            shadowActive: host.shadowRoot?.activeElement ? host.shadowRoot.activeElement.tagName : null,
            expect: e,
          };
        });
      })()`);
  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  return {
    scenario: scenario.id,
    file: link.rel,
    bytes: link.bytes,
    visibleMs: r1(hit.hit?.visible != null ? hit.hit.visible - hit.downAt : null),
    highlightedMs: r1(hit.hit?.highlighted != null ? hit.hit.highlighted - hit.downAt : null),
    ...stats,
    miss,
  };
}

/** 窗口至少到 floor，且延到主线程连续 800ms 无长任务：长任务跨出窗口时它造成的帧缺口也要算进来 */
async function collectWindow(cdp, from, floor, profile) {
  let end = 0;
  for (;;) {
    const state = await cdp.eval(`(() => {
      const lts = window.__bench.lts;
      const last = lts.length ? lts[lts.length - 1] : null;
      return { now: performance.now(), ltEnd: last ? last[0] + last[1] : 0 };
    })()`);
    if (state.now >= floor && state.now - state.ltEnd >= 800) {
      end = state.now;
      break;
    }
    await sleep(150);
  }
  let cpu = null;
  if (profile) {
    const { profile: data } = await cdp.send('Profiler.stop', {}, 60_000);
    await cdp.send('Profiler.disable');
    cpu = data;
  }
  const raw = await cdp.eval(
    `(() => ({ frames: window.__bench.frames.filter(([t]) => t >= ${from - 200}), lts: window.__bench.lts.filter(([s, d]) => s + d >= ${from}) }))()`
  );
  const lts = raw.lts.filter(([s]) => s <= end);
  const anim = animWindow(raw.frames, from, end);
  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  return {
    anim: anim
      ? { ms: r1(anim.end - anim.start), ...frameStats(raw.frames, anim.start, anim.end) }
      : null,
    ...frameStats(raw.frames, from, end),
    longTasks: lts.length,
    longTaskMs: r1(lts.reduce((sum, [, d]) => sum + d, 0)),
    longestTask: r1(lts.reduce((max, [, d]) => Math.max(max, d), 0)),
    tbt: r1(lts.reduce((sum, [, d]) => sum + Math.max(0, d - 50), 0)),
    windowMs: r1(end - from),
    cpu,
  };
}

const TYPED = 'zqzqzq';

/** 已打开 SidePanel.tsx 的编辑器里点中一行、逐字输入再 Cmd+S：量输入掉帧，并验证编辑与保存可用 */
async function measureTyping(cdp, projectPath, { profile } = {}) {
  const link = LINKS.tsLine2;
  const point = await cdp.eval(`(() => {
    const panel = document.querySelector('[data-enso="side-panel"]');
    if (!panel) return null;
    const box = panel.getBoundingClientRect();
    for (const host of panel.querySelectorAll('diffs-container')) {
      const lines = [...(host.shadowRoot?.querySelectorAll('[data-line]') ?? [])].filter((node) => {
        const r = node.getBoundingClientRect();
        return r.height > 0 && r.top > box.top + 60 && r.bottom < box.bottom - 60 && (node.textContent || '').trim().length > 8;
      });
      const line = lines[Math.floor(lines.length / 2)];
      if (!line) continue;
      const spans = line.querySelectorAll('span');
      const last = spans[spans.length - 1] ?? line;
      const r = last.getBoundingClientRect();
      // 长行会横向溢出面板，点在面板外会让编辑器失焦
      return { x: Math.min(r.right - 1, box.right - 24), y: r.top + r.height / 2, line: Number(line.getAttribute('data-line')) };
    }
    return null;
  })()`);
  if (!point) throw new Error('编辑器里找不到可点的行');
  await click(cdp, point);
  await sleep(400);
  if (profile) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');
  }
  const from = await cdp.eval('performance.now()');
  for (const ch of TYPED) {
    await cdp.send('Input.insertText', { text: ch });
    await sleep(120);
  }
  const stats = await collectWindow(cdp, from, from + WINDOW_MS, profile);
  const typed = await cdp.eval(`(() => {
    const panel = document.querySelector('[data-enso="side-panel"]');
    for (const host of panel?.querySelectorAll('diffs-container') ?? []) {
      const line = host.shadowRoot?.querySelector('[data-line="${point.line}"]');
      if (line) return line.textContent;
    }
    return null;
  })()`);
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 's',
    code: 'KeyS',
    windowsVirtualKeyCode: 83,
    modifiers: 4,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 's',
    code: 'KeyS',
    windowsVirtualKeyCode: 83,
    modifiers: 4,
  });
  const file = path.join(projectPath, link.rel);
  const saved = await waitFor(() => (readFileSync(file, 'utf8').includes(TYPED) ? true : null), {
    timeout: 5_000,
    interval: 100,
    label: 'Cmd+S 落盘',
  }).catch(() => false);
  writeFileSync(file, link.original);
  return {
    scenario: 'files-type',
    file: link.rel,
    bytes: link.bytes,
    visibleMs: null,
    highlightedMs: null,
    typedOk: typeof typed === 'string' && typed.includes(TYPED),
    savedOk: saved === true,
    ...stats,
  };
}

function shortUrl(url) {
  if (!url) return '';
  const clean = url.replace(/\?.*$/, '');
  const idx = clean.search(/\/(src|node_modules|renderer|assets)\//);
  return idx >= 0
    ? clean.slice(idx + 1).replace(/^node_modules\/\.pnpm\/[^/]+\/node_modules\//, '')
    : clean.split('/').slice(-2).join('/');
}

function analyzeProfile(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parent.set(child, node.id);
  const keyOf = (node) => {
    const frame = node.callFrame;
    return `${frame.functionName || '(anonymous)'} ${shortUrl(frame.url)}:${frame.lineNumber + 1}`;
  };
  const self = new Map();
  const total = new Map();
  let busy = 0;
  for (let i = 0; i < profile.samples.length; i += 1) {
    const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000;
    let node = nodes.get(profile.samples[i]);
    const leaf = keyOf(node);
    if (/^\((idle|program|root)\)/.test(leaf)) continue;
    busy += dt;
    self.set(leaf, (self.get(leaf) ?? 0) + dt);
    const seen = new Set();
    while (node) {
      const key = keyOf(node);
      if (!seen.has(key)) {
        seen.add(key);
        total.set(key, (total.get(key) ?? 0) + dt);
      }
      node = nodes.get(parent.get(node.id));
    }
  }
  const top = (map, n) =>
    [...map.entries()]
      .filter(([key]) => !/^\((root|program|idle)\)/.test(key))
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([key, ms]) => [Math.round(ms * 10) / 10, key]);
  return { busyMs: Math.round(busy), self: top(self, 30), total: top(total, 60) };
}

function median(values) {
  const sorted = values.filter((v) => v != null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

function summarize(results) {
  const rows = [];
  for (const scenario of [...SCENARIOS, { id: 'files-type' }]) {
    const runs = results.filter((row) => row.scenario === scenario.id);
    const pick = (key) => runs.map((row) => row[key]);
    const fmt = (key) => {
      const values = pick(key).filter((v) => v != null);
      if (values.length === 0) return '-';
      return `${median(values)} [${Math.min(...values)}..${Math.max(...values)}]`;
    };
    rows.push({
      scenario: scenario.id,
      runs: runs.length,
      visibleMs: fmt('visibleMs'),
      highlightedMs: fmt('highlightedMs'),
      p50: fmt('p50'),
      p95: fmt('p95'),
      max: fmt('max'),
      over50: fmt('over50'),
      dropped: fmt('dropped'),
      longTaskMs: fmt('longTaskMs'),
      longestTask: fmt('longestTask'),
      tbt: fmt('tbt'),
      animP95: (() => {
        const values = runs.map((row) => row.anim?.p95).filter((v) => v != null);
        return values.length
          ? `${median(values)} [${Math.min(...values)}..${Math.max(...values)}]`
          : '-';
      })(),
      animMax: (() => {
        const values = runs.map((row) => row.anim?.max).filter((v) => v != null);
        return values.length
          ? `${median(values)} [${Math.min(...values)}..${Math.max(...values)}]`
          : '-';
      })(),
    });
  }
  return rows;
}

async function runScenarios(cdp, id, opts) {
  const out = [];
  for (const scenario of SCENARIOS) {
    if (scenario.setup !== 'keep') {
      const side = await resetAndReload(cdp, id, scenario.setup === 'open');
      log(`  [${scenario.id}] 重置 open=${side.open} width=${side.width} tabs=${side.tabs}`);
    } else {
      await sleep(1500);
    }
    const result = await measure(cdp, scenario, opts);
    const { cpu, ...rest } = result;
    log(`  [${scenario.id}] ${JSON.stringify(rest)}`);
    if (rest.highlightedMs == null) log(`  !! ${scenario.id} 目标内容 6s 内未高亮可见`);
    out.push(result);
  }
  const typing = await measureTyping(cdp, opts.projectPath, opts);
  const { cpu, ...rest } = typing;
  log(`  [files-type] ${JSON.stringify(rest)}`);
  if (!typing.typedOk || !typing.savedOk) log('  !! files-type 输入或 Cmd+S 保存未生效');
  out.push(typing);
  return out;
}

async function main() {
  if (PROD) {
    for (const file of ['out/main/index.js', 'out/renderer/index.html']) {
      if (!existsSync(path.join(ROOT, file)))
        throw new Error(`缺少 ${file}，先 VITE_ENSO_EXPOSE_STORES=1 pnpm build`);
    }
  }
  artDir = mkdtempSync('/tmp/enso-file-open-bench-');
  const userData = path.join(artDir, 'user-data');
  const projectPath = path.join(artDir, 'project');
  mkdirSync(projectPath, { recursive: true });
  writeFixture(projectPath);
  const providerPort = await startFakeProvider();
  writeFakeSettings(userData, `http://127.0.0.1:${providerPort}`);
  const cdpPort = await reserveCdpPort();
  log(`label=${LABEL} mode=${PROD ? 'prod' : 'dev'} runs=${RUNS} profile=${PROFILE}`);
  log(`userData ${userData}`);
  log(`cdp ${cdpPort}`);
  launch(userData, cdpPort);
  await waitFor(
    async () => {
      rememberOwned();
      const target = await pageTarget(cdpPort).catch(() => null);
      if (!target) return null;
      assertIsolatedListener(cdpPort, userData);
      return target;
    },
    { timeout: 120_000, interval: 500, label: '隔离 CDP 页面' }
  );
  const cdp = await waitForStablePage(cdpPort);
  const size = await applyViewport(cdp);
  if (size.v !== 'visible') throw new Error(`visibility=${size.v}`);
  const session = await bootSession(cdp, projectPath);
  log(`会话 ${session.id}`);
  for (let turn = 1; turn <= TURNS; turn += 1) {
    await sendTurn(cdp, session.id, `第 ${turn} 轮：继续排查侧栏文件打开卡顿。`, session.cwd);
    await waitFor(
      async () => {
        const live = await cdp.eval(convExpr(session.id));
        if (live.status === 'failed') throw new Error(`第 ${turn} 轮失败 ${live.error}`);
        return live.status === 'idle' && live.messages >= turn * 2 ? live : null;
      },
      { timeout: 45_000, interval: 250, label: `第 ${turn} 轮结束` }
    );
  }
  log(`已灌 ${TURNS} 轮对话`);

  if (HOLD) {
    await resetAndReload(cdp, session.id, false);
    writeFileSync('/tmp/bench-hold.json', JSON.stringify({ cdpPort, id: session.id, projectPath }));
    log(`hold: cdp=${cdpPort}，信息写入 /tmp/bench-hold.json，Ctrl+C 结束`);
    await new Promise(() => {});
  }
  // 热身一轮不计：dev 下首轮含 Vite 按需转译
  log('warmup');
  await runScenarios(cdp, session.id, { projectPath });
  const results = [];
  for (let run = 1; run <= RUNS; run += 1) {
    log(`run ${run}/${RUNS}`);
    results.push(...(await runScenarios(cdp, session.id, { projectPath })));
  }
  const profiles = [];
  if (PROFILE) {
    log('profile');
    for (const result of await runScenarios(cdp, session.id, { profile: true, projectPath })) {
      const file = path.join('/tmp', `bench-file-open-${LABEL}-${result.scenario}.cpuprofile`);
      writeFileSync(file, JSON.stringify(result.cpu));
      profiles.push({ scenario: result.scenario, file, ...analyzeProfile(result.cpu) });
    }
  }
  const summary = summarize(results);
  console.log(`\n== ${LABEL} 中位数 [最小..最大]，${RUNS} 轮 ==`);
  console.table(summary);
  for (const item of profiles) {
    console.log(`\n== profile ${item.scenario} busy=${item.busyMs}ms ${item.file} ==`);
    console.log('-- self --');
    for (const [ms, key] of item.self.slice(0, 20))
      console.log(`${String(ms).padStart(8)}  ${key}`);
    console.log('-- total --');
    for (const [ms, key] of item.total.slice(0, 45))
      console.log(`${String(ms).padStart(8)}  ${key}`);
  }
  if (JSON_OUT) {
    writeFileSync(
      JSON_OUT,
      JSON.stringify(
        {
          label: LABEL,
          mode: PROD ? 'prod' : 'dev',
          runs: RUNS,
          results: results.map(({ cpu, ...rest }) => rest),
          summary,
          profiles,
        },
        null,
        2
      )
    );
    log(`写入 ${JSON_OUT}`);
  }
}

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
process.on('unhandledRejection', (error) => {
  console.error(error);
  if (devLogTail) console.error(devLogTail);
  void finish(1);
});

main()
  .then(() => finish(0))
  .catch((error) => {
    console.error(error);
    if (devLogTail) console.error(devLogTail);
    return finish(1);
  });
