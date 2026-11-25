// 秘书派发飞行动画验收。隔离 dev 实例，采样 secretary-flight 轨迹并截图。
//
//   node scripts/verify-dispatch-flight.mjs [--root <repo>] [--keep]
//
// 截图：/tmp/dispatch-flight-frame-NN.png
// 断言失败非零退出。--keep 保留临时 userData。不连 9222，不碰真实 userData。
// 隔离骨架复制自 verify-ask-card-layout.mjs（该文件加载即跑 main，不能 import）。

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { uiElementElectron } from './verify-electron.mjs';
import { mergeOwnedPids, ownedProcessGroups } from './verify-secretary-isolation.mjs';

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const ROOT = path.resolve(flag('--root') ?? path.resolve(import.meta.dirname, '..'));
const VIEWPORT = { width: 1440, height: 900 };
const FRAME_MS = 70;
const SAMPLE_MS = 9000;

const children = [];
const trackedPids = [];
let artDir = null;
let devLogTail = '';
let finishing = null;

setTimeout(() => {
  console.error('HARD TIMEOUT');
  if (devLogTail) console.error(devLogTail);
  void finish(1);
  setTimeout(() => process.exit(1), 4_000);
}, 170_000);

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

async function reservePort() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = await freePort();
    if (port !== 9222) return port;
  }
  throw new Error('挑不到端口（拒绝 9222）');
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
    pinUnfinishedTodos: true,
    secretaryEnabled: true,
  };
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({ 'enso-settings': { state, version: 18 } })
  );
}

