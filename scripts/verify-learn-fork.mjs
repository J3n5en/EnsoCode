#!/usr/bin/env node
// 复盘 fork 真机验收：Auto（虚拟模型）会话聊两轮 → 点复盘 → 旁路必须注入上文，不提示「分叉失败」。
// 全程隔离 userData + fake provider，不碰真实账号。
//   node scripts/verify-learn-fork.mjs [--keep]
//
// 根因背景：虚拟模型会话的 session.model 是虚拟模型，而 forkBase 记录的是路由后的物理模型，
// 旧代码直接比较两者导致「换过模型」误判恒真、fork 注入永远静默失败。
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

const REPO = path.resolve(import.meta.dirname, '..');
const KEEP = keepRequested(process.env, process.argv);
const ART = mkdtempSync('/tmp/learn-fork-verify-');
const ENV = `${ART}-env`;
const PROJ = `${ART}-proj`;
const settingsFile = path.join(ENV, 'settings.json');
const registryFile = path.join(ENV, 'agent', 'source-registry.json');

const children = [];
const results = [];
let portLease = null;

const log = (msg) => console.log(msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(ok, label, detail) {
  if (ok) {
    results.push({ label, ok: true });
    log(`  PASS ${label}`);
    return;
  }
  results.push({ label, ok: false, detail });
  throw new Error(`${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

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

const trackedPids = [];

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
    } catch {}
  }
  for (const pid of owned) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

async function stopAll() {
  await portLease?.release();
  portLease = null;
  signalOwned('SIGTERM');
  await sleep(1500);
  signalOwned('SIGKILL');
  await sleep(200);
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

async function waitFor(check, label, timeoutMs = 30_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
}

async function prepareEnv() {
  mkdirSync(ART, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['.agents/skills/enso-cdp/scripts/mk-env.mjs', ENV, '1'],
      {
        cwd: REPO,
        stdio: 'inherit',
      }
    );
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`mk-env ${code}`))));
  });
  const settings = readJson(settingsFile);
  const state = settings['enso-settings'].state;
  for (const provider of state.providers ?? []) {
    provider.baseUrl = `http://127.0.0.1:${FAKE_PORT}`;
  }
  // 虚拟模型 Auto：唯一成员是 fake 模型。这是复盘 fork 根因的关键配置——
  // Auto 会话的 session.model 是虚拟模型，forkBase 记录路由后的物理成员。
  state.virtualModels = [
    {
      id: 'auto',
      name: 'Auto',
      enabled: true,
      primary: { providerId: 'pv-A', modelId: 'fake-model-1' },
      fallbacks: [],
    },
  ];
  state.defaultModel = { providerId: 'enso-virtual', modelId: 'auto' };
  writeFileSync(settingsFile, JSON.stringify(settings));
  mkdirSync(PROJ, { recursive: true });
  writeFileSync(path.join(PROJ, 'README.md'), 'isolated learn-fork verify\n');
  const git = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: PROJ, stdio: 'ignore' });
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} ${code}`))
      );
    });
  await git(['init', '-q']);
  await git(['add', '-A']);
  await git(['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  log(`  ${ENV} + ${PROJ}`);
}

let CDP_PORT = 0;
let FAKE_PORT = 0;
let RENDERER_PORT = 0;

async function connect(entry = 'index.html') {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const target = list.find((page) => page.type === 'page' && page.url.includes(entry));
  if (!target) throw new Error(`${entry} page target not found`);
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
  const closedReply = () => ({ error: { message: `CDP socket closed (${entry})` } });
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
    evaluate,
    send,
    async json(body) {
      const raw = await evaluate(`(async () => { ${PRELUDE} ${body} })()`);
      return raw === undefined ? undefined : JSON.parse(raw);
    },
    close: () => socket.close(),
    targetId: target.id,
  };
}

const PRELUDE = `
const S = () => window.__stores.sessions.getState();
const SET = () => window.__stores.settings.getState();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); }
  return null;
};
const texts = (id) => (S().conversations[id]?.messages ?? []).map((m) =>
  (Array.isArray(m.content) ? m.content : []).filter((c) => c.type === 'text').map((c) => c.text).join(''));
