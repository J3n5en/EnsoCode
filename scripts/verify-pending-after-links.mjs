#!/usr/bin/env node
// 看板「等依赖」卡片的依赖说明：显示依赖会话标题、可点击、缺失会话降级短 id——真机验收。
// 隔离 userData + fake provider，不碰真实数据，也不连 9222。
//   node scripts/verify-pending-after-links.mjs [--keep]
// 截图：/tmp/pending-after-links.png。整体 3 分钟硬超时（含 dev 冷启动）。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { uiElementElectron } from './verify-electron.mjs';
import {
  keepRequested,
  mergeOwnedPids,
  ownedProcessGroups,
  reservePorts,
} from './verify-secretary-isolation.mjs';

const startedAt = Date.now();
const REPO = path.resolve(import.meta.dirname, '..');
const KEEP = keepRequested(process.env, process.argv);
const SHOT_FILE = '/tmp/pending-after-links.png';

const ART = process.env.SEC_VERIFY_DIR?.trim() || mkdtempSync('/tmp/pending-after-');
const ENV = `${ART}-env`;
const settingsFile = path.join(ENV, 'settings.json');
const registryFile = path.join(ENV, 'agent', 'source-registry.json');

let CDP_PORT = 0;
let FAKE_PORT = 0;
let RENDERER_PORT = 0;
let portLease = null;
const children = [];
const trackedPids = [];
const failures = [];

