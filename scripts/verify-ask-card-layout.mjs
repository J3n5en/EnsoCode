// 提问卡片布局验收。隔离 dev 实例，证明长问题在会话和秘书侧栏里都独占卡片整宽。
// 隔离逻辑复制自 verify-ask-card.mjs（该文件加载即跑 main，不能 import）。
//
//   node scripts/verify-ask-card-layout.mjs [--root <repo>] [--keep]
//
// 截图：
//   /tmp/ask-card-layout-session-wide.png
//   /tmp/ask-card-layout-session-narrow.png
//   /tmp/ask-card-layout-secretary-wide.png
//   /tmp/ask-card-layout-secretary-narrow.png
//   /tmp/ask-card-layout-phone.png
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

const QUESTION = [
  '21300eec（chore/publish-trusted-sender）：worktree 是干净的，也没有进行中的操作；没有远端分支，查不到以它为 head 的 PR。分支 tip cdaccc2（#64 hongguo 的 squash 提交）本身就是 origin/main 的祖先……删还是跳过？',
  '/Users/someone/project/worktree/3e8dba26-4323-404d-9a0f-bfc787a8cace/7d0be5ed/packages/phone/src/very/long/path/without/spaces/file.tsx',
].join('\n');
const OPTIONS = ['删掉', '跳过', '先留着'];
const RECOMMENDED = '跳过';
const SHOTS = {
  'session-wide': '/tmp/ask-card-layout-session-wide.png',
  'session-narrow': '/tmp/ask-card-layout-session-narrow.png',
  'secretary-wide': '/tmp/ask-card-layout-secretary-wide.png',
  'secretary-narrow': '/tmp/ask-card-layout-secretary-narrow.png',
  phone: '/tmp/ask-card-layout-phone.png',
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

function measureExpr(scope) {
  const pick =
    scope === 'secretary' ? `document.querySelector('[data-enso="secretary-panel"]')` : 'document';
  return `(() => {
    const root = ${pick};
    const panel = document.querySelector('[data-enso="secretary-panel"]');
    const side = document.querySelector('[data-enso="side-panel"]');
    const ask = root
      ? [...root.querySelectorAll('[data-enso="ask"]')].find((node) => {
          const box = node.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        }) ?? null
      : null;
    const question = ask ? ask.querySelector('[data-enso="ask-question"]') : null;
    const relay = ask ? ask.querySelector('[data-enso="ask-relay"]') : null;
    const rect = (el) => {
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    const style = ask ? getComputedStyle(ask) : null;
    const pad = style ? parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) : 0;
    const content = ask ? ask.clientWidth - pad : 0;
    const inPanel = Boolean(ask && panel && panel.contains(ask));
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      visibility: document.visibilityState,
      hasRoot: Boolean(root),
      ask: Boolean(ask),
      inPanel,
      content,
      questionW: question ? question.getBoundingClientRect().width : 0,
      question: rect(question),
      relay: rect(relay),
      scrollWidth: question ? question.scrollWidth : 0,
      clientWidth: question ? question.clientWidth : 0,
      sideW: side ? Math.round(side.getBoundingClientRect().width) : 0,
      panelW: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
      questionText: question ? question.textContent : '',
    };
  })()`;
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

async function injectSession(cdp, projectPath) {
  const payload = JSON.stringify({
    projectPath,
    question: QUESTION,
    options: OPTIONS,
    recommended: RECOMMENDED,
  });
  const raw = await cdp.eval(`(async () => {
    const spec = ${payload};
    const sessions = window.__stores.sessions;
    const settings = window.__stores.settings;
    const side = window.__stores.sidePanel;
    settings.setState({ onboarded: true, language: 'zh-CN' });
    const project = await settings.getState().addProject(spec.projectPath);
    const id = await sessions.getState().newConversation(project.id);
    if (!id) return JSON.stringify({ ok: false, error: 'newConversation 返回空' });
    const ask = {
      requestId: 'ask-layout-1',
      question: spec.question,
      options: spec.options,
      recommended: spec.recommended,
      expiresAt: Date.now() + 10 * 60 * 1000,
      relay: { name: '爱酱' },
    };
    sessions.setState((state) => {
      const current = state.conversations[id];
      return {
        activeId: id,
        conversations: {
          ...state.conversations,
          [id]: { ...current, pendingAsks: [ask] },
        },
      };
    });
    side.setState((state) => ({
      fullscreen: false,
      uiByConversation: {
        ...state.uiByConversation,
        [id]: { ...(state.uiByConversation[id] ?? {}), open: false },
      },
    }));
    const row = sessions.getState().conversations[id];
    return JSON.stringify({
      ok: true,
      id,
      projectId: project.id,
      asks: row?.pendingAsks?.length ?? 0,
      started: row?.started === true,
    });
  })()`);
  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error || '注入会话失败');
  if (parsed.started) throw new Error('会话已启动，拒绝继续以免发出模型请求');
  await waitFor(
    () =>
      cdp.eval(`(() => {
        const ask = [...document.querySelectorAll('[data-enso="ask"]')].find(
          (node) => !node.closest('[data-enso="secretary-panel"]') && node.getBoundingClientRect().width > 0
        );
        return Boolean(ask && ask.querySelector('[data-enso="ask-question"]') && ask.querySelector('[data-enso="ask-relay"]'));
      })()`),
    { timeout: 20_000, label: '会话提问卡片出现' }
  );
  return parsed;
}

async function applyViewport(cdp, viewport) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
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
        Math.abs(size.w - viewport.width) <= 2 && Math.abs(size.h - viewport.height) <= 2;
      return close ? size : null;
    },
    { timeout: 8_000, label: `视口 ${viewport.width}x${viewport.height}` }
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