`;

async function waitForStableRenderer() {
  let page = null;
  let targetId = null;
  let streak = 0;
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
          page = await connect('index.html');
          targetId = target.id;
          streak = 0;
        }
        const ready = await page.evaluate(`(() => Boolean(
          window.__stores?.settings?.getState &&
          window.__stores?.sessions?.getState &&
          window.electronAPI?.settings?.read &&
          document.readyState === 'complete' &&
          document.getElementById('root')
        ))()`);
        streak = ready === true ? streak + 1 : 0;
        return streak >= 3 ? page : false;
      } catch {
        streak = 0;
        page?.close();
        page = null;
        targetId = null;
        return false;
      }
    },
    'renderer ready',
    120_000,
    400
  );
}

async function main() {
  portLease = await reservePorts(
    { cdp: 0, fake: 0, plugin: 0, renderer: 0, telegram: 0 },
    listenLoopback
  );
  CDP_PORT = portLease.ports.cdp;
  FAKE_PORT = portLease.ports.fake;
  RENDERER_PORT = portLease.ports.renderer;
  log('== isolation');
  log(`  dir: ${ART}`);
  log(`  ports: cdp=${CDP_PORT} fake=${FAKE_PORT} renderer=${RENDERER_PORT}`);
  await prepareEnv();

  log('== fake provider + dev');
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
  await portLease.release('cdp');
  await portLease.release('renderer');
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
    500
  );
  await waitFor(
    () => existsSync(path.join(ENV, 'DevToolsActivePort')) && existsSync(registryFile),
    'isolated userData markers',
    30_000
  );
  log('  isolated instance up');

  const cdp = await waitForStableRenderer();
  try {
    await run(cdp);
  } finally {
    cdp.close();
  }
}

async function run(cdp) {
  const page = cdp.json.bind(cdp);

  log('== setup：新建 Auto 会话并聊两轮');
  const setup = await page(`
    const ready = await until(
      () => Boolean(window.__stores?.settings?.getState && window.__stores?.sessions?.getState && window.electronAPI?.settings),
      30000
    );
    if (!ready) return JSON.stringify({ ok: false, error: 'renderer stores not ready' });
    const project = await SET().addProject(${JSON.stringify(PROJ)});
    if (!project) return JSON.stringify({ ok: false, error: 'addProject failed' });
    const convoId = await S().newConversation(project.id ?? project);
    if (!convoId) return JSON.stringify({ ok: false, error: 'newConversation failed' });
    // 用 Auto（虚拟模型）发第一条消息
    await S().send('你好，第一轮', { providerId: 'enso-virtual', modelId: 'auto', cwd: ${JSON.stringify(PROJ)} }, undefined, convoId);
    const first = await until(() => {
      const ts = texts(convoId);
      return ts.length >= 2 && ts.some((t) => t.length > 0) ? ts : null;
    }, 30000);
    if (!first) return JSON.stringify({ ok: false, error: 'no first reply', convoId });
    // 第二轮，让 forkBase 覆盖到最新请求
    await S().send('第二轮：请纠正我刚才说的内容', { providerId: 'enso-virtual', modelId: 'auto', cwd: ${JSON.stringify(PROJ)} }, undefined, convoId);
    const second = await until(() => {
      const ts = texts(convoId);
      return ts.length >= 4 ? ts : null;
    }, 30000);
    if (!second) return JSON.stringify({ ok: false, error: 'no second reply', convoId });
    return JSON.stringify({ ok: true, convoId, projectId: project.id ?? project });
  `);
  assert(setup?.ok === true, 'Auto 会话两轮对话完成', setup);
  const convoId = setup.convoId;

  log('== 触发复盘旁路');
  const learn = await page(`
    const mod = await import('/lib/sidePanelDock.ts');
    mod.addSidePanelLearn(${JSON.stringify(convoId)}, { title: 'Learn' });
    // 等旁路会话出现并完成 spawn + 首条复盘指令
    const btwId = await until(() => {
      const ids = Object.keys(S().conversations).filter((id) => S().conversations[id]?.btwParentId === ${JSON.stringify(convoId)});
      return ids[0] ?? null;
    }, 15000);
    if (!btwId) return JSON.stringify({ ok: false, error: 'btw conversation not created' });
    // 等旁路跑出回复（首条复盘指令已发出）
    const replied = await until(() => {
      const convo = S().conversations[btwId];
      return convo && convo.messages.some((m) => m.role === 'assistant') ? true : null;
    }, 40000);
    const convo = S().conversations[btwId];
    const allText = (convo?.messages ?? []).map((m) =>
      (Array.isArray(m.content) ? m.content : []).filter((c) => c.type === 'text').map((c) => c.text).join('')
    ).join('\\n');
    return JSON.stringify({
      ok: Boolean(replied),
      btwId,
      messageCount: convo?.messages?.length ?? 0,
      hasForkFailure: /分叉失败|无法复盘/.test(allText),
      userMessageCount: (convo?.messages ?? []).filter((m) => m.role === 'user').length,
      firstUserText: (convo?.messages ?? []).find((m) => m.role === 'user')?.content?.filter?.((c) => c.type === 'text').map((c) => c.text).join('').slice(0, 120) ?? '',
      allTextHead: allText.slice(0, 400),
    });
  `);
  assert(learn?.ok === true, '旁路复盘跑出了回复', learn);
  assert(learn.hasForkFailure === false, '旁路没有提示「分叉失败」', {
    firstUserText: learn.firstUserText,
    allTextHead: learn.allTextHead,
  });
  // fork 注入成功的铁证：旁路在首条复盘指令之前就有注入的消息序列（user 消息 > 1，
  // 或者首条 user 消息不是复盘指令本身开头）
  assert(
    learn.userMessageCount > 1 || !learn.firstUserText.startsWith('以上这段对话'),
    '旁路注入了上文消息序列（fork 命中）',
    {
      userMessageCount: learn.userMessageCount,
      firstUserText: learn.firstUserText,
      messageCount: learn.messageCount,
    }
  );

  log('== fake provider 请求证据：旁路请求是 fork 前缀续写');
  const requests = await (await fetch(`http://127.0.0.1:${FAKE_PORT}/__requests`)).json();
  const reqs = requests.requests ?? [];
  log(`  fake provider 共收到 ${reqs.length} 次请求`);
  assert(reqs.length >= 3, 'fake provider 至少收到主会话两轮换 + 旁路一次的请求', {
    count: reqs.length,
  });

  log('\\n== all passed ==');
  for (const r of results) log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.label}`);
}

main()
  .then(async () => {
    await stopAll();
    if (!KEEP) {
      rmSync(ENV, { recursive: true, force: true });
      rmSync(`${ENV}-proj`, { recursive: true, force: true });
      rmSync(PROJ, { recursive: true, force: true });
      rmSync(ART, { recursive: true, force: true });
    } else {
      log(`  kept: ${ART}`);
    }
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(`\\nFAIL: ${error.message}`);
    for (const { name, chunks } of children) {
      console.error(`--- ${name} output tail ---`);
      console.error(chunks.slice(-20).join(''));
    }
    await stopAll();
    if (!KEEP) {
      rmSync(ENV, { recursive: true, force: true });
      rmSync(`${ENV}-proj`, { recursive: true, force: true });
      rmSync(PROJ, { recursive: true, force: true });
      rmSync(ART, { recursive: true, force: true });
    } else {
      log(`  kept: ${ART}`);
    }
    process.exit(1);
  });