const log = (message) =>
  console.log(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

setTimeout(() => {
  console.error(`\nFAIL pending-after-links: 3 分钟硬超时 (${Date.now() - startedAt}ms)`);
  try {
    signalOwned('SIGKILL');
  } catch {
    // 进程表读不到就直接退出
  }
  if (!KEEP) removeIsolate();
  process.exit(2);
}, 180_000).unref();

function removeIsolate() {
  for (const dir of [ENV, `${ENV}-proj`, ART]) {
    if (dir.startsWith('/tmp/')) rmSync(dir, { recursive: true, force: true });
  }
}

function check(ok, label, detail) {
  if (ok) {
    log(`  PASS ${label}`);
    return;
  }
  failures.push({ label, detail });
  log(`  FAIL ${label} ${JSON.stringify(detail)}`);
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

function signalOwned(signal) {
  const processes = listProcesses();
  const roots = children.flatMap(({ child }) => (Number.isInteger(child.pid) ? [child.pid] : []));
  const owned = mergeOwnedPids(trackedPids, processes, roots);
  trackedPids.length = 0;
  trackedPids.push(...owned);
  const selfGroup = processes.find((proc) => proc.pid === process.pid)?.pgid;
  for (const pgid of ownedProcessGroups(processes, owned)) {
    if (pgid === selfGroup) continue;
    try {
      process.kill(-pgid, signal);
    } catch {
      // 这一组已经没人
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

function listenLoopback(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function waitFor(probe, label, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
}

function start(name, command, args, env) {
  const child = spawn(command, args, {
    cwd: REPO,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  const collect = (buf) => {
    chunks.push(buf.toString('utf8'));
    if (chunks.length > 400) chunks.shift();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  children.push({ name, child, chunks });
  return child;
}

async function stopAll() {
  await portLease?.release();
  portLease = null;
  signalOwned('SIGTERM');
  await sleep(800);
  signalOwned('SIGKILL');
  await sleep(200);
}

let cleaning = null;
function cleanup() {
  if (!cleaning) {
    cleaning = (async () => {
      await stopAll();
      if (KEEP) {
        log(`  kept ${ART}`);
        return;
      }
      removeIsolate();
      log(`  removed ${ART}`);
    })();
  }
  return cleaning;
}

let finishing = null;
function finish(code) {
  if (!finishing) {
    finishing = (async () => {
      try {
        await cleanup();
      } catch (error) {
        console.error(error);
        code = 1;
      }
      process.exit(code);
    })();
  }
  return finishing;
}

const PRELUDE = `
const S = () => window.__stores.sessions.getState();
const SET = () => window.__stores.settings.getState();
const SEC = async () => (await import('/stores/secretary.ts')).useSecretaryStore;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(150); }
  return null;
};
`;

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const target = list.find((page) => page.type === 'page' && page.url.includes('index.html'));
  if (!target) throw new Error('index.html page target not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const resolve = pending.get(message.id);
    if (!resolve) return;
    pending.delete(message.id);
    resolve(message);
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const closedReply = () => ({ error: { message: 'CDP socket closed' } });
  socket.onclose = () => {
    for (const resolve of pending.values()) resolve(closedReply());
    pending.clear();
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      if (socket.readyState !== WebSocket.OPEN) return resolve(closedReply());
      const next = ++id;
      pending.set(next, resolve);
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (reply.error) throw new Error(`cdp ${reply.error.message}`);
    if (reply.result?.exceptionDetails) {
      const details = reply.result.exceptionDetails;
      throw new Error(
        `eval failed: ${details.exception?.description ?? JSON.stringify(details).slice(0, 800)}`
      );
    }
    return reply.result?.result?.value;
  };
  return {
    send,
    evaluate,
    async json(body) {
      const raw = await evaluate(`(async () => { ${PRELUDE} ${body} })()`);
      return raw === undefined ? undefined : JSON.parse(raw);
    },
    async shot(file) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      if (!shot.result?.data) throw new Error(`empty screenshot ${file}`);
      writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
      log(`  shot ${file}`);
    },
    close: () => socket.close(),
  };
}

async function prepareEnv() {
  rmSync(ENV, { recursive: true, force: true });
  rmSync(`${ENV}-proj`, { recursive: true, force: true });
  mkdirSync(ART, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['.agents/skills/enso-cdp/scripts/mk-env.mjs', ENV, '1'],
      { cwd: REPO, stdio: 'inherit' }
    );
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`mk-env exited ${code}`))
    );
  });
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  settings['enso-settings'].state.secretaryEnabled = true;
  settings['enso-settings'].state.language = 'zh-CN';
  for (const provider of settings['enso-settings'].state.providers ?? []) {
    provider.baseUrl = `http://127.0.0.1:${FAKE_PORT}`;
  }
  writeFileSync(settingsFile, JSON.stringify(settings));
  // mk-env 的项目目录不是 git 仓库：派发会话要跑在 git 项目里
  const proj = `${ENV}-proj`;
  const git = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: proj, stdio: 'ignore' });
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} ${code}`))
      );
    });
  await git(['init', '-q']);
  await git(['add', '-A']);
  await git(['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  log(`  env ${ENV} proj ${proj}`);
}

async function startDev() {
  start('dev', 'pnpm', ['dev'], {
    ENSO_USER_DATA_DIR: ENV,
    ENSO_CDP_PORT: String(CDP_PORT),
    ENSO_RENDERER_PORT: String(RENDERER_PORT),
    ENSO_VERIFY: '1',
    ELECTRON_EXEC_PATH: uiElementElectron(createRequire(import.meta.url)('electron')),
  });
  await waitFor(
    async () => {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        return list.some((entry) => entry.type === 'page' && entry.url.includes('index.html'));
      } catch {
        return false;
      }
    },
    'dev CDP page',
    120_000,
    400
  );
  await waitFor(
    () => existsSync(path.join(ENV, 'DevToolsActivePort')) && existsSync(registryFile),
    'isolated userData markers',
    20_000,
    200
  );
  if (CDP_PORT === 9222) throw new Error('拒绝使用 9222');
}

async function waitForStableRenderer() {
  let page = null;
  let targetId = null;
  let streak = 0;
  try {
    return await waitFor(
      async () => {
        try {
          const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
          const target = list.find(
            (entry) => entry.type === 'page' && entry.url.includes('index.html')
          );
          if (!target) {
            streak = 0;
            return false;
          }
          if (!page || target.id !== targetId) {
            page?.close();
            page = await connect();
            targetId = target.id;
            streak = 0;
          }
          const ready = await page.evaluate(`(() => Boolean(
            window.__stores?.settings?.getState &&
            window.__stores?.sessions?.getState &&
            window.electronAPI?.secretary?.create &&
            document.readyState === 'complete' &&
            document.getElementById('root')
          ))()`);
          streak = ready === true ? streak + 1 : 0;
          return streak >= 2 ? page : false;
        } catch {
          streak = 0;
          page?.close();
          page = null;
          targetId = null;
          return false;
        }
      },
      'renderer ready',
      45_000,
      250
    );
  } catch (error) {
    page?.close();
    throw error;
  }
}

async function main() {
  portLease = await reservePorts({ cdp: null, fake: null, renderer: null }, listenLoopback);
  CDP_PORT = portLease.ports.cdp;
  FAKE_PORT = portLease.ports.fake;
  RENDERER_PORT = portLease.ports.renderer;
  log(`  ports cdp=${CDP_PORT} fake=${FAKE_PORT} renderer=${RENDERER_PORT}`);
  await portLease.release('fake');
  start('fake-provider', process.execPath, ['scripts/fake-provider-issue-27.mjs'], {
    FAKE_PROVIDER_PORT: String(FAKE_PORT),
  });
  await waitFor(
    async () => {
      try {
        return (await fetch(`http://127.0.0.1:${FAKE_PORT}/__requests`)).ok;
      } catch {
        return false;
      }
    },
    'fake provider',
    15_000
  );
  await prepareEnv();
  await portLease.release('cdp');
  await portLease.release('renderer');
  await startDev();
  log('  isolated instance up');

  const cdp = await waitForStableRenderer();
  try {
    await run(cdp);
  } finally {
    cdp.close();
  }
}