async function shoot(cdp, file, viewport) {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: 1 },
  });
  writeFileSync(file, Buffer.from(data, 'base64'));
  return pngSize(file);
}

async function readMetrics(cdp, scope) {
  await cdp.eval(`(() => {
    const root = ${scope === 'secretary' ? `document.querySelector('[data-enso="secretary-panel"]')` : 'document'};
    const ask = root?.querySelector('[data-enso="ask"]');
    ask?.scrollIntoView({ block: 'center', inline: 'nearest' });
    return true;
  })()`);
  await sleep(80);
  return cdp.eval(measureExpr(scope));
}

function layoutErrors(name, metrics, viewport) {
  const errors = [];
  if (metrics.visibility !== 'visible') errors.push(`${name}: visibility=${metrics.visibility}`);
  if (Math.abs(metrics.vw - viewport.width) > 2 || Math.abs(metrics.vh - viewport.height) > 2) {
    errors.push(
      `${name}: 视口 ${metrics.vw}x${metrics.vh} 不是 ${viewport.width}x${viewport.height}`
    );
  }
  if (!metrics.ask) errors.push(`${name}: 没有可见的提问卡片`);
  if (!(metrics.content > 0) || !(metrics.questionW >= metrics.content * 0.9)) {
    errors.push(
      `${name}: 正文宽 ${Math.round(metrics.questionW)} < 卡片内容宽 ${Math.round(metrics.content)} 的 90%`
    );
  }
  if (!metrics.relay || !metrics.question) {
    errors.push(`${name}: 缺少 relay 或正文`);
  } else if (!(metrics.relay.bottom <= metrics.question.top + 1)) {
    errors.push(
      `${name}: relay.bottom ${metrics.relay.bottom.toFixed(1)} > 正文 top ${metrics.question.top.toFixed(1)}`
    );
  }
  if (!(metrics.scrollWidth <= metrics.clientWidth + 1)) {
    errors.push(
      `${name}: 正文横向溢出 scroll=${metrics.scrollWidth} client=${metrics.clientWidth}`
    );
  }
  if (
    !metrics.questionText?.includes('21300eec') ||
    !metrics.questionText.includes('/very/long/path/')
  ) {
    errors.push(`${name}: 正文不是注入的长问题`);
  }
  if (name.startsWith('secretary') && !metrics.inPanel) {
    errors.push(`${name}: 卡片不在 [data-enso=secretary-panel] 内`);
  }
  if (!name.startsWith('secretary') && metrics.inPanel) {
    errors.push(`${name}: 量到了秘书面板里的卡片`);
  }
  const box = metrics.question;
  if (
    !box ||
    box.height < 20 ||
    box.bottom <= 0 ||
    box.top >= metrics.vh ||
    box.right <= 0 ||
    box.left >= metrics.vw
  ) {
    errors.push(`${name}: 正文不在视口内 ${box ? JSON.stringify(box) : 'null'}`);
  }
  return errors;
}

