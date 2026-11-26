// 无 tab 时展开右侧栏应直接弹出新建菜单；已有 tab 时展开不弹。
// 隔离 dev 实例（临时 userData、拒绝 9222）。
//
//   node scripts/verify-sidepanel-newtab-prompt.mjs [--root <repo>] [--keep]
//
// 截图：
//   /tmp/sidepanel-newtab-a-before.png
//   /tmp/sidepanel-newtab-b-prompt.png
//   /tmp/sidepanel-newtab-c-terminal.png
//   /tmp/sidepanel-newtab-d-no-prompt.png
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
const ROOT = path.resolve(flag('--root') ?? path.resolve(import.meta.dirname, '..'));

const VIEWPORT = { width: 1400, height: 900 };
const TOGGLE_LABELS = ['Toggle side panel', '折叠/展开右侧面板'];
const SHOTS = {
  before: '/tmp/sidepanel-newtab-a-before.png',
  prompt: '/tmp/sidepanel-newtab-b-prompt.png',
  terminal: '/tmp/sidepanel-newtab-c-terminal.png',
  noPrompt: '/tmp/sidepanel-newtab-d-no-prompt.png',
};

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
  artDir = mkdtempSync('/tmp/enso-newtab-prompt-');
  const userData = path.join(artDir, 'user-data');
  const projectPath = path.join(artDir, 'project');
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(path.join(projectPath, 'README.md'), 'side panel new tab prompt\n');
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
  const checks = [];
  try {
    const size = await applyViewport(cdp);
    if (size.v !== 'visible') throw new Error(`visibility=${size.v}，焦点模拟没生效`);
    const session = await bootSession(cdp, projectPath);
    log(`会话 ${session.id}`);
    await sleep(400);
    const closed = await readSide(cdp);
    if (closed.open) throw new Error(`展开前侧栏已打开 ${JSON.stringify(closed)}`);
    if (closed.panelCount !== 0) throw new Error(`展开前已有面板 ${JSON.stringify(closed)}`);
    const before = await shoot(cdp, SHOTS.before);
    log(`${SHOTS.before} ${before.width}x${before.height} aside=${closed.asideW}`);

    await clickToggle(cdp);
    const prompted = await waitFor(
      async () => {
        const side = await readSide(cdp);
        const menu = await readMenu(cdp);
        const hit = menuOnScreen(menu);
        if (side.open && side.asideW > 200 && hit) return { side, menu, hit };
        return null;
      },
      { timeout: 8_000, interval: 80, label: '空态展开并弹出新建菜单' }
    ).catch(async (error) => {
      const evidence = await dump(cdp, '菜单未弹出');
      throw new Error(`${error.message} ${JSON.stringify(evidence)}`);
    });
    await sleep(250);
    const promptPng = await shoot(cdp, SHOTS.prompt);
    const promptMenu = await readMenu(cdp);
    const promptHit = menuOnScreen(promptMenu);
    log(
      `${SHOTS.prompt} ${promptPng.width}x${promptPng.height} items=${promptHit?.items?.length ?? 0} promptAt=${prompted.side.prompt}`
    );
    if (!promptHit) {
      throw new Error(`截图时菜单不在视口内 ${JSON.stringify(promptMenu)}`);
    }
    checks.push({ name: '空态展开弹出菜单且至少 4 项', pass: true, items: promptHit.items.length });

    // 回归断言（#607 后续 bug）：弹层只能有一个，且锚定在水印按钮附近而非漂到屏幕左上
    if (promptMenu.length !== 1) {
      throw new Error(`展开后出现 ${promptMenu.length} 个弹层 ${JSON.stringify(promptMenu)}`);
    }
    if (promptHit.x < 200) {
      throw new Error(`弹层漂到左侧 x=${promptHit.x} ${JSON.stringify(promptMenu)}`);
    }
    checks.push({ name: '展开后弹层唯一且锚定在面板内', pass: true });

    // 菜单开着直接收起面板（快捷键路径，无 backdrop 点击）：弹层必须关掉，不能残留漂移
    await cdp.eval(`(() => { window.__stores.sidePanel.getState().toggleOpen(); return true; })()`);
    await waitFor(
      async () => {
        const side = await readSide(cdp);
        return !side.open ? side : null;
      },
      { timeout: 4_000, interval: 80, label: '菜单开着时收起面板' }
    );
    await sleep(500);
    const collapsedMenu = await readMenu(cdp);
    if (collapsedMenu.length !== 0) {
      throw new Error(`收起面板后弹层残留 ${JSON.stringify(collapsedMenu)}`);
    }
    checks.push({ name: '菜单开着收起面板弹层关闭', pass: true });

    // 再展开：prompt 重写，重弹且仍然只有一个
    await cdp.eval(`(() => { window.__stores.sidePanel.getState().toggleOpen(); return true; })()`);
    await waitFor(
      async () => {
        const side = await readSide(cdp);
        const menu = await readMenu(cdp);
        if (side.open && menuOnScreen(menu)) return { side, menu };
        return null;
      },
      { timeout: 4_000, interval: 80, label: '再展开重弹菜单' }
    );
    await sleep(300);
    const reopenedMenu = await readMenu(cdp);
    if (reopenedMenu.length !== 1) {
      throw new Error(`再展开后出现 ${reopenedMenu.length} 个弹层 ${JSON.stringify(reopenedMenu)}`);
    }
    checks.push({ name: '再展开重弹且弹层唯一', pass: true });

    // 快速连点展开按钮（真实鼠标，同一坐标；菜单开着时点击会先落在弹层 backdrop 上）：
    // 任何节奏下停稳后都只能是「开着 = 恰好一个锚在面板内的弹层」或「收着 = 没有弹层」，
    // 不能出现双弹层或漂到左上角的孤儿弹层。
    const stressPoint = await togglePoint(cdp);
    if (!stressPoint) throw new Error('找不到展开/收起右侧栏按钮');
    const stress = [];
    for (const gap of [40, 90, 150, 220, 320]) {
      for (const clicks of [2, 3, 4, 5]) {
        for (let i = 0; i < clicks; i += 1) {
          await clickAt(cdp, stressPoint);
          await sleep(gap);
        }
        await sleep(1_200);
        const side = await readSide(cdp);
        const menu = await readMenu(cdp);
        const row = { gap, clicks, open: side.open, menus: menu.map((m) => [m.x, m.y, m.w, m.h]) };
        stress.push(row);
        const anchored = (m) => m.x >= 200 && m.y >= 0 && m.w > 20 && m.h > 20;
        const bad = side.open
          ? menu.length > 1 || (menu.length === 1 && !anchored(menu[0]))
          : menu.length !== 0;
        if (bad) {
          await shoot(cdp, '/tmp/sidepanel-newtab-stress-fail.png').catch(() => {});
          throw new Error(
            `快速连点后弹层异常 ${JSON.stringify(row)} 全部=${JSON.stringify(stress)}`
          );
        }
      }
    }
    log(`快速连点 ${stress.length} 轮 ${JSON.stringify(stress)}`);
    checks.push({
      name: '快速连点展开按钮不出现双弹层/孤儿弹层',
      pass: true,
      rounds: stress.length,
    });
    // 收回到「开着 + 菜单弹出」，供下面点选菜单项
    {
      const side = await readSide(cdp);
      if (side.open) {
        await cdp.eval(
          `(() => { window.__stores.sidePanel.getState().toggleOpen(); return true; })()`
        );
        await waitFor(async () => (!(await readSide(cdp)).open ? true : null), {
          timeout: 4_000,
          interval: 80,
          label: '连点后收起',
        });
        await sleep(400);
      }
      await cdp.eval(
        `(() => { window.__stores.sidePanel.getState().toggleOpen(); return true; })()`
      );
      await waitFor(
        async () => {
          const s = await readSide(cdp);
          const m = await readMenu(cdp);
          return s.open && m.length === 1 && menuOnScreen(m) ? true : null;
        },
        { timeout: 4_000, interval: 80, label: '连点后重新展开弹菜单' }
      );
      await sleep(300);
    }

    const item = await firstMenuItemPoint(cdp);
    if (!item) throw new Error(`找不到可点的 menu item ${JSON.stringify(promptMenu)}`);
    log(`点击菜单首项 ${item.label} @${Math.round(item.x)},${Math.round(item.y)}`);
    await clickAt(cdp, item);
    let opened = await waitFor(
      async () => {
        const side = await readSide(cdp);
        const menu = await readMenu(cdp);
        if (side.tabs.length >= 1 && menu.length === 0 && side.components.includes('terminal')) {
          return side;
        }
        return null;
      },
      { timeout: 2_000, interval: 80, label: '点选后出现 terminal tab' }
    ).catch(() => null);
    if (!opened) {
      const fallback = await cdp.eval(`(() => {
        const item = document.querySelector('[data-slot="menu-popup"] [data-slot="menu-item"]');
        if (!item) return false;
        item.click();
        return true;
      })()`);
      log(`CDP 点击未建成 tab，HTMLElement.click 兜底=${fallback}`);
      opened = await waitFor(
        async () => {
          const side = await readSide(cdp);
          const menu = await readMenu(cdp);
          if (side.tabs.length >= 1 && menu.length === 0 && side.components.includes('terminal')) {
            return side;
          }
          return null;
        },
        { timeout: 3_000, interval: 80, label: '兜底点击后出现 terminal tab' }
      ).catch(async (error) => {
        const evidence = await dump(cdp, '点 Terminal 后');
        throw new Error(`${error.message} ${JSON.stringify(evidence)}`);
      });
    }
    await sleep(300);
    const terminalPng = await shoot(cdp, SHOTS.terminal);
    const afterClickMenu = await readMenu(cdp);
    log(
      `${SHOTS.terminal} ${terminalPng.width}x${terminalPng.height} tabs=${opened.tabs.length} components=${opened.components.join(',')}`
    );
    if (afterClickMenu.length !== 0) {
      throw new Error(`点选后菜单仍在 ${JSON.stringify(afterClickMenu)}`);
    }
    checks.push({
      name: '点选后菜单关闭且出现 terminal tab',
      pass: true,
      tabs: opened.tabs.length,
    });

    await clickToggle(cdp);
    await waitFor(
      async () => {
        const side = await readSide(cdp);
        return !side.open && side.asideW != null && side.asideW < 8 ? side : null;
      },
      { timeout: 4_000, interval: 80, label: '收起侧栏' }
    );
    await clickToggle(cdp);
    const reopened = await waitFor(
      async () => {
        const side = await readSide(cdp);
        return side.open && side.asideW > 200 ? side : null;
      },
      { timeout: 4_000, interval: 80, label: '有 tab 时再次展开' }
    );
    await sleep(500);
    const quietMenu = await readMenu(cdp);
    const noPromptPng = await shoot(cdp, SHOTS.noPrompt);
    log(
      `${SHOTS.noPrompt} ${noPromptPng.width}x${noPromptPng.height} promptAt=${reopened.prompt} menus=${quietMenu.length} tabs=${reopened.tabs.length}`
    );
    if (quietMenu.length !== 0) {
      throw new Error(`有 tab 展开仍弹出菜单 ${JSON.stringify(quietMenu)}`);
    }
    if (reopened.prompt != null) {
      throw new Error(`有 tab 展开仍写下 newTabMenuPromptAt=${reopened.prompt}`);
    }
    checks.push({ name: '有 tab 时展开不弹菜单', pass: true });
    assert.equal(quietMenu.length, 0);

    // 真实用法：开过 tab 再全部关掉 —— dockview 留下一个空 group（组内水印 + 组头 actions），
    // 与「从没开过 tab」的根水印是两套 DOM。在这个状态下再做展开 + 快速连点。
    const closedTab = await cdp.eval(`(() => {
      const btns = [...document.querySelectorAll('[data-side-tab] button:not([aria-label])')];
      btns.forEach((b) => b.click());
      return btns.length;
    })()`);
    await waitFor(async () => ((await readSide(cdp)).panelCount === 0 ? true : null), {
      timeout: 4_000,
      interval: 80,
      label: '关掉全部 tab',
    });
    await sleep(400);
    const residue = await cdp.eval(`(() => ({
      groups: document.querySelectorAll('.enso-side-dock .dv-groupview').length,
      watermarks: document.querySelectorAll('.enso-side-dock .dv-watermark-container, .enso-side-dock .dv-groupview .dv-content-container > *').length,
      plus: [...document.querySelectorAll('button[aria-label]')].filter((b) => /new tab|新建标签页/i.test(b.getAttribute('aria-label') || '')).map((b) => {
        const r = b.getBoundingClientRect();
        return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      }),
    }))()`);
    log(`关 tab=${closedTab} 残留结构 ${JSON.stringify(residue)}`);
    for (const round of [0, 1]) {
      const side = await readSide(cdp);
      if (side.open) {
        await clickToggle(cdp);
        await sleep(500);
      }
      await clickToggle(cdp);
      await sleep(1_200);
      const menu = await readMenu(cdp);
      log(`空 group 展开#${round} menus=${JSON.stringify(menu.map((m) => [m.x, m.y, m.w, m.h]))}`);
      if (menu.length !== 1 || menu[0].x < 200) {
        await shoot(cdp, '/tmp/sidepanel-newtab-emptygroup-fail.png').catch(() => {});
        const owners =
          await cdp.eval(`(() => [...document.querySelectorAll('[data-slot="menu-popup"]')].map((popup) => {
          const key = Object.keys(popup).find((k) => k.startsWith('__reactFiber$'));
          let f = key ? popup[key] : null;
          const chain = [];
          let menuFiber = null;
          while (f) {
            const name = typeof f.type === 'function' ? f.type.displayName || f.type.name : null;
            if (name && chain.length < 40) chain.push(name);
            if (name === 'NewTabMenu' && !menuFiber) menuFiber = f;
            f = f.return;
          }
          let trigger = null;
          if (menuFiber) {
            const stack = [menuFiber.child];
            while (stack.length) {
              const n = stack.shift();
              if (!n) continue;
              if (n.stateNode instanceof HTMLElement && n.stateNode.tagName === 'BUTTON') { trigger = n.stateNode; break; }
              stack.push(n.child, n.sibling);
            }
          }
          const anc = [];
          for (let el = trigger; el && anc.length < 12; el = el.parentElement) anc.push(el.tagName + '.' + String(el.className).slice(0, 40));
          return {
            chain: chain.filter((n) => /Watermark|HeaderActions|GroupRight|NewTabMenu|Dock|Portal|ReactPart/i.test(n)),
            trigConnected: trigger ? trigger.isConnected : null,
            trigRect: trigger ? JSON.stringify(trigger.getBoundingClientRect()) : null,
            anc,
          };
        }))()`);
        throw new Error(
          `空 group 展开后弹层异常 ${JSON.stringify(menu)} 结构=${JSON.stringify(residue)} owners=${JSON.stringify(owners)}`
        );
      }
    }
    const gstress = [];
    for (const gap of [40, 90, 150, 220]) {
      for (const clicks of [2, 3, 4, 5]) {
        for (let i = 0; i < clicks; i += 1) {
          await clickAt(cdp, stressPoint);
          await sleep(gap);
        }
        await sleep(1_200);
        const side = await readSide(cdp);
        const menu = await readMenu(cdp);
        const row = { gap, clicks, open: side.open, menus: menu.map((m) => [m.x, m.y, m.w, m.h]) };
        gstress.push(row);
        const anchored = (m) => m.x >= 200 && m.y >= 0 && m.w > 20 && m.h > 20;
        const bad = side.open
          ? menu.length > 1 || (menu.length === 1 && !anchored(menu[0]))
          : menu.length !== 0;
        if (bad) {
          await shoot(cdp, '/tmp/sidepanel-newtab-emptygroup-fail.png').catch(() => {});
          throw new Error(
            `空 group 快速连点后弹层异常 ${JSON.stringify(row)} 全部=${JSON.stringify(gstress)}`
          );
        }
      }
    }
    log(`空 group 快速连点 ${gstress.length} 轮 ${JSON.stringify(gstress)}`);
    checks.push({ name: '关光 tab 后（空 group）展开/快速连点弹层唯一', pass: true });

    // 顶栏右端收纳：平时只露「…」（即收起按钮），hover 展开 + / 全屏，直接点「…」= 收起
    const actionsExpr = `(() => {
      const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      const groups = [...document.querySelectorAll('[data-side-actions]')].filter((g) => {
        const btns = g.querySelectorAll('button');
        const last = btns[btns.length - 1];
        return g.isConnected && last && last.getBoundingClientRect().width > 0;
      });
      const g = groups[0];
      if (!g) return { found: false, count: 0 };
      const btns = [...g.querySelectorAll('button')];
      const toggle = btns[btns.length - 1];
      const svgs = [...toggle.querySelectorAll('svg')].map((svg) => getComputedStyle(svg).display !== 'none');
      return { found: true, count: groups.length, expanded: g.hasAttribute('data-expanded'), plus: box(btns[0]), fs: box(btns[1]), toggle: box(toggle), toggleLabel: toggle.getAttribute('aria-label'), dots: svgs[0], panelIcon: svgs[1] };
    })()`;
    const pressEscape = async () => {
      for (const type of ['keyDown', 'keyUp']) {
        await cdp.send('Input.dispatchKeyEvent', {
          type,
          key: 'Escape',
          code: 'Escape',
          windowsVirtualKeyCode: 27,
        });
      }
    };
    const moveTo = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
    if (!(await readSide(cdp)).open) {
      await clickToggle(cdp);
      await sleep(1_200);
    }
    await pressEscape();
    await moveTo(300, 450);
    await sleep(400);
    const rest = await cdp.eval(actionsExpr);
    log(`收纳-静止 ${JSON.stringify(rest)}`);
    await shoot(cdp, '/tmp/sidepanel-actions-rest.png').catch(() => {});
    if (!rest.found || rest.plus.w !== 0 || rest.fs.w !== 0 || !rest.dots || rest.panelIcon) {
      throw new Error(`静止时应只露「…」 ${JSON.stringify(rest)}`);
    }
    await moveTo(center(rest.toggle).x, center(rest.toggle).y);
    await sleep(250);
    const hover = await cdp.eval(actionsExpr);
    log(`收纳-hover ${JSON.stringify(hover)}`);
    await shoot(cdp, '/tmp/sidepanel-actions-hover.png').catch(() => {});
    if (hover.plus.w === 0 || hover.fs.w === 0 || hover.dots || !hover.panelIcon) {
      throw new Error(`hover 后应展开 + / 全屏并换回收起图标 ${JSON.stringify(hover)}`);
    }
    if (Math.abs(hover.toggle.x - rest.toggle.x) > 1) {
      throw new Error(`hover 展开把光标下的按钮挤走了 ${rest.toggle.x} → ${hover.toggle.x}`);
    }
    // 光标沿按钮组左移到 +（跨过按钮间缝隙）仍保持展开，点 + 弹菜单
    for (let x = center(hover.toggle).x; x >= center(hover.plus).x; x -= 4)
      await moveTo(x, center(hover.plus).y);
    await sleep(150);
    const onPlus = await cdp.eval(actionsExpr);
    if (onPlus.plus.w === 0) throw new Error(`移到 + 途中按钮组收起了 ${JSON.stringify(onPlus)}`);
    await clickAt(cdp, center(onPlus.plus));
    await sleep(400);
    const userMenu = await readMenu(cdp);
    if (userMenu.length !== 1 || !menuOnScreen(userMenu)) {
      throw new Error(`hover 后点 + 菜单异常 ${JSON.stringify(userMenu)}`);
    }
    // 光标移进弹层（离开按钮组）：+ 是锚点，必须保持展开，弹层不能漂
    await moveTo(userMenu[0].x + userMenu[0].w / 2, userMenu[0].y + userMenu[0].h / 2);
    await sleep(400);
    const inMenu = await cdp.eval(actionsExpr);
    const menuAfter = await readMenu(cdp);
    log(
      `收纳-菜单开着 actions=${JSON.stringify(inMenu)} menu=${JSON.stringify(menuAfter.map((m) => [m.x, m.y]))}`
    );
    if (inMenu.plus.w === 0 || !inMenu.expanded)
      throw new Error(`菜单开着时按钮组收起了 ${JSON.stringify(inMenu)}`);
    if (
      menuAfter.length !== 1 ||
      menuAfter[0].x !== userMenu[0].x ||
      menuAfter[0].y !== userMenu[0].y
    ) {
      throw new Error(
        `光标移进弹层后弹层漂移 ${JSON.stringify(userMenu)} → ${JSON.stringify(menuAfter)}`
      );
    }
    await pressEscape();
    await moveTo(300, 450);
    await sleep(400);
    const closedAgain = await cdp.eval(actionsExpr);
    if (closedAgain.plus.w !== 0 || (await readMenu(cdp)).length !== 0) {
      throw new Error(`关菜单、移开光标后应收回「…」 ${JSON.stringify(closedAgain)}`);
    }
    // 直接点「…」= 收起侧栏
    await clickAt(cdp, center(closedAgain.toggle));
    await waitFor(async () => (!(await readSide(cdp)).open ? true : null), {
      timeout: 3_000,
      interval: 80,
      label: '点「…」收起侧栏',
    });
    await shoot(cdp, '/tmp/sidepanel-actions-collapsed.png').catch(() => {});
    checks.push({ name: '顶栏按钮收纳为「…」：hover 展开、菜单开着保持、点击即收起', pass: true });
    log(JSON.stringify({ checks, shots: SHOTS }, null, 2));
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
  console.error('内部超时 420s');
  if (devLogTail) console.error(devLogTail);
  void finish(124);
}, 420_000);

main()
  .then(() => finish(0))
  .catch((error) => {
    console.error(error);
    if (devLogTail) console.error(devLogTail);
    return finish(1);
  });