function dispatchText(projectId) {
  const args = {
    projectId,
    prompt: '随便聊聊 [[slow:8000]]',
    worktree: false,
    title: '动画验证会话',
  };
  const json = JSON.stringify(args).replaceAll(']]', '\\u005d\\u005d');
  return `[[tool:session_create ${json}]] 请派一个会话`;
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
          window.__stores?.secretary?.getState &&
          window.electronAPI?.secretary?.saveProfile &&
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

async function applyViewport(cdp, viewport) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
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

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败: ${result.stderr || result.stdout}`);
  }
}

function startFake(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/fake-provider-issue-27.mjs')], {
    cwd: ROOT,
    detached: true,
    env: { ...process.env, FAKE_PROVIDER_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  children.push(child);
  return child;
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
      ENSO_ELECTRON_DEBUG_PORT: String(cdpPort),
      ENSO_RENDERER_PORT: String(rendererPort),
      ENSO_VERIFY: '1',
      ENSO_ELECTRON_OFFSCREEN: '1',
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

function setupExpr(projectPath) {
  return `(async () => {
    const S = () => window.__stores.sessions.getState();
    const SET = () => window.__stores.settings.getState();
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const until = async (fn, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const value = await fn();
        if (value) return value;
        await sleep(150);
      }
      return null;
    };
    const project = await SET().addProject(${JSON.stringify(projectPath)});
    const secretaryReady = await until(
      () => SET().projects.some((item) => item.kind === 'secretary'),
      30000
    );
    if (!project?.id || !secretaryReady) {
      return { ok: false, error: 'no project or secretary', projectId: project?.id ?? null };
    }
    const saved = await window.electronAPI.secretary.saveProfile({
      name: '秘书',
      avatar: { color: '#6366f1' },
      visibleProjectIds: 'all',
      maxRunningDispatches: 3,
      patrolEnabled: false,
      replyLanguage: 'ui',
      style: 'concise',
      notify: 'off',
      addressAs: null,
      dailyBriefAt: null,
    });
    if (!saved?.ok) return { ok: false, error: saved?.error || 'saveProfile failed' };
    const useSecretaryStore = (await import('/stores/secretary.ts')).useSecretaryStore;
    const secretaryConvId = await useSecretaryStore.getState().newSecretaryConversation();
    if (!secretaryConvId) return { ok: false, error: 'no secretary conversation' };
    S().selectConversation(secretaryConvId);
    const avatar = await until(() => {
      const el = document.querySelector('[data-enso="secretary-avatar"]');
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0 ? true : null;
    }, 15000);
    const secretaryProject = SET().projects.find((item) => item.kind === 'secretary');
    if (!secretaryProject?.path) {
      return { ok: false, error: 'no secretary project path', secretaryConvId };
    }
    return {
      ok: true,
      projectId: project.id,
      secretaryConvId,
      cwd: secretaryProject.path,
      avatar: Boolean(avatar),
    };
  })()`;
}

function armExpr(text, cwd, secretaryConvId) {
  return `(() => {
    const S = () => window.__stores.sessions.getState();
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const boxOf = (el) => {
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return {
        x: (box.left + box.right) / 2,
        y: (box.top + box.bottom) / 2,
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
      };
    };
    S().selectConversation(${JSON.stringify(secretaryConvId)});
    window.__flightLog = [];
    window.__flightDone = false;
    window.__sendResult = 'pending';
    const pending = S().send(
      ${JSON.stringify(text)},
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: ${JSON.stringify(cwd)} },
      undefined,
      ${JSON.stringify(secretaryConvId)}
    );
    void (async () => {
      try {
        const end = Date.now() + ${SAMPLE_MS};
        while (Date.now() < end) {
          const rows = [...document.querySelectorAll('[data-enso="sidebar"] [data-slot="active-section"] [data-conversation]')];
          const row = rows.find((el) => el.querySelector('[data-enso="secretary-origin"]')) ?? rows[0] ?? null;
          window.__flightLog.push({
            t: Date.now(),
            flight: boxOf(document.querySelector('[data-enso="secretary-flight"]')),
            avatar: boxOf(document.querySelector('[data-enso="secretary-avatar"]')),
            card: boxOf(document.querySelector('[data-enso="tool-card"][data-tool="session_create"]')),
            row: boxOf(row),
            badge: boxOf(row ? row.querySelector('[data-enso="secretary-origin"]') : null),
          });
          await sleep(60);
        }
      } finally {
        window.__flightDone = true;
      }
    })();
    void Promise.resolve(pending).then(
      (value) => { window.__sendResult = value ?? null; },
      (error) => { window.__sendResult = error instanceof Error ? error.message : String(error); }
    );
    return true;
  })()`;
}

function clearFrames() {
  let names = [];
  try {
    names = readdirSync('/tmp');
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^dispatch-flight-(frame-\d+|showcase-\w+)\.png$/.test(name)) continue;
    try {
      unlinkSync(path.join('/tmp', name));
    } catch {
      // 旧帧已经没了
    }
  }
}

// 派发本身要数秒，动画播约 3 秒：从 arm 起持续录，flight 消失后停，
// 最后只保留 flight 出现前后各 2 帧的窗口，其余删掉，避免一堆静止帧。
async function recordFrames(cdp) {
  const frames = [];
  const started = Date.now();
  let sawFlightAt = null;
  let goneAt = null;
  for (let index = 0; Date.now() - started < 18_000 && index < 160; index += 1) {
    const tick = Date.now();
    const file = `/tmp/dispatch-flight-frame-${String(index).padStart(2, '0')}.png`;
    try {
      const [{ data }, seen] = await Promise.all([
        cdp.send(
          'Page.captureScreenshot',
          {
            format: 'png',
            captureBeyondViewport: false,
            clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height, scale: 1 },
          },
          2_000
        ),
        cdp.eval(`Boolean(document.querySelector('[data-enso="secretary-flight"]'))`),
      ]);
      writeFileSync(file, Buffer.from(data, 'base64'));
      frames.push({ file, t: tick, flight: Boolean(seen) });
      if (seen && sawFlightAt === null) sawFlightAt = tick;
      if (sawFlightAt !== null && !seen && goneAt === null) goneAt = tick;
      if (goneAt !== null && tick - goneAt > 500) break;
    } catch (error) {
      log(`截图失败 ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const rest = FRAME_MS - (Date.now() - tick);
    if (rest > 0) await sleep(rest);
  }
  const firstFlight = frames.findIndex((frame) => frame.flight);
  const lastFlight = frames.map((frame) => frame.flight).lastIndexOf(true);
  const keepFrom = firstFlight === -1 ? 0 : Math.max(0, firstFlight - 2);
  const keepTo =
    lastFlight === -1 ? frames.length - 1 : Math.min(frames.length - 1, lastFlight + 3);
  const kept = [];
  frames.forEach((frame, index) => {
    if (index >= keepFrom && index <= keepTo) {
      kept.push(frame.file);
      return;
    }
    try {
      unlinkSync(frame.file);
    } catch {
      // 已删
    }
  });
  if (firstFlight !== -1) {
    log(
      `flight 出现帧 index=${firstFlight} 消失帧 index=${lastFlight} 保留 ${kept.length}/${frames.length}`
    );
  } else {
    log('截图里从未出现 flight 元素');
  }
  const byFile = new Map(frames.map((frame) => [frame.file, frame.t]));
  return kept.map((file) => ({ file, t: byFile.get(file) ?? 0 }));
}