function rowOf(name, metrics, png) {
  const ratio = metrics.content > 0 ? metrics.questionW / metrics.content : 0;
  return {
    scene: name,
    inner: `${metrics.vw}x${metrics.vh}`,
    png: png ? `${png.width}x${png.height}` : '',
    qW: Math.round(metrics.questionW),
    content: Math.round(metrics.content),
    ratio: ratio.toFixed(3),
    relayBottom: metrics.relay ? Math.round(metrics.relay.bottom) : null,
    qTop: metrics.question ? Math.round(metrics.question.top) : null,
    scroll: metrics.scrollWidth,
    client: metrics.clientWidth,
    inPanel: metrics.inPanel,
    sideW: metrics.sideW,
    panelW: metrics.panelW,
  };
}

async function openSecretaryPanel(cdp, scene) {
  const payload = JSON.stringify(scene);
  await setSideWidth(cdp, scene.id, 640, true);
  const opened = await waitFor(
    async () => {
      const raw = await cdp.eval(`(() => {
        const spec = ${payload};
        const secretary = window.__stores.secretary;
        const now = Date.now();
        const profile = {
          version: 1,
          name: '爱酱',
          avatar: { color: '#7c6af7' },
          takeoverScope: { mode: 'explicit' },
          visibleProjectIds: 'all',
          maxRunningDispatches: 3,
          patrolEnabled: false,
          replyLanguage: 'zh',
          style: 'concise',
          notify: 'needs-user',
          updatedAt: now,
        };
        const card = {
          kind: 'session',
          conversationId: spec.id,
          projectId: spec.projectId,
          projectName: 'layout-verify',
          title: 'worktree 要删还是跳过',
          state: 'waiting',
          lastText: '等你决定删还是跳过',
          startedAt: now - 120000,
          stateSince: now - 60000,
          secretaryConversationId: spec.id,
        };
        const next = {
          enabled: true,
          secretaryId: 'layout-verify',
          projectId: spec.projectId,
          profile,
          persona: '',
          board: { needsYou: [card], running: [], done: [], todos: [] },
          proposals: {},
          takeovers: [],
        };
        secretary.setState({
          secretary: next,
          states: { 'layout-verify': next },
          secretaries: [{ id: 'layout-verify', projectId: spec.projectId, name: '爱酱', avatar: profile.avatar, order: 0 }],
          focusedId: 'layout-verify',
          welcomeOpen: false,
        });
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
                title: '爱酱',
                params: { conversationId: spec.id, projectId: spec.projectId },
              });
              added = 'add';
            }
          } catch (error) {
            added = 'error:' + (error && error.message ? error.message : String(error));
          }
        }
        const panel = document.querySelector('[data-enso="secretary-panel"]');
        const ask = panel?.querySelector('[data-enso="ask"]');
        return JSON.stringify({
          added,
          panel: Boolean(panel),
          ask: Boolean(ask),
          enabled: secretary.getState().secretary.enabled === true,
        });
      })()`);
      const parsed = JSON.parse(raw);
      if (parsed.ask && parsed.panel) return parsed;
      return null;
    },
    { timeout: 15_000, label: '秘书面板里的提问卡片' }
  );
  return opened;
}

