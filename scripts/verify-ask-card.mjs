// 提问卡片限高验收。隔离 dev 实例注入一条长提问和叠在输入框上的卡片，
// 量三种视口里主输入框、选项和提问滚动区。不发模型请求，不碰真实 userData。
//
//   node scripts/verify-ask-card.mjs [--root <repo>] [--out-prefix /tmp/ask-card-] [--keep]
//
// 截图：<prefix>desktop.png、<prefix>390.png、<prefix>short-window.png。
// 窗口最小宽度是 800，手机宽靠 Emulation.setDeviceMetricsOverride 改布局视口。
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
const PREFIX = flag('--out-prefix') ?? '/tmp/ask-card-';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
  { name: 'short-window', width: 1000, height: 600 },
];
const OPTION_TEXT = ['采用推荐方案', '保持现状', '稍后再说'];
const GOAL_TEXT = '让提问卡片限高，主输入框留在窗口里';

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

const MEASURE = `(() => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const ask = document.querySelector('[data-enso="ask"]');
  const question = document.querySelector('[data-enso="ask-question"]');
  const composer = document.querySelector('[data-enso="composer"]');
  const timeline = document.querySelector('[data-enso="timeline"]');
  const input = ask ? ask.querySelector('input') : null;
  const optionText = ${JSON.stringify(OPTION_TEXT)};
  const options = ask
    ? [...ask.querySelectorAll('button')].filter((button) =>
        optionText.some((text) => (button.textContent || '').includes(text))
      )
    : [];
  const rect = (el) => {
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return {
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
    };
  };
  const inside = (box) =>
    !!box &&
    box.width > 0 &&
    box.height > 0 &&
    box.left >= -1 &&
    box.top >= -1 &&
    box.right <= vw + 1 &&
    box.bottom <= vh + 1;
  const intersects = (box) =>
    !!box && box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.left < vw && box.top < vh;
  const hit = (el) => {
    if (!el) return false;
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    if (x < 0 || y < 0 || x >= vw || y >= vh) return false;
    const node = document.elementFromPoint(x, y);
    return !!node && (node === el || el.contains(node));
  };
  const style = question ? getComputedStyle(question) : null;
  const questionText = question?.textContent || '';
  return {
    vw,
    vh,
    visibility: document.visibilityState,
    composer: rect(composer),
    composerInside: inside(rect(composer)),
    timelineH: timeline ? timeline.getBoundingClientRect().height : 0,
    ask: !!ask,
    todo: !!document.querySelector('[data-enso="todo"]'),
    goal: (document.body.innerText || '').includes(${JSON.stringify(GOAL_TEXT)}),
    task: (document.body.innerText || '').includes('pnpm test'),
    placeholder: input ? input.placeholder : null,
    inputIntersects: intersects(rect(input)),
    inputHit: hit(input),
    options: options.map((button) => ({
      intersects: intersects(rect(button)),
      hit: hit(button),
    })),
    questionScroll: question ? question.scrollHeight : null,
    questionClient: question ? question.clientHeight : null,
    overscroll: style ? style.overscrollBehaviorY : null,
    questionLines: questionText.split('\\n').length,
  };
})()`;

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

