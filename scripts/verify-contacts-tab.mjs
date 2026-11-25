// 秘书面板「联系方式」tab 恢复后的真机验收。
// 隔离 dev 实例：注入秘书状态、在渲染进程打桩联系方式 IPC，打开秘书面板并
// 切到联系方式 tab，断言分组卡片、渠道列表、主人身份都在，按手机宽度截图。
// 隔离逻辑复制自 verify-ask-card-layout.mjs。
//
//   node scripts/verify-contacts-tab.mjs [--root <repo>] [--keep]
//   node scripts/verify-contacts-tab.mjs --attach <cdp端口>   驱动已在跑的隔离 dev 实例，不再自己起
//
// 截图：
//   /tmp/contacts-tab-phone-390.png     手机宽度 390x844
//   /tmp/contacts-tab-phone-scroll.png  手机宽度向下滚动后
//   /tmp/contacts-tab-side.png          桌面窗口侧栏里的同一 tab
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
const ATTACH = Number(flag('--attach') ?? 0) || 0;
const ROOT = path.resolve(flag('--root') ?? path.resolve(import.meta.dirname, '..'));

const SHOTS = {
  phone: '/tmp/contacts-tab-phone-390.png',
  phoneScroll: '/tmp/contacts-tab-phone-scroll.png',
  side: '/tmp/contacts-tab-side.png',
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

function writeFakeSettings(userData) {
  mkdirSync(userData, { recursive: true });
  const state = {
    providers: [
      {
        id: 'pv-A',
        name: 'Provider A',
        api: 'anthropic-messages',
        apiKey: 'sk-fake-A',
        baseUrl: 'http://127.0.0.1:9',
        enabled: true,
        models: [{ id: 'fake-model-1' }],
      },
    ],
    defaultModel: { providerId: 'pv-A', modelId: 'fake-model-1' },
    onboarded: true,
    theme: 'system',
    language: 'zh-CN',
    pinUnfinishedTodos: true,
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
          window.__stores?.secretary?.getState &&
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

async function freezeMotion(cdp) {
  await cdp.eval(`(() => {
    let style = document.getElementById('enso-verify-freeze');
    if (!style) {
      style = document.createElement('style');
      style.id = 'enso-verify-freeze';
      document.documentElement.appendChild(style);
    }
    style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
    return true;
  })()`);
}

/** 注入项目与会话、在隔离实例里真的启用秘书（全走真 IPC，不打桩），然后开秘书面板 */
async function injectScene(cdp, projectPath) {
  const raw = await cdp.eval(`(async () => {
    const sessions = window.__stores.sessions;
    const settings = window.__stores.settings;
    settings.setState({ onboarded: true, language: 'zh-CN', secretaryEnabled: true });
    const project = await settings.getState().addProject(${JSON.stringify(projectPath)});
    const id = await sessions.getState().newConversation(project.id);
    if (!id) return JSON.stringify({ ok: false, error: 'newConversation 返回空' });

    // 真 IPC：新建秘书（建目录、注册联系方式服务）
    const created = await window.electronAPI.secretary.create();
    if (!created?.ok) return JSON.stringify({ ok: false, error: 'secretary.create: ' + JSON.stringify(created) });
    // 真 IPC：启用联系方式、写入主人 GitHub 账号
    await window.electronAPI.secretary.contactSettings({ enabled: true }, created.secretaryId);
    await window.electronAPI.secretary.contactSettings({ githubLogins: ['j3n5en'] }, created.secretaryId);
    const contact = await window.electronAPI.secretary.contactState(created.secretaryId);

    const sec = window.__stores.secretary;
    // 秘书状态由 Main 推送；验收不等推送，先读列表喂进 store 让面板立即可用
    const list = await window.electronAPI.secretary.list();
    const mine = list.find((entry) => entry.id === created.secretaryId);
    const now = Date.now();
    const profile = {
      version: 1,
      name: mine?.name ?? '爱酱',
      avatar: mine?.avatar ?? { color: '#7c6af7' },
      takeoverScope: { mode: 'explicit' },
      visibleProjectIds: 'all',
      maxRunningDispatches: 3,
      patrolEnabled: false,
      replyLanguage: 'zh',
      style: 'concise',
      notify: 'needs-user',
      updatedAt: now,
    };
    const state = await window.electronAPI.secretary.getState(created.secretaryId).catch(() => null);
    const next = state && typeof state === 'object' && 'enabled' in state ? state : {
      enabled: true,
      secretaryId: created.secretaryId,
      projectId: created.projectId,
      profile,
      persona: '',
      board: { needsYou: [], running: [], done: [], todos: [] },
      proposals: {},
      takeovers: [],
    };
    sec.setState({
      secretary: next,
      states: { [created.secretaryId]: next },
      secretaries: list,
      focusedId: created.secretaryId,
      welcomeOpen: false,
    });
    // __dockviewApi 在 dockview onReady 时才有：先把侧栏打开
    window.__stores.sidePanel.setState((state) => ({
      fullscreen: false,
      lastWidth: 560,
      uiByConversation: {
        ...state.uiByConversation,
        [id]: { ...(state.uiByConversation[id] ?? {}), open: true, width: 560 },
      },
      fullscreenByConversation: { ...state.fullscreenByConversation, [id]: false },
    }));
    await new Promise((resolve) => setTimeout(resolve, 800));
    const api = window.__dockviewApi;
    let added = 'no-api';
    if (api?.addPanel) {
      try {
        const existing = api.getPanel?.('secretary');
        if (existing) {
          existing.api?.setActive?.();
          added = 'focus';
        } else {
          api.addPanel({
            id: 'secretary',
            component: 'secretary',
            title: profile.name,
            params: { conversationId: id, projectId: created.projectId },
          });
          added = 'add';
        }
      } catch (error) {
        added = 'error:' + (error && error.message ? error.message : String(error));
      }
    }
    return JSON.stringify({
      ok: true,
      id,
      projectId: project.id,
      secretaryId: created.secretaryId,
      secretaryProjectId: created.projectId,
      added,
      contactEnabled: contact?.enabled,
      contactChannels: contact?.channels?.map((ch) => ch.id) ?? [],
    });
  })()`);
  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error || '注入失败');
  return parsed;
}

/** 切到联系方式 tab（tab 是面板本地状态，只能点） */
async function openContactTab(cdp) {
  return waitFor(
    async () => {
      const done = await cdp.eval(`(() => {
        const tab = document.querySelector('[data-enso="secretary-panel-tab"][data-tab="contact"]');
        if (!tab) return 'no-tab';
        if (tab.getAttribute('data-active') !== 'true') tab.click();
        const panel = document.querySelector('[data-enso="secretary-contact"]');
        if (!panel) return 'no-panel';
        return panel.querySelector('[data-enso="secretary-contact-owner"]') ? 'ready' : 'loading';
      })()`);
      return done === 'ready' ? true : null;
    },
    { timeout: 15_000, label: '联系方式 tab 就绪' }
  );
}

async function setSideWidth(cdp, conversationId, width, open) {
  await cdp.eval(`(() => {
    const id = ${JSON.stringify(conversationId)};
    const side = window.__stores.sidePanel;
    side.setState((state) => ({
      fullscreen: false,
      lastWidth: ${width},
      uiByConversation: {
        ...state.uiByConversation,
        [id]: { ...(state.uiByConversation[id] ?? {}), open: ${open ? 'true' : 'false'}, width: ${width} },
      },
      fullscreenByConversation: { ...state.fullscreenByConversation, [id]: false },
    }));
    return true;
  })()`);
}

async function applyViewport(cdp, viewport) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.width < 500,
  });
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return waitFor(
    async () => {
      const size = await cdp.eval(`(() => {
        window.dispatchEvent(new Event('resize'));
        return { w: window.innerWidth, h: window.innerHeight, v: document.visibilityState };
      })()`);
      const close =
        Math.abs(size.w - viewport.width) <= 2 && Math.abs(size.h - viewport.height) <= 2;
      return close ? size : null;
    },
    { timeout: 8_000, label: `视口 ${viewport.width}x${viewport.height}` }
  );
}