async function waitSideWidth(cdp, min, max) {
  let previous = 0;
  return waitFor(
    async () => {
      const width = await cdp.eval(`(() => {
        const side = document.querySelector('[data-enso="side-panel"]');
        return side ? side.getBoundingClientRect().width : 0;
      })()`);
      const stable = Math.abs(width - previous) < 1;
      previous = width;
      return stable && width >= min && width <= max ? width : null;
    },
    { timeout: 8_000, label: `侧栏宽度 ${min}-${max}` }
  );
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

async function capture(cdp, name, viewport, scope) {
  await freezeMotion(cdp);
  const size = await applyViewport(cdp, viewport);
  if (size.v !== 'visible') throw new Error(`${name} visibility=${size.v}，命中测试无效`);
  await sleep(120);
  const metrics = await readMetrics(cdp, scope);
  const file = SHOTS[name];
  const png = await shoot(cdp, file, viewport);
  const table = rowOf(name, metrics, png);
  log(file);
  return { name, viewport, metrics, table, file };
}

async function main() {
  if (!existsSync(path.join(ROOT, 'package.json'))) throw new Error(`找不到仓库 ${ROOT}`);
  if (!existsSync(path.join(ROOT, 'node_modules/.bin/electron-vite'))) {
    throw new Error(`缺少 ${path.join(ROOT, 'node_modules/.bin/electron-vite')}`);
  }
  artDir = mkdtempSync('/tmp/enso-ask-layout-');
  const userData = path.join(artDir, 'user-data');
  const projectPath = path.join(artDir, 'project');
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(path.join(projectPath, 'README.md'), 'ask card layout verify\n');
  writeFakeSettings(userData);

  const cdpPort = await reserveCdpPort();
  log(`root ${ROOT}`);
  log(`userData ${userData}`);
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
    await freezeMotion(cdp);
    const scene = await injectSession(cdp, projectPath);
    log(`会话 ${scene.id} asks=${scene.asks} started=${scene.started}`);
    const desktop = { width: 1440, height: 900 };
    const rows = [];
    rows.push(
      await capture(cdp, 'session-wide', desktop, 'session'),
      await capture(cdp, 'session-narrow', { width: 480, height: 900 }, 'session'),
      await capture(cdp, 'phone', { width: 390, height: 844 }, 'session')
    );
    await applyViewport(cdp, desktop);
    const opened = await openSecretaryPanel(cdp, scene);
    log(`秘书面板 ${opened.added} panel=${opened.panel} ask=${opened.ask}`);
    await waitSideWidth(cdp, 500, 900);
    rows.push(await capture(cdp, 'secretary-wide', desktop, 'secretary'));
    await setSideWidth(cdp, scene.id, 280, true);
    await waitSideWidth(cdp, 260, 420);
    rows.push(await capture(cdp, 'secretary-narrow', desktop, 'secretary'));
    const wide = rows.find((row) => row.name === 'secretary-wide');
    const narrow = rows.find((row) => row.name === 'secretary-narrow');
    console.table(rows.map((row) => row.table));
    const errors = rows.flatMap((row) => layoutErrors(row.name, row.metrics, row.viewport));
    if (!(wide.metrics.sideW > narrow.metrics.sideW + 80)) {
      errors.push(`秘书宽侧栏 ${wide.metrics.sideW} 没有明显宽于窄侧栏 ${narrow.metrics.sideW}`);
    }
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
process.on('SIGALRM', () => void finish(124));
process.on('uncaughtException', (error) => {
  console.error(error);
  if (devLogTail) console.error(devLogTail);
  void finish(1);
});

const internalDeadline = setTimeout(() => {
  console.error('内部超时 170s');
  if (devLogTail) console.error(devLogTail);
  void finish(124);
}, 170_000);
internalDeadline.unref?.();

main()
  .then(() => finish(0))
  .catch((error) => {
    console.error(error);
    if (devLogTail) console.error(devLogTail);
    return finish(1);
  });
