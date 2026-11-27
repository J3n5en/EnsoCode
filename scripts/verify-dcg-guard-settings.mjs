// dcg 0.17.2 设置页验收。隔离 dev 实例（临时 userData、ENSO_VERIFY=1），拍两张：
//   1. /tmp/dcg-017-upgrade.png    预置 dcg/0.16.0 旧二进制：可升级状态 + 升级按钮 + 子开关禁用
//   2. /tmp/dcg-017-latest.png     预置 dcg/0.17.2 二进制且 dcgProcessGuard 开启：已安装最新版 + 子开关开
// 不发模型请求，不碰真实 userData。整体 170s 硬超时，跑完清理进程与临时目录。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { uiElementElectron } from './verify-electron.mjs';
import { mergeOwnedPids, ownedProcessGroups } from './verify-secretary-isolation.mjs';

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const ROOT = path.resolve(import.meta.dirname, '..');
const DCG016 = '/tmp/dcg-verify/bin016/dcg';
const DCG017 = '/tmp/dcg-verify/bin017/dcg';

const HARD_LIMIT = setTimeout(() => {
  console.error('verify-dcg-guard-settings: 170s 硬超时');
  finish(124);
}, 170_000);
HARD_LIMIT.unref?.();

const children = [];
const trackedPids = [];
let artDir = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function log(line) {
  console.log(line);
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
    } catch {}
  }
  for (const pid of owned) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

async function waitFor(fn, { timeout = 30_000, interval = 200, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}`);
    await sleep(interval);
  }
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

function writeFakeSettings(userData, extra = {}) {
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
    ...extra,
  };
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({ 'enso-settings': { state, version: 18 } })
  );
}

function plantDcg(userData, version, binary) {
  const dir = path.join(userData, 'dcg', version);
  mkdirSync(dir, { recursive: true });
  const bytes = readFileSync(binary);
  writeFileSync(path.join(dir, 'dcg'), bytes, { mode: 0o755 });
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
          window.__stores?.settings?.getState &&
          window.__stores?.settingsView?.open &&
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
    stdio: ['ignore', 'ignore', 'ignore'],
  });
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

async function shoot(cdp, file, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(250);
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  writeFileSync(file, Buffer.from(data, 'base64'));
  log(file);
}

const OPEN_DCG = `(() => {
  window.__stores.settingsView.open({ category: 'tools', rowId: 'tools.dcgEnabled' });
  return true;
})()`;

const DISABLE_MOTION = `(() => {
  if (document.getElementById('enso-verify-no-motion')) return true;
  const style = document.createElement('style');
  style.id = 'enso-verify-no-motion';
  style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
  document.head.appendChild(style);
  return true;
})()`;

const SCROLL_DCG = `(() => {
  const row = document.querySelector('[data-settings-row="tools.dcgEnabled"]');
  if (!row) return 'missing';
  row.scrollIntoView({ block: 'start' });
  return 'ok';
})()`;

const READ_STATE = `(() => {
  const text = document.body.innerText || '';
  const row = document.querySelector('[data-settings-row="tools.dcgEnabled"]');
  return {
    rowPresent: !!row,
    upgradeText: text.includes('可升级到'),
    upgradeButton: text.includes('升级到 v0.17.2'),
    processGuard: text.includes('拦截批量杀进程'),
    needUpgrade: text.includes('后可开启'),
    installed017: text.includes('已安装 v0.17.2'),
    installed016: text.includes('已安装 v0.16.0'),
  };
})()`;

async function openDcgSettings(cdp) {
  await cdp.eval(OPEN_DCG);
  await waitFor(
    async () => {
      const state = await cdp.eval(READ_STATE);
      return state.rowPresent ? state : null;
    },
    { timeout: 20_000, interval: 300, label: 'dcg 守卫设置行' }
  );
  await cdp.eval(SCROLL_DCG);
  await sleep(400);
}

async function shootState(name, extraSettings, version, binary, expectations) {
  const userData = path.join(artDir, `user-data-${name}`);
  writeFakeSettings(userData, extraSettings);
  plantDcg(userData, version, binary);
  const cdpPort = await reserveCdpPort();
  log(`${name}: userData ${userData} cdp ${cdpPort}`);
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
    { timeout: 90_000, interval: 500, label: `${name} 隔离 CDP 页面` }
  );
  const cdp = await waitForStablePage(cdpPort);
  try {
    await cdp.eval(DISABLE_MOTION);
    await openDcgSettings(cdp);
    const state = await cdp.eval(READ_STATE);
    log(`${name}: ${JSON.stringify(state)}`);
    for (const [key, expected] of Object.entries(expectations)) {
      assert.equal(state[key], expected, `${name}: ${key} 应为 ${expected}（实际 ${state[key]}）`);
    }
    await shoot(cdp, `/tmp/dcg-017-${name}.png`, 1440, 900);
  } finally {
    cdp.close();
    signalOwned('SIGTERM');
    await sleep(600);
    signalOwned('SIGKILL');
    children.length = 0;
    trackedPids.length = 0;
  }
}

async function main() {
  for (const bin of [DCG016, DCG017]) {
    try {
      readFileSync(bin);
    } catch {
      throw new Error(`缺少实测二进制 ${bin}（0.17.2 规则核对脚本应已下载到 /tmp/dcg-verify）`);
    }
  }
  artDir = mkdtempSync('/tmp/enso-dcg-verify-');

  await shootState('upgrade', { dcgEnabled: true }, '0.16.0', DCG016, {
    upgradeText: true,
    upgradeButton: true,
    processGuard: true,
    needUpgrade: true,
    installed016: true,
  });

  await shootState('latest', { dcgEnabled: true, dcgProcessGuard: true }, '0.17.2', DCG017, {
    upgradeText: false,
    upgradeButton: false,
    processGuard: true,
    needUpgrade: false,
    installed017: true,
  });

  log('PASS');
}

let finishing = null;
function finish(code) {
  if (!finishing) {
    clearTimeout(HARD_LIMIT);
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
  void finish(1);
});

main()
  .then(() => finish(0))
  .catch((error) => {
    console.error(error);
    void finish(1);
  });