function hypot(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function inside(point, rect) {
  return (
    rect.right - rect.left > 1 &&
    rect.bottom - rect.top > 1 &&
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

// 连续静止窗口：相邻样本帧间位移都不超过 holdRadius 的最长区间（模拟肉眼「停住了」）。
// 返回 { start, end, first, last }，外加每帧位移明细便于排查。
function stillnessWindow(flights, holdRadius) {
  let best = null;
  let start = 0;
  for (let index = 1; index < flights.length; index += 1) {
    const step = hypot(flights[index].flight, flights[index - 1].flight);
    if (step <= holdRadius) continue;
    best = pickLonger(best, flights, start, index - 1);
    start = index;
  }
  best = pickLonger(best, flights, start, flights.length - 1);
  return best;
}

function pickLonger(best, flights, from, to) {
  if (to - from < 1) return best;
  const span = flights[to].t - flights[from].t;
  if (best && span <= best.end - best.start) return best;
  return { start: flights[from].t, end: flights[to].t, first: from, last: to };
}

// 在 target 附近（nearRadius 内）的连续静止窗口。
function dwellNear(flights, targetFor, nearRadius, holdRadius) {
  const near = flights.filter((sample) => {
    const target = targetFor(sample);
    return target && hypot(sample.flight, target) <= nearRadius;
  });
  return stillnessWindow(near, holdRadius);
}

// 亮相帧：取悬停窗口中点前后最近的一张截图，另存命名清晰的副本。
function pickShowcaseFrames(kept, cardHold, rowHold) {
  const showcase = [];
  const pick = (hold, name) => {
    if (!hold || kept.length === 0) return null;
    const mid = (hold.start + hold.end) / 2;
    let bestFrame = null;
    for (const frame of kept) {
      if (!bestFrame || Math.abs(frame.t - mid) < Math.abs(bestFrame.t - mid)) bestFrame = frame;
    }
    if (!bestFrame) return null;
    const target = `/tmp/dispatch-flight-showcase-${name}.png`;
    try {
      writeFileSync(target, readFileSync(bestFrame.file));
      showcase.push({ file: target, at: mid, source: bestFrame.file });
      return target;
    } catch {
      return null;
    }
  };
  pick(cardHold, 'card-land');
  pick(rowHold, 'row-land');
  return showcase;
}

function judge(log, gone, sendResult) {
  const samples = Array.isArray(log) ? log : [];
  const flights = [];
  samples.forEach((sample, index) => {
    if (sample?.flight) flights.push({ index, ...sample });
  });
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  const first = flights[0];
  const firstDist = first?.avatar ? hypot(first.flight, first.avatar) : null;
  const card = flights.find(
    (sample, index) => index > 0 && sample.card && hypot(sample.flight, sample.card) < 60
  );
  const row = flights.find(
    (sample) => card && sample.index > card.index && sample.row && inside(sample.flight, sample.row)
  );
  const after = row ? flights.filter((sample) => sample.index >= row.index) : [];
  const tail = after.slice(-3);
  const monotonic =
    tail.length > 0 &&
    tail.every((sample, index) => index === 0 || sample.flight.x + 1 >= tail[index - 1].flight.x);
  const last = flights.at(-1);
  const moved = Boolean(row && last && last.flight.x > row.flight.x);
  const badgeDist = last?.badge ? Math.abs(last.flight.x - last.badge.x) : null;
  const faded =
    Boolean(gone) ||
    (last ? samples.slice(last.index + 1).some((sample) => !sample.flight) : false);
  const nearBadge = badgeDist !== null && badgeDist < 30;
  const cardHold = dwellNear(flights, (sample) => sample.card, 25, 8);
  const afterCard = cardHold ? flights.filter((sample) => sample.t >= cardHold.end) : [];
  const rowEdge = (sample) =>
    sample.row ? { x: sample.row.left + 2, y: (sample.row.top + sample.row.bottom) / 2 } : null;
  const rowHold = dwellNear(afterCard.length ? afterCard : flights, rowEdge, 24, 8);

  add('send 已接受', sendResult === null, `result=${JSON.stringify(sendResult)}`);
  add('flight 至少 3 帧', flights.length >= 3, `frames=${flights.length}`);
  add(
    '首帧距头像 < 40',
    firstDist !== null && firstDist < 40,
    firstDist === null ? '无首帧或头像' : `dist=${firstDist.toFixed(1)}`
  );
  add(
    '卡片帧在首帧之后且距卡片 < 60',
    Boolean(card),
    card ? `index=${card.index} dist=${hypot(card.flight, card.card).toFixed(1)}` : '没有'
  );
  add(
    '行进帧在卡片帧之后',
    Boolean(row),
    row ? `index=${row.index} x=${row.flight.x.toFixed(1)}` : '没有'
  );
  add(
    '末帧向 badge 移动且贴近或淡出',
    moved && monotonic && (nearBadge || faded),
    `moved=${moved} monotonic=${monotonic} badgeDx=${badgeDist === null ? 'null' : badgeDist.toFixed(1)} faded=${faded} tail=${tail.map((sample) => sample.flight.x.toFixed(0)).join(',')}`
  );
  add(
    '落卡后位置静止 ≥ 200ms（亮相真实存在）',
    cardHold && cardHold.end - cardHold.start >= 200,
    cardHold
      ? `hold=${(cardHold.end - cardHold.start).toFixed(0)}ms samples=${cardHold.last - cardHold.first + 1}`
      : '没有静止窗口'
  );
  add(
    '落到行后位置静止 ≥ 150ms 再滑向徽标',
    rowHold && rowHold.end - rowHold.start >= 150,
    rowHold
      ? `hold=${(rowHold.end - rowHold.start).toFixed(0)}ms samples=${rowHold.last - rowHold.first + 1}`
      : '没有静止窗口'
  );
  add('flight 最终离开 DOM', gone === true, gone ? 'gone' : '仍在');
  return { checks, cardHold, rowHold };
}

function summarize(log) {
  const samples = Array.isArray(log) ? log : [];
  const frames = samples.filter((sample) => sample?.flight);
  const rows = frames.map((sample, index) => {
    const previous = frames[index - 1];
    const step = previous ? hypot(sample.flight, previous.flight) : 0;
    const cardD = sample.card ? hypot(sample.flight, sample.card) : null;
    const edge = sample.row
      ? { x: sample.row.left + 2, y: (sample.row.top + sample.row.bottom) / 2 }
      : null;
    const rowD = edge ? hypot(sample.flight, edge) : null;
    return `  f${index} dt=${sample.t - frames[0].t} xy=${sample.flight.x.toFixed(1)},${sample.flight.y.toFixed(1)} step=${step.toFixed(1)} cardD=${cardD === null ? '-' : cardD.toFixed(1)} rowD=${rowD === null ? '-' : rowD.toFixed(1)}`;
  });
  return `samples=${samples.length} flight=${frames.length} card=${samples.some((sample) => sample?.card)} row=${samples.some((sample) => sample?.row)} badge=${samples.some((sample) => sample?.badge)} avatar=${samples.some((sample) => sample?.avatar)}\n${rows.join('\n')}`;
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

async function main() {
  if (!existsSync(path.join(ROOT, 'package.json'))) throw new Error(`找不到仓库 ${ROOT}`);
  if (!existsSync(path.join(ROOT, 'node_modules/.bin/electron-vite'))) {
    throw new Error(`缺少 ${path.join(ROOT, 'node_modules/.bin/electron-vite')}`);
  }
  artDir = mkdtempSync('/tmp/enso-dispatch-flight-');
  const userData = path.join(artDir, 'user-data');
  const projectPath = path.join(artDir, 'project');
  mkdirSync(projectPath, { recursive: true });
  git(projectPath, ['init', '-q']);
  git(projectPath, [
    '-c',
    'user.email=a@b.c',
    '-c',
    'user.name=verify',
    'commit',
    '--allow-empty',
    '-qm',
    'init',
  ]);

  const fakePort = await reservePort();
  const cdpPort = await reservePort();
  const rendererPort = await reservePort();
  writeFakeSettings(userData, `http://127.0.0.1:${fakePort}`);
  log(`root ${ROOT}`);
  log(`userData ${userData}`);
  log(`project ${projectPath}`);
  log(`ports fake=${fakePort} cdp=${cdpPort} renderer=${rendererPort}`);
  startFake(fakePort);
  startDev(userData, cdpPort, rendererPort);

  await Promise.all([
    waitFor(
      async () => {
        try {
          return (await fetch(`http://127.0.0.1:${fakePort}/__requests`)).ok ? true : null;
        } catch {
          return null;
        }
      },
      { timeout: 15_000, interval: 200, label: 'fake provider' }
    ),
    waitFor(
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
    ),
  ]);

  const cdp = await waitForStablePage(cdpPort);
  const files = [];
  try {
    await applyViewport(cdp, VIEWPORT);
    const setup = await cdp.eval(setupExpr(projectPath));
    if (!setup?.ok) throw new Error(`准备秘书会话失败: ${setup?.error ?? 'unknown'}`);
    log(`秘书会话 ${setup.secretaryConvId} project=${setup.projectId}`);
    if (!setup.avatar) log('秘书头像还没出现，仍继续派发');
    const text = dispatchText(setup.projectId);
    log(`指令 ${text}`);
    clearFrames();
    const armed = await cdp.eval(armExpr(text, setup.cwd, setup.secretaryConvId));
    if (armed !== true) throw new Error('采样没有启动');
    const recorded = recordFrames(cdp);
    let sampleError = null;
    try {
      await waitFor(async () => ((await cdp.eval('window.__flightDone === true')) ? true : null), {
        timeout: 12_000,
        interval: 100,
        label: 'flight 采样',
      });
    } catch (error) {
      if (isFatalIsolation(error)) throw error;
      sampleError = error;
    }
    files.push(...(await recorded));
    let flightLog = [];
    try {
      flightLog = (await cdp.eval('window.__flightLog ?? []')) ?? [];
    } catch (error) {
      if (isFatalIsolation(error)) throw error;
      sampleError = sampleError ?? error;
    }
    let sendResult = 'pending';
    try {
      const wrapped = await waitFor(
        async () => {
          const value = await cdp.eval('window.__sendResult');
          return value === 'pending' ? null : { value };
        },
        { timeout: 15_000, interval: 200, label: 'send 回执' }
      );
      sendResult = wrapped.value;
    } catch (error) {
      if (isFatalIsolation(error)) throw error;
    }
    let gone = false;
    try {
      gone = Boolean(
        await waitFor(
          async () =>
            (await cdp.eval(`document.querySelector('[data-enso="secretary-flight"]') == null`))
              ? true
              : null,
          { timeout: 2_000, interval: 100, label: 'flight 消失' }
        )
      );
    } catch (error) {
      if (isFatalIsolation(error)) throw error;
      gone = false;
    }
    if (sampleError)
      log(
        `采样未完成: ${sampleError instanceof Error ? sampleError.message : String(sampleError)}`
      );
    log(`flightLog ${summarize(flightLog)}`);
    const { checks, cardHold, rowHold } = judge(flightLog, gone === true, sendResult);
    for (const check of checks) log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
    const showcase = pickShowcaseFrames(files, cardHold, rowHold);
    log(`截图 ${files.length} 帧`);
    for (const frame of files) log(frame.file);
    for (const shot of showcase) log(`亮相帧 ${shot.file} (源 ${shot.source})`);
    if (checks.some((check) => !check.ok)) throw new Error('dispatch flight 断言失败');
    log('PASS');
  } finally {
    cdp.close();
  }
}

process.on('SIGINT', () => void finish(130));
process.on('SIGTERM', () => void finish(143));
process.on('uncaughtException', (error) => {
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
