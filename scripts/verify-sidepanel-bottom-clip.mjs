// 新建菜单 popover 底部是否被裁掉：展开空态侧栏弹出新建菜单后，
// 测量 popup / positioner / 视口底边的几何关系与圆角处可见性。
// 隔离 dev 实例（临时 userData、拒绝 9222）。
//
//   node scripts/verify-sidepanel-bottom-clip.mjs [--root <repo>] [--keep] [--expect-clip]
//
// --expect-clip：断言存在裁剪（复现 bug）；缺省断言没有裁剪（验证修复）。
// 截图 /tmp/sidepanel-bottom-clip.png
// 断言失败非零退出。--keep 保留临时 userData。

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { uiElementElectron } from './verify-electron.mjs';
import { mergeOwnedPids, ownedProcessGroups } from './verify-secretary-isolation.mjs';

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const HOLD = argv.includes('--hold');
const ROOT = path.resolve(flag('--root') ?? path.resolve(import.meta.dirname, '..'));

const VIEWPORT = { width: 1400, height: Number(process.env.VIEWPORT_H ?? 900) };
const TOGGLE_LABELS = ['Toggle side panel', '折叠/展开右侧面板'];
const SHOTS = {
  clip: '/tmp/sidepanel-bottom-clip.png',
};
const EXPECT_CLIP = argv.includes('--expect-clip');

const children = [];
const trackedPids = [];
let artDir = null;
let devLogTail = '';

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

async function reservePort(rejectPort) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = await freePort();
    if (port !== rejectPort) return port;
  }
  throw new Error(`挑不到端口（拒绝 ${rejectPort}）`);
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