async function shoot(cdp, file, viewport) {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: 1 },
  });
  writeFileSync(file, Buffer.from(data, 'base64'));
  return pngSize(file);
}

/** 联系方式 tab 的结构与布局断言 */
async function measureContacts(cdp) {
  return cdp.eval(`(() => {
    const root = document.querySelector('[data-enso="secretary-contact"]');
    if (!root) return { root: false };
    const owner = root.querySelector('[data-enso="secretary-contact-owner"]');
    const ownerGroup = root.querySelector('[data-settings-row="contacts.owner"]');
    const channelsGroup = root.querySelector('[data-settings-row="contacts.channels"]');
    const master = root.querySelector('[data-enso="secretary-contact-master"]');
    const channels = [...root.querySelectorAll('[data-enso="secretary-contact-channel"]')];
    const groups = root.querySelector('[data-settings-row="contacts.channels"] [data-slot="settings-group"]')
      ?? root.querySelector('[data-slot="settings-group"]');
    const input = root.querySelector('[data-enso="secretary-contact-github-logins"]');
    const scroll = document.querySelector('[data-enso="secretary-panel-scroll"]');
    // 横向溢出：面板内最宽元素不超过面板宽
    let overflowEl = null;
    if (scroll) {
      const limit = scroll.clientWidth + 2;
      for (const el of root.querySelectorAll('*')) {
        const box = el.getBoundingClientRect();
        const scrollBox = scroll.getBoundingClientRect();
        // ≤1px 的是开关这类控件的 sr-only 隐藏 input，不算溢出
        if (box.width > 1 && box.height > 1 && (box.right > scrollBox.right + 2 || box.left < scrollBox.left - 2)) {
          overflowEl = el.getAttribute('data-enso') || el.className?.slice?.(0, 60) || el.tagName;
          break;
        }
      }
    }
    const rect = (el) => {
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) };
    };
    const logins = input?.value ?? '';
    return {
      root: true,
      vw: window.innerWidth,
      visibility: document.visibilityState,
      owner: Boolean(owner),
      ownerGroup: Boolean(ownerGroup),
      channelsGroup: Boolean(channelsGroup),
      master: Boolean(master),
      masterInChannels: Boolean(master && channelsGroup && channelsGroup.contains(master)),
      channelIds: channels.map((el) => el.getAttribute('data-channel')),
      switches: root.querySelectorAll('[role="switch"]').length,
      logins,
      overflowEl,
      scrollW: scroll ? scroll.scrollWidth : 0,
      clientW: scroll ? scroll.clientWidth : 0,
      ownerRect: rect(owner),
      groupRects: [...root.querySelectorAll('[data-slot="settings-group"]')].map(rect),
      panelRect: rect(scroll),
      height: root.getBoundingClientRect().height,
    };
  })()`);
}

