// 设置项级搜索验收。隔离 dev 实例打开设置页，在搜索框输入中英文查询，
// 截图结果列表，点击命中项后截图高亮闪烁的行。不发模型请求，不碰真实 userData。
//
//   node scripts/verify-settings-search.mjs [--root <repo>] [--out-prefix /tmp/settings-search-] [--keep]
//
// 截图：<prefix><case>.png。断言失败非零退出。--keep 保留临时 userData。

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
const PREFIX = flag('--out-prefix') ?? '/tmp/settings-search-';

// 每个用例：语言、查询词、是否点击第一个命中验证闪烁
const CASES = [
  { name: 'zh-title', language: 'zh-CN', query: '会话标题', flash: true },
  { name: 'zh-channel', language: 'zh-CN', query: '更新渠道', flash: true },
  { name: 'zh-enquery', language: 'zh-CN', query: 'session title', flash: false },
  { name: 'en-zhquery', language: 'en', query: '会话标题', flash: false },
];

const children = [];
const trackedPids = [];
let artDir = null;

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

async function waitFor(fn, { timeout = 30_000, interval = 200, label = 'condition' } = {}) {
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
          window.__stores?.settingsView?.open &&
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

async function openSettingsPage(cdp, language) {
  const raw = await cdp.eval(`(async () => {
    const settings = window.__stores.settings;
    settings.setState({ onboarded: true, language: ${JSON.stringify(language)} });
    window.__stores.settingsView.open();
    return 'ok';
  })()`);
  if (raw !== 'ok') throw new Error(`打开设置页失败: ${raw}`);
  await waitFor(
    () =>
      cdp.eval(`(() => Boolean(
        document.querySelector('[data-enso="settings-nav"] input')
      ))()`),
    { timeout: 15_000, label: '设置页搜索框出现' }
  );
}

async function typeQuery(cdp, query) {
  const raw = await cdp.eval(`(() => {
    const input = document.querySelector('[data-enso="settings-nav"] input');
    if (!input) return JSON.stringify({ ok: false, error: 'no input' });
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(query)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return JSON.stringify({ ok: true });
  })()`);
  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  await sleep(350);
}

async function readHits(cdp) {
  const raw = await cdp.eval(`(() => {
    const nav = document.querySelector('[data-enso="settings-nav"]');
    if (!nav) return JSON.stringify({ hits: [], error: 'no nav' });
    const buttons = [...nav.querySelectorAll('button')];
    // 命中行：text-xs（分类按钮是 text-sm）
    const hits = [];
    for (const button of buttons) {
      const cls = button.className || '';
      if (!cls.includes('text-xs')) continue;
      hits.push({ text: button.textContent.trim() });
    }
    const empty = (nav.textContent || '').trim();
    return JSON.stringify({ hits, navText: empty.slice(0, 400) });
  })()`);
  return JSON.parse(raw);
}

async function clickHit(cdp, index) {
  const raw = await cdp.eval(`(() => {
    const nav = document.querySelector('[data-enso="settings-nav"]');
    if (!nav) return JSON.stringify({ ok: false, error: 'no nav' });
    const buttons = [...nav.querySelectorAll('button')].filter((button) =>
      (button.className || '').includes('text-xs')
    );
    const target = buttons[${JSON.stringify(index)}];
    if (!target) return JSON.stringify({ ok: false, error: 'no hit', count: buttons.length });
    target.click();
    return JSON.stringify({ ok: true, text: target.textContent.trim() });
  })()`);
  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error + ` count=${parsed.count}`);
  return parsed;
}

async function readFlashState(cdp) {
  const raw = await cdp.eval(`(() => {
    const el = document.querySelector('[data-settings-flash]');
    if (!el) return JSON.stringify({ flashing: false, rowId: null });
    const rect = el.getBoundingClientRect();
    return JSON.stringify({
      flashing: true,
      rowId: el.getAttribute('data-settings-row'),
      top: rect.top,
      height: rect.height,
      inView: rect.top >= 0 && rect.top < window.innerHeight,
    });
  })()`);
  return JSON.parse(raw);
}

async function shoot(cdp, file, width, height) {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width, height, scale: 1 },
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
  const logPath = path.join(artDir, 'dev.log');
  const chunks = [];
  const collect = (buf) => {
    chunks.push(buf);
    if (chunks.length > 200) chunks.shift();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('exit', () => {
    try {
      writeFileSync(logPath, Buffer.concat(chunks));
    } catch {
      // 目录可能已经删了
    }
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

async function main() {
  if (!path.isAbsolute(PREFIX)) throw new Error('--out-prefix 必须是绝对路径');
  if (!existsSync(path.join(ROOT, 'package.json'))) throw new Error(`找不到仓库 ${ROOT}`);
  if (!existsSync(path.join(ROOT, 'node_modules/.bin/electron-vite'))) {
    throw new Error(`缺少 ${path.join(ROOT, 'node_modules/.bin/electron-vite')}`);
  }
  mkdirSync(path.dirname(PREFIX), { recursive: true });
  artDir = mkdtempSync('/tmp/enso-settings-search-');
  const userData = path.join(artDir, 'user-data');
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
    { timeout: 120_000, interval: 500, label: '隔离 CDP 页面' }
  );

  const cdp = await waitForStablePage(cdpPort);
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 860,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

    const failures = [];
    for (const testCase of CASES) {
      log(`case ${testCase.name} query=${testCase.query} lang=${testCase.language}`);
      await openSettingsPage(cdp, testCase.language);
      await typeQuery(cdp, testCase.query);
      const { hits, navText } = await readHits(cdp);
      log(
        `  hits=${hits.length} ${hits
          .slice(0, 5)
          .map((h) => h.text)
          .join(' | ')}`
      );
      if (hits.length === 0) {
        failures.push(`${testCase.name}: 没有命中 nav=${navText.slice(0, 120)}`);
        continue;
      }
      const resultsFile = `${PREFIX}${testCase.name}-results.png`;
      await shoot(cdp, resultsFile, 1280, 860);
      log(`  ${resultsFile}`);
      if (!testCase.flash) continue;
      const clicked = await clickHit(cdp, 0);
      log(`  clicked "${clicked.text.slice(0, 60)}"`);
      // 闪烁动画期间尽快采样；先等跳转渲染一帧
      await sleep(350);
      const flash = await readFlashState(cdp);
      log(`  flash rowId=${flash.rowId} flashing=${flash.flashing} inView=${flash.inView}`);
      const flashFile = `${PREFIX}${testCase.name}-flash.png`;
      await shoot(cdp, flashFile, 1280, 860);
      log(`  ${flashFile}`);
      if (!flash.flashing || !flash.rowId) {
        failures.push(`${testCase.name}: 点击后没有闪烁行`);
      } else if (!flash.inView) {
        failures.push(`${testCase.name}: 闪烁行不在视口内 top=${flash.top}`);
      }
      // 清空查询准备下一个用例
      await typeQuery(cdp, '');
    }
    assert.deepEqual(failures, []);
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
  void finish(1);
});

main()
  .then(() => finish(0))
  .catch((error) => {
    console.error(error);
    return finish(1);
  });