function writeSettings(userData) {
  mkdirSync(userData, { recursive: true });
  const state = {
    providers: [],
    onboarded: true,
    theme: 'system',
    language: 'zh-CN',
    titleSummaryEnabled: false,
    secretaryEnabled: false,
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
      { timeout: 120_000, interval: 400, label: 'renderer 就绪' }
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
    deviceScaleFactor: Number(process.env.DSF ?? 1),
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

function startDev(userData, cdpPort, rendererPort) {
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
      ENSO_RENDERER_PORT: String(rendererPort),
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
    localStorage.removeItem('enso-side-panel');
    const settings = window.__stores.settings;
    const sessions = window.__stores.sessions;
    const side = window.__stores.sidePanel;
    settings.setState({
      onboarded: true,
      language: 'zh-CN',
      titleSummaryEnabled: false,
      secretaryEnabled: false,
    });
    side.setState({
      fullscreen: false,
      lastWidth: 420,
      layouts: {},
      pinnedTabs: [],
      globalTabs: [],
      uiByConversation: {},
      fullscreenByConversation: {},
      newTabMenuPrompt: null,
    });
    const project = await settings.getState().addProject(${JSON.stringify(projectPath)});
    const id = await sessions.getState().newConversation(project.id);
    if (!id) return JSON.stringify({ ok: false, error: 'newConversation 返回空' });
    side.setState((state) => ({
      fullscreen: false,
      lastWidth: 420,
      layouts: { ...state.layouts, [id]: undefined },
      pinnedTabs: [],
      globalTabs: [],
      newTabMenuPrompt: null,
      uiByConversation: {
        ...state.uiByConversation,
        [id]: { ...(state.uiByConversation[id] ?? {}), open: false, width: 420 },
      },
      fullscreenByConversation: { ...state.fullscreenByConversation, [id]: false },
    }));
    const panels = Object.keys(side.getState().layouts[id]?.panels ?? {});
    return JSON.stringify({ ok: true, id, cwd: project.path, panels });
  })()`);
  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error || '建会话失败');
  if (parsed.panels.length !== 0) throw new Error(`新会话已有 tab: ${parsed.panels.join(',')}`);
  return parsed;
}

function sideExpr() {
  return `(() => {
    const id = window.__stores.sessions.getState().activeId;
    const side = window.__stores.sidePanel.getState();
    const panels = side.layouts[id]?.panels ?? {};
    const aside = document.querySelector('[data-enso="side-panel"]');
    const rect = aside ? aside.getBoundingClientRect() : null;
    const tabs = [...document.querySelectorAll('.enso-side-dock .dv-tab')].map((node) => ({
      text: (node.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
      w: Math.round(node.getBoundingClientRect().width),
    }));
    return {
      id,
      open: side.uiByConversation[id]?.open === true,
      prompt: side.newTabMenuPrompt,
      panelCount: Object.keys(panels).length,
      components: Object.values(panels).map((panel) => panel?.contentComponent ?? null),
      asideW: rect ? Math.round(rect.width) : null,
      tabs,
    };
  })()`;
}

function menuExpr() {
  return `(() => {
    const popups = [...document.querySelectorAll('[data-slot="menu-popup"]')];
    return popups.map((popup) => {
      const rect = popup.getBoundingClientRect();
      const items = [...popup.querySelectorAll('[data-slot="menu-item"]')].map((node) =>
        (node.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40)
      );
      return {
        items,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      };
    });
  })()`;
}

async function readSide(cdp) {
  return cdp.eval(sideExpr());
}

async function readMenu(cdp) {
  return cdp.eval(menuExpr());
}

function menuOnScreen(popups) {
  return (popups ?? []).find(
    (popup) =>
      popup.items.length >= 4 &&
      popup.w > 20 &&
      popup.h > 20 &&
      popup.x < VIEWPORT.width - 8 &&
      popup.y < VIEWPORT.height - 8 &&
      popup.x + popup.w > 8 &&
      popup.y + popup.h > 8
  );
}

async function togglePoint(cdp) {
  const labels = JSON.stringify(TOGGLE_LABELS);
  return cdp.eval(`(() => {
    const labels = new Set(${labels});
    const buttons = [...document.querySelectorAll('button')].filter((node) => {
      const label = node.getAttribute('aria-label') || '';
      if (!labels.has(label) && !/side panel/i.test(label)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    });
    const button = buttons.find((node) => {
      const rect = node.getBoundingClientRect();
      const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return top && (top === node || node.contains(top));
    }) ?? buttons[0];
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, label: button.getAttribute('aria-label') };
  })()`);
}

async function clickAt(cdp, point) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
}

async function clickToggle(cdp) {
  const before = await cdp.eval(`(() => {
    const id = window.__stores.sessions.getState().activeId;
    return window.__stores.sidePanel.getState().uiByConversation[id]?.open === true;
  })()`);
  let point = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    point = await togglePoint(cdp);
    if (!point) throw new Error('找不到展开/收起右侧栏按钮');
    await clickAt(cdp, point);
    const flipped = await waitFor(
      async () => {
        const open = await cdp.eval(`(() => {
          const id = window.__stores.sessions.getState().activeId;
          return window.__stores.sidePanel.getState().uiByConversation[id]?.open === true;
        })()`);
        return open !== before ? true : null;
      },
      { timeout: 1200, interval: 40, label: '侧栏开关生效' }
    ).catch(() => null);
    if (flipped) return point;
  }
  const debug = await cdp.eval(`(() => [...document.querySelectorAll('button')].map((node) => {
    const rect = node.getBoundingClientRect();
    return { label: node.getAttribute('aria-label'), w: Math.round(rect.width), h: Math.round(rect.height) };
  }).filter((row) => row.label))()`);
  throw new Error(
    `点击没有切换侧栏 point=${JSON.stringify(point)} buttons=${JSON.stringify(debug)}`
  );
}

async function firstMenuItemPoint(cdp) {
  return cdp.eval(`(() => {
    const popup = [...document.querySelectorAll('[data-slot="menu-popup"]')].find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 20 && rect.height > 20 && node.querySelectorAll('[data-slot="menu-item"]').length >= 4;
    });
    const item = popup?.querySelector('[data-slot="menu-item"]');
    if (!item) return null;
    const rect = item.getBoundingClientRect();
    return {
      x: rect.x + Math.min(rect.width / 2, 48),
      y: rect.y + rect.height / 2,
      label: (item.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
    };
  })()`);
}

async function dump(cdp, label) {
  const side = await readSide(cdp).catch((error) => String(error));
  const menu = await readMenu(cdp).catch((error) => String(error));
  log(`${label} side=${JSON.stringify(side)} menu=${JSON.stringify(menu)}`);
  return { side, menu };
}

async function main() {
  if (!existsSync(path.join(ROOT, 'package.json'))) throw new Error(`找不到仓库 ${ROOT}`);
  if (!existsSync(path.join(ROOT, 'node_modules/.bin/electron-vite'))) {
    throw new Error(`缺少 ${path.join(ROOT, 'node_modules/.bin/electron-vite')}`);
  }
  artDir = mkdtempSync('/tmp/enso-bottom-clip-');
  const userData = path.join(artDir, 'user-data');
  const projectPath = path.join(artDir, 'project');
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(path.join(projectPath, 'README.md'), 'side panel bottom clip\n');
  writeSettings(userData);
  const cdpPort = await reservePort(9222);
  const rendererPort = await reservePort(9222);
  log(`root ${ROOT}`);
  log(`userData ${userData}`);
  log(`cdp ${cdpPort}`);
  log(`renderer ${rendererPort}`);
  startDev(userData, cdpPort, rendererPort);

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
    { timeout: 120_000, interval: 500, label: '隔离 CDP 页面' }
  );

  const cdp = await waitForStablePage(cdpPort);
  try {
    const size = await applyViewport(cdp);
    if (size.v !== 'visible') throw new Error(`visibility=${size.v}，焦点模拟没生效`);
    const session = await bootSession(cdp, projectPath);
    log(`会话 ${session.id}`);
    await sleep(400);

    // 注入 5 个假插件视图（模拟 Telegram 等），让菜单足够长以复现用户截图的形态
    const viewsCount = await cdp.eval(`(async () => {
      try {
        const hook = window.__setPluginViews;
        if (typeof hook !== 'function') return 'fail: no window.__setPluginViews hook';
        const mk = (id, title) => ({ pluginId: 'fake-tg', id, title, entry: 'about:blank', scope: 'session' });
        hook([mk('a','Telegram'), mk('b','看板'), mk('c','调度器'), mk('d','GitHub'), mk('e','Swarm')]);
        return 'ok';
      } catch (error) {
        return 'fail: ' + String(error?.message || error);
      }
    })()`);
    log(`pluginViews=${viewsCount}`);

    // 展开侧栏 → 空态弹出新建菜单 → 选 Terminal 建立 tab → 再从 compact「+」按钮开菜单
    await clickToggle(cdp);
    const prompted = await waitFor(
      async () => {
        const side = await readSide(cdp);
        const menu = await readMenu(cdp);
        const hit = menuOnScreen(menu);
        if (side.open && side.asideW > 200 && hit) return { side, menu, hit };
        return null;
      },
      { timeout: 4_000, interval: 80, label: '空态展开并弹出新建菜单' }
    );
    void prompted;
    const firstItem = await firstMenuItemPoint(cdp);
    if (!firstItem) throw new Error('找不到首菜单项');
    await clickAt(cdp, firstItem);
    await waitFor(
      async () => {
        const side = await readSide(cdp);
        return side.components.includes('terminal') ? side : null;
      },
      { timeout: 3_000, interval: 80, label: '点选后出现 terminal tab' }
    );
    await sleep(400);
    // 顶栏行右上角的 + / 全屏 / 收起平时收纳成「…」：像真实用户一样先 hover「…」把按钮组展开
    const dots = await cdp.eval(`(() => {
      const group = [...document.querySelectorAll('[data-side-actions]')].find((node) => node.isConnected && node.getBoundingClientRect().width > 0);
      const buttons = group ? [...group.querySelectorAll('button')] : [];
      const toggle = buttons[buttons.length - 1];
      if (!toggle) return null;
      const rect = toggle.getBoundingClientRect();
      return rect.width > 0 ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
    })()`);
    if (dots) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dots.x, y: dots.y });
      await sleep(250);
    }
    // 点 dock 头部的 compact「+」按钮（aria-label New tab / 新建标签页）
    const plusPoint = await cdp.eval(`(() => {
      const buttons = [...document.querySelectorAll('.enso-side-dock button, [data-enso="side-panel"] button')];
      const btn = buttons.find((node) => {
        const label = node.getAttribute('aria-label') || '';
        if (!/new tab|新建标签页/i.test(label)) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 2 && rect.width < 40 && rect.height > 2;
      });
      if (!btn) return null;
      const rect = btn.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, label: btn.getAttribute('aria-label') };
    })()`);
    if (!plusPoint) throw new Error('找不到 compact + 按钮');
    log(`compact + 按钮 @${JSON.stringify(plusPoint)}`);
    if (dots) {
      // 光标从「…」沿按钮组平移到 +，途中不离开按钮组
      for (let x = dots.x; x >= plusPoint.x; x -= 4) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: plusPoint.y });
      }
    }
    await clickAt(cdp, plusPoint);
    await waitFor(
      async () => {
        const menu = await readMenu(cdp);
        return menuOnScreen(menu) ? menu : null;
      },
      { timeout: 3_000, interval: 80, label: 'compact 菜单弹出' }
    );
    // 等待弹出动画结束（150ms 的 scale/opacity 过渡 + 余量）
    await sleep(600);
    // 滚到底部：用户截图里最后一项完整可见——看的是滚动结束态
    await cdp.eval(`(() => {
      const popup = [...document.querySelectorAll('[data-slot="menu-popup"]')].find((n) => n.getBoundingClientRect().width > 20);
      const inner = popup?.firstElementChild;
      if (inner) inner.scrollTop = inner.scrollHeight;
      return inner ? inner.scrollTop : -1;
    })()`);
    await sleep(150);

    const geometry = await cdp.eval(`(() => {
      const popup = [...document.querySelectorAll('[data-slot="menu-popup"]')].find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 20 && rect.height > 20;
      });
      if (!popup) return { error: '菜单不在屏上' };
      const positioner = popup.closest('[data-slot="menu-positioner"]');
      const inner = popup.firstElementChild;
      const items = [...popup.querySelectorAll('[data-slot="menu-item"]')];
      const lastItem = items[items.length - 1];
      const rect = popup.getBoundingClientRect();
      const posRect = positioner ? positioner.getBoundingClientRect() : null;
      const innerRect = inner ? inner.getBoundingClientRect() : null;
      const lastRect = lastItem ? lastItem.getBoundingClientRect() : null;
      const cs = getComputedStyle(popup);
      const posCs = positioner ? getComputedStyle(positioner) : null;
      const innerCs = inner ? getComputedStyle(inner) : null;
      // 最底一行中心点采样：命中的是不是 popup 自己（被裁时命中窗口背景）
      const probeY = rect.bottom - cs.borderBottomWidth.replace('px','') / 2 - 1;
      const probe = document.elementFromPoint(rect.x + rect.width / 2, probeY);
      // 底边内 1px 处（边框中线）：命中应当是 popup/其边框层而不是内部 item/div
      const edgeProbe = document.elementFromPoint(rect.x + rect.width / 2, rect.bottom - 0.5);
      const edgeProbeInner = document.elementFromPoint(rect.x + rect.width / 2, rect.bottom - 2.5);
      // 圆角顶点区域（底边中点下 1px）：应当落在视口内且命中 popup
      const insideViewport = rect.bottom <= window.innerHeight;
      return {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        popup: {
          x: rect.x, y: rect.y, w: rect.width, h: rect.height,
          bottom: rect.bottom,
          borderRadius: cs.borderBottomRightRadius,
          borderBottomWidth: cs.borderBottomWidth,
          maxHeight: cs.maxHeight,
          overflow: cs.overflow,
          availableHeightVar: cs.getPropertyValue('--available-height') || '(自身无)',
        },
        positioner: posRect ? {
          y: posRect.y, h: posRect.height, bottom: posRect.bottom,
          maxHeight: posCs.maxHeight,
          overflow: posCs.overflow,
          availableHeightVar: posCs.getPropertyValue('--available-height'),
        } : null,
        inner: innerRect ? {
          y: innerRect.y, h: innerRect.height, bottom: innerRect.bottom,
          maxHeight: innerCs.maxHeight,
          overflowY: innerCs.overflowY,
          scrollHeight: inner.scrollHeight,
          clientHeight: inner.clientHeight,
        } : null,
        lastItem: lastRect ? { bottom: lastRect.bottom, label: (lastItem.innerText||'').trim().slice(0,30) } : null,
        itemCount: items.length,
        probeHit: probe ? (probe.dataset?.slot || probe.tagName) : null,
        edgeProbeHit: edgeProbe ? ((edgeProbe.dataset?.slot || edgeProbe.tagName) + '/' + (edgeProbe.className && typeof edgeProbe.className === 'string' ? edgeProbe.className.slice(0,60) : '')) : null,
        edgeProbeIsPopup: edgeProbe === popup,
        edgeProbeInnerHit: edgeProbeInner ? (edgeProbeInner.dataset?.slot || edgeProbeInner.tagName) : null,
        paddingBottom: innerCs ? innerCs.paddingBottom : null,
        paddingBottomPopup: cs.paddingBottom,
        itemCount2: items.length,
        rects: (() => {
          // 逐像素精度：popup rect vs 可视证据无关，直接看 bottom 边是否有边框像素留给下一轮 PIL 检查
          return null;
        })(),
        anchors: (() => {
          // 侧栏容器与 viewport 边距
          const aside = document.querySelector('[data-enso="side-panel"]');
          const r = aside ? aside.getBoundingClientRect() : null;
          return r ? { right: r.right, bottom: r.bottom, w: r.width, h: r.height } : null;
        })(),
        cornerProbe: (() => {
          // 距底边 3px、距左右边 2px 的点应当落在圆角透明区外侧（不命中 popup）
          // 距底边 3px、距左右边 8px 的点应当落在 popup 内（圆角已收完）
          const radius = parseFloat(cs.borderBottomRightRadius) || 0;
          const yIn = rect.bottom - 2;
          const edge = document.elementFromPoint(rect.x + 2, yIn);
          const inside = document.elementFromPoint(rect.x + Math.min(radius + 2, rect.width / 2), yIn);
          return {
            radius,
            cornerHitsPopup: edge ? popup.contains(edge) : null,
            insideHitsPopup: inside ? popup.contains(inside) : null,
            edgeHit: edge ? (edge.dataset?.slot || edge.tagName) : null,
          };
        })(),
        probeInsidePopup: probe ? popup.contains(probe) : false,
        insideViewport,
        clipAmount: Math.max(0, rect.bottom - window.innerHeight),
        overflowAmount: inner && inner.scrollHeight > inner.clientHeight ? inner.scrollHeight - inner.clientHeight : 0,
        scrolled: inner ? inner.scrollTop : null,
      };
    })()`);

    const png = await shoot(cdp, SHOTS.clip);
    log(`${SHOTS.clip} ${png.width}x${png.height}`);
    log(`geometry=${JSON.stringify(geometry, null, 2)}`);
    if (geometry.error) throw new Error(geometry.error);

    // 判定：底部裁切 = popup 底边超出视口，或内部内容可滚（max-height 裁了内容），
    // 或 popup 底边中点采样命中不到 popup 自身。
    // 滚动容器超出 popup 可视区才算内容裁切：inner bottom 越过 popup bottom - border
    const contentClipped = geometry.inner.bottom > geometry.popup.bottom - 0.6;
    const viewportClipped = geometry.clipAmount > 0.5;
    const clipped = contentClipped || viewportClipped || !geometry.probeInsidePopup;
    log(
      `判定 viewportClipped=${viewportClipped}(${geometry.clipAmount}px) contentClipped=${contentClipped}(${geometry.overflowAmount}px) probeInsidePopup=${geometry.probeInsidePopup} available=${geometry.positioner?.availableHeightVar}`
    );
    // 视觉判据：popup 底缘必须高于视口底边至少 4px（碰撞垫 5px 减 1px 浮点余量），
    // 否则底部圆角/阴影会被窗口边缘裁平；同时内容不得越过可视区（无内部裁切）。
    const bottomGap = geometry.viewport.h - geometry.popup.bottom;
    const bottomClear = bottomGap >= 3.5;
    log(`bottomGap=${bottomGap}px bottomClear=${bottomClear}`);
    if (EXPECT_CLIP) {
      assert.ok(clipped || !bottomClear, '期望复现裁剪，但没有裁到');
      log('PASS（复现：底部确实被裁）');
    } else {
      assert.ok(!clipped && bottomClear, `底部仍被裁剪 bottomGap=${bottomGap}`);
      log('PASS（修复：底部圆角完整可见）');
    }
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

if (!HOLD)
  setTimeout(() => {
    console.error('内部超时 240s');
    if (devLogTail) console.error(devLogTail);
    void finish(124);
  }, 240_000);

main()
  .then(() => finish(0))
  .catch((error) => {
    console.error(error);
    if (devLogTail) console.error(devLogTail);
    return finish(1);
  });