function contactErrors(name, metrics) {
  const errors = [];
  if (metrics.visibility !== 'visible') errors.push(`${name}: visibility=${metrics.visibility}`);
  if (!metrics.root) {
    errors.push(`${name}: 没有 [data-enso=secretary-contact]`);
    return errors;
  }
  if (!metrics.owner) errors.push(`${name}: 缺主人身份块`);
  if (!metrics.ownerGroup) errors.push(`${name}: 缺「主人身份」分组卡片`);
  if (!metrics.channelsGroup) errors.push(`${name}: 缺「联系渠道」分组卡片`);
  if (!metrics.masterInChannels) errors.push(`${name}: 总开关不在联系渠道分组里`);
  if (!metrics.channelIds.includes('telegram')) errors.push(`${name}: 渠道列表缺 Telegram`);
  if (!(metrics.switches >= 4)) errors.push(`${name}: 开关少于 4 个（实际 ${metrics.switches}）`);
  if (metrics.logins !== 'j3n5en')
    errors.push(`${name}: GitHub 账号输入框没有回填（${metrics.logins}）`);
  if (metrics.overflowEl) errors.push(`${name}: 横向溢出元素 ${metrics.overflowEl}`);
  if (metrics.scrollW > metrics.clientW + 2) {
    errors.push(`${name}: 横向滚动 scroll=${metrics.scrollW} client=${metrics.clientW}`);
  }
  return errors;
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
  if (!artDir) return;
  if (KEEP) {
    log(`保留 ${artDir}`);
    return;
  }
  rmSync(artDir, { recursive: true, force: true });
  log(`已删除 ${artDir}`);
}