async function injectScene(cdp, projectPath) {
  const payload = JSON.stringify({ projectPath, goalText: GOAL_TEXT, options: OPTION_TEXT });
  const raw = await cdp.eval(`(async () => {
    const spec = ${payload};
    const sessions = window.__stores.sessions;
    const settings = window.__stores.settings;
    settings.setState({ onboarded: true, language: 'zh-CN', pinUnfinishedTodos: true });
    const project = await settings.getState().addProject(spec.projectPath);
    const id = await sessions.getState().newConversation(project.id);
    if (!id) return JSON.stringify({ ok: false, error: 'newConversation 返回空' });
    const lines = Array.from({ length: 25 }, (_, index) =>
      '第' + (index + 1) + '行：这是一段用来把提问卡片撑高的中文正文，检查主输入框会不会被顶出窗口。'
    );
    const ask = {
      requestId: 'ask-verify-1',
      question: lines.join('\\n'),
      options: spec.options,
      recommended: spec.options[0],
      expiresAt: Date.now() + 15 * 60 * 1000,
      relay: { name: '爱酱' },
    };
    const todo = {
      role: 'toolResult',
      toolName: 'todo',
      toolCallId: 'todo-verify-1',
      content: [],
      todos: [
        { content: '限制提问卡片高度', status: 'in_progress' },
        { content: '保住主输入框', status: 'pending' },
      ],
    };
    const task = {
      taskId: 'task-verify-1',
      command: 'pnpm test',
      status: 'running',
      tail: 'running\\n',
      startedAt: Date.now(),
    };
    const goal = {
      text: spec.goalText,
      status: 'active',
      autoTurns: 0,
      noProgressRuns: 0,
    };
    sessions.setState((state) => {
      const current = state.conversations[id];
      return {
        activeId: id,
        conversations: {
          ...state.conversations,
          [id]: {
            ...current,
            pendingAsks: [ask],
            goal,
            backgroundTasks: [task],
            messages: [...(current.messages ?? []), todo],
          },
        },
      };
    });
    return JSON.stringify({
      ok: true,
      id,
      asks: sessions.getState().conversations[id]?.pendingAsks?.length ?? 0,
      started: sessions.getState().conversations[id]?.started === true,
    });
  })()`);
  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error || '注入场景失败');
  if (parsed.started) throw new Error('会话已启动，拒绝继续以免发出模型请求');
  await waitFor(
    () =>
      cdp.eval(`(() => Boolean(
        document.querySelector('[data-enso="composer"]') &&
        document.querySelector('[data-enso="ask"]') &&
        document.querySelector('[data-enso="todo"]') &&
        document.querySelector('[data-enso="timeline"]')
      ))()`),
    { timeout: 20_000, label: '提问卡片和输入框出现' }
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
    { timeout: 8_000, label: `视口 ${viewport.name} ${viewport.width}x${viewport.height}` }
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

function tableRow(viewport, metrics, png) {
  const composer = metrics.composer;
  return {
    viewport: viewport.name,
    inner: `${metrics.vw}x${metrics.vh}`,
    png: png ? `${png.width}x${png.height}` : '',
    composerBottom: composer ? Math.round(composer.bottom) : null,
    composerRight: composer ? Math.round(composer.right) : null,
    composerInside: metrics.composerInside,
    inputHit: metrics.inputHit,
    inputSee: metrics.inputIntersects,
    optionHits: metrics.options.map((option) => option.hit).join(',') || 'none',
    scroll: metrics.questionScroll,
    client: metrics.questionClient,
    overscroll: metrics.overscroll,
    timelineH: Math.round(metrics.timelineH),
    lines: metrics.questionLines,
    cards: ['ask', 'todo', 'goal', 'task'].filter((name) => metrics[name]).join('+') || 'none',
    visibility: metrics.visibility,
  };
}

function assertRows(rows) {
  const errors = [];
  for (const row of rows) {
    const name = row.viewport;
    const metrics = row.metrics;
    if (metrics.visibility !== 'visible') errors.push(`${name}: visibility=${metrics.visibility}`);
    if (
      Math.abs(metrics.vw - row.viewportSpec.width) > 2 ||
      Math.abs(metrics.vh - row.viewportSpec.height) > 2
    ) {
      errors.push(
        `${name}: 视口 ${metrics.vw}x${metrics.vh} 不是 ${row.viewportSpec.width}x${row.viewportSpec.height}`
      );
    }
    if (!metrics.ask || !metrics.todo || !metrics.goal || !metrics.task) {
      errors.push(`${name}: 卡片不全 cards=${row.table.cards}`);
    }
    if (!metrics.composerInside) {
      const box = metrics.composer;
      errors.push(
        `${name}: composer 不在视口内 bottom=${box ? Math.round(box.bottom) : 'null'} right=${box ? Math.round(box.right) : 'null'} inner=${metrics.vh}x${metrics.vw}`
      );
    }
    if (!metrics.inputIntersects || !metrics.inputHit) {
      errors.push(
        `${name}: 输入回答未可见或被裁切 intersects=${metrics.inputIntersects} hit=${metrics.inputHit} placeholder=${metrics.placeholder}`
      );
    }
    if (
      metrics.options.length !== 3 ||
      metrics.options.some((option) => !option.intersects || !option.hit)
    ) {
      errors.push(`${name}: 选项按钮 ${metrics.options.length} 个，命中 ${row.table.optionHits}`);
    }
    if (!(metrics.questionScroll > metrics.questionClient)) {
      errors.push(
        `${name}: 提问区未滚动 scroll=${metrics.questionScroll} client=${metrics.questionClient}`
      );
    }
    if (metrics.overscroll !== 'contain')
      errors.push(`${name}: overscroll-behavior-y=${metrics.overscroll}`);
    if (!(metrics.timelineH > 0)) errors.push(`${name}: timeline 高度 ${metrics.timelineH}`);
    if (!(metrics.questionLines >= 25))
      errors.push(`${name}: 提问只有 ${metrics.questionLines} 行`);
  }
  assert.deepEqual(errors, []);
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
  artDir = mkdtempSync('/tmp/enso-ask-card-');
  const userData = path.join(artDir, 'user-data');
  const projectPath = path.join(artDir, 'project');
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(path.join(projectPath, 'README.md'), 'ask card verify\n');
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
    const scene = await injectScene(cdp, projectPath);
    log(`会话 ${scene.id} asks=${scene.asks} started=${scene.started}`);
    const rows = [];
    for (const viewport of VIEWPORTS) {
      const size = await applyViewport(cdp, viewport);
      if (size.v !== 'visible')
        throw new Error(`${viewport.name} visibility=${size.v}，命中测试无效`);
      await sleep(150);
      const metrics = await cdp.eval(MEASURE);
      const file = `${PREFIX}${viewport.name}.png`;
      const png = await shoot(cdp, file, viewport);
      const table = tableRow(viewport, metrics, png);
      rows.push({ viewport: viewport.name, viewportSpec: viewport, metrics, table, file });
      log(file);
    }
    console.table(rows.map((row) => row.table));
    assertRows(rows);
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