async function run(cdp) {
  log('== setup: 项目 + 秘书档案 + 秘书会话');
  const setup = await cdp.json(`
    const proj = ${JSON.stringify(`${ENV}-proj`)};
    await until(() => SET().projects.some((p) => p.kind === 'secretary'), 30000);
    const project = await SET().addProject(proj);
    const saved = await window.electronAPI.secretary.saveProfile({
      name: '秘书',
      avatar: { color: '#6366f1' },
      visibleProjectIds: 'all',
      maxRunningDispatches: 3,
      patrolEnabled: true,
      replyLanguage: 'ui',
      style: 'concise',
      notify: 'off',
      addressAs: null,
      dailyBriefAt: null,
    });
    if (!saved.ok) return JSON.stringify({ ok: false, error: saved.error });
    const secretary = await SEC();
    const secretaryId = await secretary.getState().newSecretaryConversation();
    return JSON.stringify({
      ok: Boolean(secretaryId),
      projectId: project.id,
      secretaryId,
      secretaryProjectId: secretary.getState().secretary.projectId,
    });
  `);
  check(setup?.ok, 'setup: 隔离实例里建出项目与秘书会话', setup);
  if (!setup?.ok) throw new Error('setup failed');

  log('== 派第一个活（依赖对象）');
  const firstTitle = '写 hello.txt';
  const first = await cdp.json(`
    const draft = { projectId: ${JSON.stringify(setup.projectId)}, prompt: '在项目根目录创建 hello.txt，内容写 hi', title: ${JSON.stringify(firstTitle)} };
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    const secretary = await SEC();
    const fresh = await secretary.getState().newSecretaryConversation();
    await S().send(
      '派个活 [[tool:session_create ' + JSON.stringify(draft) + ']]',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      fresh
    );
    const card = await until(() => {
      const board = secretary.getState().secretary.board;
      return [...board.needsYou, ...board.running, ...board.done].find(
        (c) => c.kind === 'session' && c.title === ${JSON.stringify(firstTitle)}
      ) ?? null;
    }, 30000);
    return JSON.stringify({ ok: Boolean(card), conversationId: card?.conversationId ?? null });
  `);
  check(first?.ok, '第一个派发会话建出来了', first);
  if (!first?.conversationId) throw new Error('first dispatch failed');

  log('== 派第二个活，after 依赖第一个');
  const secondTitle = '写 world.txt';
  const second = await cdp.json(`
    const draft = {
      projectId: ${JSON.stringify(setup.projectId)},
      prompt: '在项目根目录创建 world.txt，内容写 world',
      title: ${JSON.stringify(secondTitle)},
      after: [${JSON.stringify(first.conversationId)}],
    };
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    const secretary = await SEC();
    const fresh2 = await secretary.getState().newSecretaryConversation();
    await S().send(
      '再派一个等依赖的活 [[tool:session_create ' + JSON.stringify(draft) + ']]',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      fresh2
    );
    const pending = await until(() => {
      const board = secretary.getState().secretary.board;
      return board.running.find((c) => c.kind === 'pending') ?? null;
    }, 30000);
    return JSON.stringify({
      ok: Boolean(pending),
      after: pending?.pending?.after ?? null,
      title: pending?.pending?.draft?.title ?? null,
    });
  `);
  check(second?.ok, '带 after 的派发停在等依赖', second);
  check(second?.after?.[0] === first.conversationId, '等依赖记录里 after 指向第一个会话', second);

  log('== 打开秘书面板，看等依赖卡片');
  const panel = await cdp.json(`
    S().selectConversation(${JSON.stringify(setup.secretaryId)});
    await sleep(500);
    const toggles = [...document.querySelectorAll('button')].filter(
      (b) => b.getAttribute('aria-label') === '新建标签页' && b.offsetParent !== null
    );
    toggles.at(-1)?.click();
    const item = await until(() => document.querySelector('[data-enso=secretary-panel-open]'), 5000);
    if (!item) return JSON.stringify({ ok: false, error: 'no panel-open menu item' });
    item.click();
    await sleep(800);
    [...document.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === '折叠/展开右侧面板')
      ?.click();
    await sleep(1200);
    const pendingRow = await until(
      () => document.querySelector('[data-enso=secretary-running-pending]'),
      8000
    );
    if (!pendingRow) return JSON.stringify({ ok: false, error: 'no pending row' });
    const links = [...pendingRow.querySelectorAll('[data-enso=secretary-dependency-link]')].map(
      (node) => ({
        text: node.textContent,
        conversation: node.dataset.conversation,
        tag: node.tagName,
        underline: getComputedStyle(node).textDecorationLine,
      })
    );
    return JSON.stringify({
      ok: true,
      rowText: pendingRow.innerText,
      links,
      depTitle: S().conversations[${JSON.stringify(first.conversationId)}]?.title ?? null,
    });
  `);
  check(panel?.ok, '秘书面板里出现等依赖卡片', panel);
  const link = panel?.links?.[0];
  check(Boolean(link), '依赖说明里有可点链接', panel?.links);
  check(
    link && link.text !== first.conversationId && !link.text.includes(first.conversationId),
    '依赖显示的不是裸会话 id',
    link
  );
  check(
    link && panel.depTitle && link.text === panel.depTitle.slice(0, Math.max(1, link.text.length)),
    '依赖显示的是会话标题',
    { linkText: link?.text, depTitle: panel?.depTitle }
  );
  check(link?.tag === 'BUTTON', '依赖是可点击的按钮', link);
  if (failures.length === 0) {
    await cdp.shot(SHOT_FILE);
  }

  log('== 点开依赖链接：就地打开会话弹窗');
  const peek = await cdp.json(`
    document.querySelector('[data-enso=secretary-running-pending] [data-enso=secretary-dependency-link]')?.click();
    await sleep(800);
    const dialog = await until(() => document.querySelector('[data-enso=session-peek-dialog], [role=dialog]'), 5000);
    return JSON.stringify({
      ok: Boolean(dialog),
      text: dialog?.textContent?.slice(0, 120) ?? null,
    });
  `);
  check(peek?.ok, '点击依赖标题打开会话弹窗', peek);

  if (failures.length > 0) {
    log(`FAIL pending-after-links: ${failures.length} 项未过`);
    return finish(1);
  }
  log('PASS pending-after-links');
  return finish(0);
}

process.on('SIGINT', () => finish(1));
process.on('SIGTERM', () => finish(1));
process.on('uncaughtException', (error) => {
  console.error(error);
  finish(1);
});

main().catch((error) => {
  console.error(error);
  finish(1);
});