async function main() {
  if (!existsSync(path.join(ROOT, 'package.json'))) throw new Error(`找不到仓库 ${ROOT}`);
  if (!existsSync(path.join(ROOT, 'node_modules/.bin/electron-vite'))) {
    throw new Error(`缺少 ${path.join(ROOT, 'node_modules/.bin/electron-vite')}`);
  }
  artDir = ATTACH ? null : mkdtempSync('/tmp/enso-contacts-tab-');
  const userData = artDir ? path.join(artDir, 'user-data') : null;
  const projectPath = path.join(artDir ?? '/tmp/enso-contacts-attach', 'project');
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(path.join(projectPath, 'README.md'), 'contacts tab verify\n');
  if (userData) writeFakeSettings(userData);

  const cdpPort = ATTACH || (await reserveCdpPort());
  log(`root ${ROOT}`);
  log(`userData ${userData}`);
  log(`cdp ${cdpPort}`);
  if (!ATTACH) {
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
  }

  const cdp = await waitForStablePage(cdpPort);
  try {
    await freezeMotion(cdp);
    const scene = await injectScene(cdp, projectPath);
    log(
      `会话 ${scene.id} 秘书 ${scene.secretaryId} added=${scene.added} contact=${scene.contactEnabled} channels=${scene.contactChannels}`
    );
    await setSideWidth(cdp, scene.id, 560, true);
    await sleep(600);
    await openContactTab(cdp);
    log('联系方式 tab 就绪');

    const rows = [];
    // 手机宽度 390：联系方式 tab 全宽
    await freezeMotion(cdp);
    await applyViewport(cdp, { width: 390, height: 844 });
    await setSideWidth(cdp, scene.id, 390, true);
    await sleep(300);
    await openContactTab(cdp);
    const phone = await measureContacts(cdp);
    const png1 = await shoot(cdp, SHOTS.phone, { width: 390, height: 844 });
    log(`${SHOTS.phone} ${png1.width}x${png1.height}`);
    rows.push({ name: 'phone', metrics: phone });

    // 手机宽度向下滚一屏：主人身份与渠道卡片内容
    await cdp.eval(`(() => {
      const scroll = document.querySelector('[data-enso="secretary-panel-scroll"]');
      if (scroll) scroll.scrollTop = 480;
      return true;
    })()`);
    await sleep(150);
    const png2 = await shoot(cdp, SHOTS.phoneScroll, { width: 390, height: 844 });
    log(`${SHOTS.phoneScroll} ${png2.width}x${png2.height}`);

    // 桌面窗口 + 侧栏：同一 tab 在桌面的样子
    await applyViewport(cdp, { width: 1440, height: 900 });
    await setSideWidth(cdp, scene.id, 560, true);
    await sleep(300);
    await cdp.eval(`(() => {
      const scroll = document.querySelector('[data-enso="secretary-panel-scroll"]');
      if (scroll) scroll.scrollTop = 0;
      return true;
    })()`);
    await sleep(150);
    const side = await measureContacts(cdp);
    const png3 = await shoot(cdp, SHOTS.side, { width: 1440, height: 900 });
    log(`${SHOTS.side} ${png3.width}x${png3.height}`);
    rows.push({ name: 'side', metrics: side });

    console.table(
      rows.map((row) => ({
        scene: row.name,
        vw: row.metrics.vw,
        channels: (row.metrics.channelIds ?? []).join(','),
        switches: row.metrics.switches,
        scrollW: row.metrics.scrollW,
        clientW: row.metrics.clientW,
        overflow: row.metrics.overflowEl ?? '',
      }))
    );
    const errors = rows.flatMap((row) => contactErrors(row.name, row.metrics));
    assert.deepEqual(errors, []);
    log('PASS');
  } finally {
    cdp.close();
  }
}

process.on('SIGINT', () => finish(130));
process.on('SIGTERM', () => finish(143));
process.on('uncaughtException', (error) => {
  console.error(error);
  finish(1);
});

let finishing = false;
function finish(code) {
  if (finishing) return;
  finishing = true;
  void cleanup().finally(() => process.exit(code));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  if (devLogTail) console.error(`--- dev 日志尾巴 ---\n${devLogTail}`);
  finish(1);
});
