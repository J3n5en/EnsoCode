// 字号影响范围实测：隔离 dev 实例里把 terminalFontSize 从 14 调到 22，
// 对各区域探针量 computed font-size，验证它到底是终端字号还是全局 rem 基数。
//
//   node scripts/verify-font-impact.mjs [--root <repo>] [--out-prefix /tmp/fontmeasure-]
//
// 截图：<prefix><case>.png。断言失败非零退出。--keep 保留临时 userData。

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

async function openSettingsCategory(cdp, category) {
  const raw = await cdp.eval(`(async () => {
    const settings = window.__stores.settings;
    settings.setState({ onboarded: true });
    window.__stores.settingsView.open({ category: ${JSON.stringify(category)}, rowId: ${JSON.stringify(category)} + '.root' });
    return 'ok';
  })()`);
  if (raw !== 'ok') throw new Error(`打开设置页失败: ${raw}`);
  await waitFor(
    () =>
      cdp.eval(`(() => Boolean(
        document.querySelector('[data-enso="settings-nav"]') &&
        document.querySelector('[data-settings-row]')
      ))()`),
    { timeout: 15_000, label: '设置页内容出现' }
  );
  await sleep(600);
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

const PROBES = [
  ['html-rem-base', 'document.documentElement'],
  ['settings-row-label', "document.querySelector('[data-settings-row]')"],
  ['sidebar-nav-item', "document.querySelector('nav a, nav button')"],
  ['any-button', "document.querySelector('button')"],
  ['chat-assistant-msg', 'document.querySelector(\'[data-enso="message-assistant"]\')'],
  ['body', 'document.body'],
  ['chat-body-px-var', "document.getElementById('probe-chat-body')"],
  ['bash-output-text-xs', "document.getElementById('probe-bash-output')"],
  ['ui-text-sm', "document.getElementById('probe-text-sm')"],
  ['chat-h1-em', "document.getElementById('probe-chat-h1')"],
];

function probeExpr() {
  const entries = PROBES.map(
    ([name, sel]) =>
      `${JSON.stringify(name)}: (() => { const el = ${sel}; return el ? getComputedStyle(el).fontSize : null; })()`
  ).join(',');
  return `(() => JSON.stringify(({${entries}})))()`;
}

async function measure(cdp, label) {
  const result = await cdp.eval(probeExpr());
  const data = JSON.parse(result);
  log(`${label}: ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  if (!path.isAbsolute(PREFIX)) throw new Error('--out-prefix 必须是绝对路径');
  if (!existsSync(path.join(ROOT, 'package.json'))) throw new Error(`找不到仓库 ${ROOT}`);
  mkdirSync(path.dirname(PREFIX), { recursive: true });
  artDir = mkdtempSync('/tmp/enso-font-measure-');
  const userData = path.join(artDir, 'user-data');
  writeFakeSettings(userData);

  const cdpPort = await reserveCdpPort();
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

    await openSettingsCategory(cdp, 'terminal');

    // 注入探针元素：精确复刻对话正文 / bash 输出 / 标题的 class，量它们是否随 rem 基数缩放
    await cdp.eval(`(() => {
      const mk = (id, cls, style) => {
        const el = document.createElement('div');
        el.id = id;
        el.className = cls;
        if (style) el.setAttribute('style', style);
        el.textContent = 'probe';
        el.style.position = 'absolute';
        el.style.left = '-9999px';
        document.body.appendChild(el);
      };
      // 对话正文（TimelineRow 的 assistant 消息）
      mk('probe-chat-body', 'text-(length:--chat-body-size)');
      // bash 输出（TerminalOutput）
      mk('probe-bash-output', 'text-xs leading-relaxed');
      // 常见 UI 文字
      mk('probe-text-sm', 'text-sm');
      // 对话容器（带 chat-body 尺寸），h1 挂里面才能测出真实 em 基准
      mk('probe-chat-container', 'text-(length:--chat-body-size)');
      const h1 = document.createElement('div');
      h1.id = 'probe-chat-h1';
      h1.className = 'text-(length:--chat-h1-size)';
      h1.textContent = 'probe';
      document.getElementById('probe-chat-container').appendChild(h1);
      return 'ok';
    })()`);
    await sleep(300);

    const before = await measure(cdp, 'baseline(14)');
    await shoot(cdp, `${PREFIX}fontsize-14.png`, 1280, 860);
    log(`  ${PREFIX}fontsize-14.png`);

    await cdp.eval(
      `(() => { window.__stores.settings.getState().setTerminalFontSize(22); return 'ok'; })()`
    );
    await sleep(600);
    const after22 = await measure(cdp, 'terminalFontSize=22');
    await shoot(cdp, `${PREFIX}fontsize-22.png`, 1280, 860);
    log(`  ${PREFIX}fontsize-22.png`);

    const rows = [];
    for (const key of Object.keys(before)) {
      rows.push({
        area: key,
        before: before[key],
        after: after22[key],
        changed: before[key] !== after22[key],
      });
    }
    log(`MEASURE ${JSON.stringify(rows)}`);
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
