#!/usr/bin/env node
// 秘书真机验收：派活 → 确认 → 回传 → 并发确认。
// 全程在隔离 userData 与 fake provider 上跑，不碰真实账号与真实数据。
//   node scripts/verify-secretary.mjs [--keep] [--memory-only]
//
// 不设环境变量时，每次使用 /tmp/sec-verify-<随机> 和四个空闲端口
// （CDP、fake provider、插件分发、renderer dev server）。显式设置时以环境变量为准：
//   SEC_VERIFY_DIR、SEC_VERIFY_CDP_PORT、SEC_VERIFY_FAKE_PORT、
//   SEC_VERIFY_PLUGIN_PORT、SEC_VERIFY_RENDERER_PORT
// 自定义 SEC_VERIFY_DIR 必须位于 /tmp 下（mk-env 拒绝其它路径）。
// SEC_VERIFY_KEEP=1 或 --keep 只保留目录供排查，本次启动的进程仍会清掉。
// 启动时打印实际目录和端口。正常结束、失败、Ctrl-C/SIGTERM、未捕获异常都会
// 关掉本次 spawn 的整棵进程树，再删除目录。
//
// 不要用 `pgrep -f` 等待本脚本或它的子进程。-f 匹配整条命令行，pgrep 自己的
// argv 也含这段文字，会把自己算进去，等待条件永远为真，然后空转。
// 这里只记录 spawn 返回的 pid，再沿 ppid 收集子孙（父进程先退出、子进程被
// 领养到 launchd 之前就已经记入）。electron 即便不在 pnpm 的进程组里，只要是
// 这棵树里的进程就会被关掉；不会按端口去杀，避免误伤其它会话。
//
// renderer 端口：electron-vite 默认把 vite 绑在 5173。端口被占时 vite 会自己
// 往后探，但两个验收同时启动会一起撞上 5173。这里先挑空闲端口，再用
// ENSO_RENDERER_PORT 让本次 vite 以 strictPort 绑死。
//
// 「Cannot read properties of undefined (reading 'settings')」的根因是页面没就绪，
// 不是端口冲突：__stores 在 renderer 模块图跑完才赋值，而 electron-vite 在 preload
// 重编时会 full-reload 主窗口。旧代码只要看到一次 window.__stores.sessions 就往下
// eval `window.__stores.settings.getState()`，正好撞在重载后的空窗口上。现在要求
// settings/sessions/electronAPI 与 document 同时就绪并连续三次成立，目标换了或
// 上下文被销毁就重连重数；setup 段再兜一次重试。
//
// 产物：<dir>/*.png。步骤编号沿用计划「真机验证脚本思路」，执行顺序按依赖排：
// 计划第 3 步（派活出卡片）先跑，第 1、2 步用它的会话断言。
// 计划第 1 步原本走 dev IPC `secretary:dev-create-session`；该入口已删除，
// 这里改用正常派活路径，落的是同一个 Main 建会话函数。
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  explicitPort,
  keepRequested,
  mergeOwnedPids,
  ownedProcessGroups,
  reservePorts,
  resolveArtDir,
} from './verify-secretary-isolation.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const ART = resolveArtDir(process.env, (prefix) => mkdtempSync(prefix));
const ENV = `${ART}-env`;
const PROJ = `${ART}-proj`;
let CDP_PORT = 0;
let FAKE_PORT = 0;
let PLUGIN_PORT = 0;
let RENDERER_PORT = 0;
const KEEP = keepRequested(process.env, process.argv);
// 只跑 setup + 记忆人工编辑段，改记忆管理时用来快速复验
const MEMORY_ONLY = process.argv.includes('--memory-only');

const settingsFile = path.join(ENV, 'settings.json');
const dispatchFile = path.join(ENV, 'secretary', 'dispatch.json');
const auditFile = path.join(ENV, 'secretary', 'audit.jsonl');
const memoryAuditFile = path.join(ENV, 'memory', 'audit.jsonl');
const registryFile = path.join(ENV, 'agent', 'source-registry.json');
const sessionsDir = path.join(ENV, 'agent', 'sessions');

const children = [];
const results = [];

/** 测试插件经 http 分发的 zip：安装走 stageFromUrl，与用户粘贴链接同一入口 */
let pluginServer = null;

const log = (message) => console.log(message);

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

async function fakeRequests() {
  const reply = await fetch(`http://127.0.0.1:${FAKE_PORT}/__requests`);
  return (await reply.json()).requests;
}

/** settings.json 的落盘有 500ms 防抖，读到键之前先等一等 */
const conversationsIn = () => readJson(settingsFile)['enso-conversations']?.state?.conversations;

async function waitFor(check, label, timeoutMs = 30_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await delay(intervalMs);
  }
  throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
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

const trackedPids = [];
let portLease = null;

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

function packPluginZip() {
  const source = path.join(REPO, 'scripts/fixtures/secretary-test-plugin');
  const target = path.join(ART, 'secretary-test-plugin.zip');
  return new Promise((resolve, reject) => {
    const child = spawn('zip', ['-qr', target, '.'], { cwd: source, stdio: 'ignore' });
    child.on('exit', (code) =>
      code === 0 ? resolve(target) : reject(new Error(`zip exited ${code}`))
    );
  });
}

async function servePluginZip() {
  const zip = readFileSync(await packPluginZip());
  const server = createHttpServer((request, response) => {
    if (!request.url?.endsWith('.zip')) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/zip' });
    response.end(zip);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PLUGIN_PORT, '127.0.0.1', resolve);
  });
  pluginServer = server;
  return `http://127.0.0.1:${PLUGIN_PORT}/secretary-test-plugin.zip`;
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
  pluginServer?.close();
  pluginServer = null;
  for (const { name, child } of [...children].reverse()) {
    log(`  stopped ${name} (${child.pid ?? 'not-started'})`);
  }
  signalOwned('SIGTERM');
  await delay(1500);
  signalOwned('SIGKILL');
  await delay(200);
}

function removeIsolateDirs() {
  rmSync(ENV, { recursive: true, force: true });
  rmSync(`${ENV}-proj`, { recursive: true, force: true });
  rmSync(PROJ, { recursive: true, force: true });
  rmSync(ART, { recursive: true, force: true });
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
      removeIsolateDirs();
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

// 页面内共用入口：store 必须用 /stores/<file>.ts 的完整 URL，否则拿到的是另一份实例
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
const texts = (id) => (S().conversations[id]?.messages ?? []).map((m) =>
  (Array.isArray(m.content) ? m.content : []).filter((c) => c.type === 'text').map((c) => c.text).join(''));
// 缓存的其它会话与刚切过去还没渲染的面板里，卡片 innerText 为空；只认已渲染出来的最后一张
const shown = (selector) =>
  [...document.querySelectorAll(selector)].filter((node) => node.innerText.trim()).at(-1) ?? null;
`;

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
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const next = ++id;
      pending.set(next, resolve);
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  await send('Runtime.enable');

  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
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
    async json(body) {
      const raw = await evaluate(`(async () => { ${PRELUDE} ${body} })()`);
      return raw === undefined ? undefined : JSON.parse(raw);
    },
    async shot(file) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
      log(`  shot ${file}`);
    },
    close: () => socket.close(),
  };
}

async function prepareEnv() {
  rmSync(ENV, { recursive: true, force: true });
  rmSync(`${ENV}-proj`, { recursive: true, force: true });
  rmSync(ART, { recursive: true, force: true });
  rmSync(PROJ, { recursive: true, force: true });
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
  const settings = readJson(settingsFile);
  settings['enso-settings'].state.secretaryEnabled = true;
  for (const provider of settings['enso-settings'].state.providers ?? []) {
    provider.baseUrl = `http://127.0.0.1:${FAKE_PORT}`;
  }
  writeFileSync(settingsFile, JSON.stringify(settings));
  mkdirSync(PROJ, { recursive: true });
  writeFileSync(path.join(PROJ, 'README.md'), 'isolated dispatch target\n');
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

async function main() {
  portLease = await reservePorts(
    {
      cdp: explicitPort('SEC_VERIFY_CDP_PORT', process.env.SEC_VERIFY_CDP_PORT),
      fake: explicitPort('SEC_VERIFY_FAKE_PORT', process.env.SEC_VERIFY_FAKE_PORT),
      plugin: explicitPort('SEC_VERIFY_PLUGIN_PORT', process.env.SEC_VERIFY_PLUGIN_PORT),
      renderer: explicitPort('SEC_VERIFY_RENDERER_PORT', process.env.SEC_VERIFY_RENDERER_PORT),
    },
    listenLoopback
  );
  CDP_PORT = portLease.ports.cdp;
  FAKE_PORT = portLease.ports.fake;
  PLUGIN_PORT = portLease.ports.plugin;
  RENDERER_PORT = portLease.ports.renderer;
  log('== isolation');
  log(`  dir: ${ART}`);
  log(`  env: ${ENV}`);
  log(`  project: ${PROJ}`);
  log(`  ports: cdp=${CDP_PORT} fake=${FAKE_PORT} plugin=${PLUGIN_PORT} renderer=${RENDERER_PORT}`);
  log(`  keep: ${KEEP ? 'yes' : 'no'}`);
  await prepareEnv();
  await portLease.release('plugin');
  const pluginZipUrl = await servePluginZip();

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
  // 隔离证据：只有隔离实例会往自己的 userData 写这两份
  await waitFor(
    () => existsSync(path.join(ENV, 'DevToolsActivePort')) && existsSync(registryFile),
    'isolated userData markers',
    30_000
  );
  log('  isolated instance up');

  const cdp = await waitForStableRenderer();
  try {
    await run(cdp, pluginZipUrl);
  } finally {
    cdp.close();
  }
}

// __stores 要等 renderer 模块图跑完才赋值。electron-vite 在预加载重编时会 full-reload，
// 只看到一次 sessions 就往下 eval `window.__stores.settings`，会在重载窗口里抛
// Cannot read properties of undefined (reading 'settings')。连续三次都就绪才算页面准备好；
// 目标换了或执行上下文被销毁就重连，连续计数清零。
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
  } catch (error) {
    page?.close();
    throw error;
  }
}

async function run(cdp, pluginZipUrl) {
  const page = cdp.json.bind(cdp);

  log('== setup');
  let setup;
  for (let attempt = 1; ; attempt++) {
    try {
      setup = await page(`
    const ready = await until(
      () => Boolean(window.__stores?.settings?.getState && window.__stores?.sessions?.getState && window.electronAPI?.settings),
      30000
    );
    if (!ready) return JSON.stringify({ ok: false, error: 'renderer stores not ready' });
    window.__secVerifyMarker = Date.now();
    await until(() => SET().projects.some((p) => p.kind === 'secretary'), 30000);
    const project = await SET().addProject(${JSON.stringify(PROJ)});
    const saved = await window.electronAPI.secretary.saveProfile({
      name: '秘书',
      avatar: { color: '#6366f1' },
      model: null,
      autonomy: 'ask-first',
      autoApproveProjectIds: [],
      visibleProjectIds: 'all',
      dispatchModel: { mode: 'project' },
      dispatchWorktree: 'never',
      maxRunningDispatches: 3,
      replyLanguage: 'ui',
      style: 'concise',
      notify: 'off',
      addressAs: null,
      dailyBriefAt: null,
    });
    if (!saved.ok) return JSON.stringify({ ok: false, error: saved.error });
    const secretary = await SEC();
    const secretaryId = await secretary.getState().newSecretaryConversation({ profile: saved.profile });
    return JSON.stringify({
      ok: Boolean(secretaryId),
      marker: window.__secVerifyMarker,
      projectId: project.id,
      secretaryId,
      secretaryProjectId: secretary.getState().secretary.projectId,
    });
  `);
    } catch (error) {
      const message = String(error?.message ?? error);
      if (
        attempt >= 3 ||
        !/reading 'settings'|context was destroyed|Cannot find context|WebSocket/.test(message)
      ) {
        throw error;
      }
      log(`  renderer reloaded during setup, retry ${attempt}`);
      await delay(500);
      continue;
    }
    if (setup?.error !== 'renderer stores not ready' || attempt >= 3) break;
    log(`  renderer not ready, retry ${attempt}`);
    await delay(500);
  }
  assert(setup.ok, 'setup: 隔离实例里建出项目与秘书会话', setup);
  await cdp.shot(path.join(ART, '01-sidebar.png'));
  if (MEMORY_ONLY) {
    await verifyMemoryManualEdit(cdp, setup);
    return;
  }

  log('== step3 派活');
  const draft = {
    projectId: setup.projectId,
    prompt: '在项目根目录创建 hello.txt，内容写 hi',
    title: '写 hello.txt',
  };
  const directive = `[[tool:session_create ${JSON.stringify(draft)}]]`;
  const proposed = await page(`
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    S().selectConversation(${JSON.stringify(setup.secretaryId)});
    await S().send(
      '看看 ${path.basename(PROJ)} 的进展，然后派个活 ${directive}',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      ${JSON.stringify(setup.secretaryId)}
    );
    const card = await until(() => document.querySelector('[data-enso=secretary-proposal]'), 30000);
    if (!card) return JSON.stringify({ ok: false, error: 'no proposal card' });
    const secretary = await SEC();
    const proposal = Object.values(secretary.getState().secretary.proposals).at(-1);
    return JSON.stringify({
      ok: proposal.status === 'pending',
      proposalId: proposal.id,
      cardText: card.innerText,
      buttons: [...card.querySelectorAll('button')].map((b) => b.innerText),
    });
  `);
  assert(proposed.ok, 'step3: 聊天里出现待确认的派活卡片', proposed);
  await cdp.shot(path.join(ART, '02-proposal-card.png'));

  const confirmed = await page(`
    document.querySelector('[data-enso=secretary-proposal] button').click();
    const secretary = await SEC();
    const done = await until(() => {
      const p = secretary.getState().secretary.proposals[${JSON.stringify(proposed.proposalId)}];
      return p && p.status !== 'pending' && p.status !== 'executing' ? p : null;
    }, 30000);
    return JSON.stringify({ status: done?.status, conversationId: done?.conversationId });
  `);
  assert(
    confirmed.status === 'succeeded' && Boolean(confirmed.conversationId),
    'step3: 确认后提案执行成功',
    confirmed
  );
  const dispatchedId = confirmed.conversationId;

  log('== step2 单代单 jsonl');
  const second = await page(`
    const id = ${JSON.stringify(dispatchedId)};
    S().selectConversation(id);
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.projectId)});
    const sent = await S().send('再补一句：写完后回我一句', {
      providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path,
    }, undefined, id);
    const snapshot = await new Promise((resolve) => {
      const off = window.electronAPI.agent.onEvent((event) => {
        if (event.type === 'snapshot' && event.sessionId === id) { off(); resolve(event.sessions); }
      });
      window.electronAPI.agent.requestSnapshot(id);
      setTimeout(() => { off(); resolve(null); }, 15000);
    });
    const own = (snapshot ?? []).filter((entry) => entry.identity?.sessionId === id);
    return JSON.stringify({
      sendError: sent,
      ownGenerations: own.map((entry) => entry.identity.generation),
    });
  `);
  assert(second.sendError === null, 'step2: 派出会话能立即收到第二条消息', second);
  assert(second.ownGenerations.length === 1, 'step2: worker 里该会话只有一个 generation', second);
  const registry = readJson(registryFile);
  const entries = registry.conversations.filter((entry) => entry.conversationId === dispatchedId);
  assert(entries.length === 1, 'step2: 权威记录里该会话只有一条', entries.length);
  const sessionFiles = readdirSync(sessionsDir).filter((name) => name.endsWith('.jsonl'));
  const withFile = registry.conversations.filter((entry) => entry.sessionFile);
  assert(sessionFiles.length === withFile.length, 'step2: 每个会话只有一个 jsonl', {
    sessionFiles: sessionFiles.length,
    conversations: withFile.length,
  });

  log('== step1 行不丢');
  const persisted = await waitFor(
    () => conversationsIn()?.[dispatchedId],
    'dispatched row persisted',
    15_000,
    250
  ).catch(() => null);
  assert(Boolean(persisted), 'step1: Main 建的行在 settings.json 里', dispatchedId);
  const stored = await page(`
    const id = ${JSON.stringify(dispatchedId)};
    const row = S().conversations[id];
    S().togglePinConversation(${JSON.stringify(setup.secretaryId)});
    return JSON.stringify({
      marker: window.__secVerifyMarker,
      hasRow: Boolean(row),
      origin: row?.secretaryOrigin,
      projectId: row?.projectId,
      badge: [...document.querySelectorAll('[data-enso=secretary-origin]')].filter(
        (node) => node.offsetParent !== null
      ).length,
    });
  `);
  assert(stored.marker === setup.marker, 'step1: 页面没有重载', stored.marker);
  assert(stored.hasRow, 'step1: 不刷新就看到新行', stored);
  assert(
    stored.origin?.secretaryConversationId === setup.secretaryId,
    'step1: 行上带派出关系',
    stored.origin
  );
  assert(stored.projectId === setup.projectId, 'step1: 会话落在目标项目下', stored);
  assert(stored.badge >= 1, 'step1: 侧栏显示「由秘书派出」', stored.badge);
  await cdp.shot(path.join(ART, '03-dispatched-session.png'));

  // 置顶是一次真实的整份写回：等它落盘，再确认 Main 插入的行还在
  await waitFor(
    () => conversationsIn()?.[setup.secretaryId]?.pinned === true,
    'renderer write-back',
    15_000,
    200
  );
  const after = conversationsIn();
  assert(
    Boolean(after[dispatchedId]) && Boolean(after[setup.secretaryId]),
    'step1: renderer 整份写回后 Main 建的行仍在',
    Object.keys(after)
  );

  log('== step4 回传');
  const delivered = await page(`
    const secretaryId = ${JSON.stringify(setup.secretaryId)};
    const dispatched = ${JSON.stringify(dispatchedId)};
    const hit = await until(
      () => texts(secretaryId).some(
        (text) => text.startsWith('<session-updates>') && text.includes(dispatched)
      ),
      60000
    );
    return JSON.stringify({
      received: Boolean(hit),
      last: texts(secretaryId).filter((text) => text.startsWith('<session-updates>')).at(-1),
    });
  `);
  assert(delivered.received, 'step4: 秘书会话收到 <session-updates> 用户消息', delivered);
  const dispatchAfter = await waitFor(
    () => {
      const file = readJson(dispatchFile);
      return file.outbox.length === 0 && !file.inflight ? file : null;
    },
    'outbox drained',
    60_000,
    500
  );
  assert(
    dispatchAfter.outbox.length === 0 && !dispatchAfter.inflight,
    'step4: dispatch.json 的 outbox 已清空',
    dispatchAfter.outbox
  );
  const card = await page(`
    S().selectConversation(${JSON.stringify(setup.secretaryId)});
    const visible = (selector) =>
      [...document.querySelectorAll(selector)].filter((node) => node.offsetParent !== null);
    await until(() => visible('[data-enso=secretary-updates]').length > 0, 15000);
    const cards = visible('[data-enso=secretary-updates]');
    return JSON.stringify({
      cards: cards.length,
      openable: cards.some((node) => node.querySelector('button[title]')),
      raw: visible('[data-enso=message-user]').some((node) =>
        node.textContent.includes('<session-updates>')
      ),
    });
  `);
  assert(card.cards > 0 && !card.raw, 'step4: 回传渲染成卡片，不露出标签原文', card);
  assert(card.openable, 'step4: 回传卡片能打开派出的会话', card);
  await cdp.shot(path.join(ART, '04-secretary-updates.png'));

  log('== step6 目标完成');
  const goalSet = await page(`
    return JSON.stringify(
      await window.electronAPI.secretary.goalAction({
        conversationId: ${JSON.stringify(dispatchedId)},
        action: 'set',
        text: '收尾 [[tool:goal_complete {"summary":"hello.txt 已写好"}]]',
      })
    );
  `);
  assert(goalSet.ok, 'step6: 派出会话设上目标', goalSet);
  const goalDone = await waitFor(
    () => {
      const record = readJson(dispatchFile).dispatched[dispatchedId];
      return record?.lastResult?.kind === 'goal-complete' && record.lastState === 'idle'
        ? record
        : null;
    },
    'goal-complete recorded',
    60_000,
    500
  ).catch(() => null);
  assert(Boolean(goalDone), 'step6: 派出会话报了目标完成', readJson(dispatchFile).dispatched);
  await delay(1500);
  const goalRow = await page(`
    return JSON.stringify({ goal: S().conversations[${JSON.stringify(dispatchedId)}]?.goal ?? null });
  `);
  assert(goalRow.goal === null, 'step6: 目标完成后界面不再挂着目标条', goalRow);
  assert(!conversationsIn()?.[dispatchedId]?.goal, 'step6: 落盘的会话行也撤下了目标');
  const goalOutbox = readJson(dispatchFile).outbox.filter(
    (update) => update.conversationId === dispatchedId
  );
  assert(
    !goalOutbox.some((update) => update.kind === 'turn-ended'),
    'step6: 完成之后没有再补一条 turn-ended',
    goalOutbox
  );

  // 派出时就带目标的会话：记录里留着初始目标文本，目标完成后行里的目标撤下，记录里的文本不动
  log('== step6b 带初始目标的派出会话');
  const goalDispatch = await page(`
    const secretary = await SEC();
    const fresh = await secretary.getState().newSecretaryConversation();
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    const draft = ${JSON.stringify({
      projectId: setup.projectId,
      prompt: '创建 goal.txt',
      title: '写 goal.txt',
    })};
    await S().send(
      '派一个带目标的活 [[tool:session_create ' + JSON.stringify(draft) + ']]',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      fresh
    );
    const proposal = await until(() => {
      const pending = Object.values(secretary.getState().secretary.proposals).filter(
        (p) => p.status === 'pending'
      );
      return pending.at(-1) ?? null;
    }, 30000);
    if (!proposal) return JSON.stringify({ ok: false });
    // 目标经确认时的编辑注入，不塞进 prompt 里的 session_create 指令（fake provider 的指令解析不支持嵌套）
    const resolved = await window.electronAPI.secretary.resolveProposal(proposal.id, 'confirm', {
      goal: '收尾 [[tool:goal_complete {"summary":"goal.txt 已写好"}]]',
    });
    if (!resolved.ok) return JSON.stringify({ ok: false, error: resolved.error });
    const done = await until(() => {
      const p = secretary.getState().secretary.proposals[proposal.id];
      return p && p.status !== 'pending' && p.status !== 'executing' ? p : null;
    }, 30000);
    return JSON.stringify({
      ok: done?.status === 'succeeded',
      conversationId: done?.conversationId,
    });
  `);
  assert(
    goalDispatch.ok && Boolean(goalDispatch.conversationId),
    'step6b: 带初始目标的派出会话建成',
    goalDispatch
  );
  const goalSession = goalDispatch.conversationId;
  const goalDoneRecord = await waitFor(
    () => {
      const record = readJson(dispatchFile).dispatched[goalSession];
      return record?.lastResult?.kind === 'goal-complete' && record.lastState === 'idle'
        ? record
        : null;
    },
    'dispatched goal completed',
    60_000,
    500
  ).catch(() => null);
  assert(
    Boolean(goalDoneRecord),
    'step6b: 派出时带的目标完成',
    readJson(dispatchFile).dispatched[goalSession]
  );
  assert(goalDoneRecord.goal !== undefined, 'step6b: 派出记录里仍留着初始目标文本', goalDoneRecord);
  const goalFollowUp = await page(`
    const id = ${JSON.stringify(goalSession)};
    S().selectConversation(id);
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.projectId)});
    const sent = await S().send('再补一句：goal.txt 写好了吗', {
      providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path,
    }, undefined, id);
    return JSON.stringify({ sent });
  `);
  assert(goalFollowUp.sent === null, 'step6b: 目标撤下后派出会话还能收到新消息', goalFollowUp);
  const goalFollowUpDone = await waitFor(
    () => {
      const record = readJson(dispatchFile).dispatched[goalSession];
      return record?.lastResult?.kind === 'turn-ended' && record.lastState === 'idle'
        ? record
        : null;
    },
    'turn-ended after goal cleared',
    30_000,
    500
  ).catch(() => null);
  assert(
    Boolean(goalFollowUpDone),
    'step6b: 目标撤下后的追问轮次回报 turn-ended',
    readJson(dispatchFile).dispatched[goalSession]
  );
  assert(
    goalFollowUpDone.lastResult.turn === goalFollowUpDone.turn,
    'step6b: 结果记在新轮次上',
    goalFollowUpDone
  );

  log('== step6c 秘书给自己派出的会话发消息');
  const sendText = '秘书追问：goal.txt 写好了吗？请用一句中文回答，并说明是否需要我再做什么。';
  const sendAsk = [
    '跟进一下派出的会话',
    `[[tool:session_send ${JSON.stringify({ conversationId: goalSession, message: sendText })}]]`,
    `[[tool:session_send ${JSON.stringify({ conversationId: 'not-a-dispatched-session', message: 'test' })}]]`,
  ].join(' ');
  const turnBeforeSend = readJson(dispatchFile).dispatched[goalSession].turn;
  const sent = await page(`
    const secretary = await SEC();
    const id = await secretary.getState().newSecretaryConversation();
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    const textOf = (message) =>
      (Array.isArray(message.content) ? message.content : [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
    await S().send(
      ${JSON.stringify(sendAsk)},
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      id
    );
    const results = await until(() => {
      const found = (S().conversations[id]?.messages ?? []).filter(
        (message) => message.toolName === 'session_send'
      );
      return found.length >= 2 ? found : null;
    }, 40000);
    const delivered = await until(
      () => texts(${JSON.stringify(goalSession)}).some((text) => text.includes(${JSON.stringify(sendText)})),
      40000
    );
    return JSON.stringify({
      results: (results ?? []).map((message) => ({
        text: textOf(message),
        isError: message.isError === true,
      })),
      delivered: Boolean(delivered),
    });
  `);
  // worker 把成功结果原样回给模型，失败标成工具错误并带上 Main 的错误文本
  const okResult = sent.results?.find((entry) => !entry.isError);
  assert(
    Boolean(okResult) && /"status":"(sent|queued)"/u.test(okResult.text),
    'step6c: session_send 给自己派出的会话返回成功',
    sent
  );
  assert(sent.delivered, 'step6c: 派出的会话收到秘书发的消息', sent);
  const deniedResult = sent.results?.find((entry) => entry.isError)?.text;
  assert(
    deniedResult?.includes('permission denied (not-operable)') &&
      !deniedResult.includes('invalid arguments'),
    'step6c: 不可操作的会话报明确的拒绝原因，不再报 invalid arguments',
    sent
  );
  const sendAudit = readFileSync(auditFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.op === 'session_send');
  assert(
    sendAudit.some((entry) => entry.ok && entry.targetId === goalSession) &&
      sendAudit.some((entry) => !entry.ok && entry.detail === 'not-operable'),
    'step6c: audit 记下一次成功发送与一次拒绝',
    sendAudit
  );
  const sendTurnDone = await waitFor(
    () => {
      const record = readJson(dispatchFile).dispatched[goalSession];
      return record.turn > turnBeforeSend && record.lastState === 'idle' ? record : null;
    },
    'dispatched session turn after session_send',
    40_000,
    500
  ).catch(() => null);
  assert(
    Boolean(sendTurnDone),
    'step6c: 派出的会话处理完秘书的消息回到空闲',
    readJson(dispatchFile).dispatched[goalSession]
  );

  log('== step5 并发确认');
  const secondProposal = await page(`
    const secretary = await SEC();
    const fresh = await secretary.getState().newSecretaryConversation();
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    const draft = ${JSON.stringify({
      ...draft,
      prompt: '创建 notes.md，写一行说明',
      title: '写 notes.md',
    })};
    await S().send(
      '再派一个活 [[tool:session_create ' + JSON.stringify(draft) + ']]',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      fresh
    );
    const proposal = await until(() => {
      const pending = Object.values(secretary.getState().secretary.proposals).filter(
        (p) => p.status === 'pending'
      );
      return pending.at(-1) ?? null;
    }, 30000);
    return JSON.stringify({ secretaryId: fresh, proposalId: proposal?.id });
  `);
  assert(Boolean(secondProposal.proposalId), 'step5: 第二个提案已建立', secondProposal);
  const beforeCount = readJson(registryFile).conversations.filter(
    (entry) => entry.projectId === setup.projectId
  ).length;
  const concurrent = await page(`
    const id = ${JSON.stringify(secondProposal.proposalId)};
    return JSON.stringify(await Promise.all([
      window.electronAPI.secretary.resolveProposal(id, 'confirm'),
      window.electronAPI.secretary.resolveProposal(id, 'confirm'),
    ]));
  `);
  assert(
    concurrent.filter((entry) => entry.ok).length === 1,
    'step5: 并发确认只有一次成功',
    concurrent
  );
  assert(
    concurrent.some((entry) => !entry.ok && entry.error === 'not-pending'),
    'step5: 另一次被状态机挡下',
    concurrent
  );
  const projectConversations = readJson(registryFile).conversations.filter(
    (entry) => entry.projectId === setup.projectId
  );
  assert(projectConversations.length === beforeCount + 1, 'step5: 目标项目只多出一个会话', {
    before: beforeCount,
    after: projectConversations.length,
  });
  const dispatchFinal = readJson(dispatchFile);
  const records = Object.values(dispatchFinal.dispatched).filter(
    (record) => record.projectId === setup.projectId
  );
  assert(records.length === 3, 'step5: 三个派出会话各一条记录', records.length);
  const audit = readFileSync(auditFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  // 落盘时记 accepted，执行收尾记 succeeded：并发确认只应各有一条
  const confirmLines = audit.filter(
    (entry) => entry.op === 'proposal_confirm' && entry.targetId === secondProposal.proposalId
  );
  assert(
    confirmLines.length === 2 &&
      confirmLines.filter((entry) => entry.detail === 'accepted').length === 1 &&
      confirmLines.filter((entry) => entry.detail === 'succeeded').length === 1,
    'step5: audit 里该提案只有一条执行记录',
    confirmLines
  );
  const proposal = dispatchFinal.proposals[secondProposal.proposalId];
  assert(
    proposal.status === 'succeeded' && Boolean(dispatchFinal.dispatched[proposal.conversationId]),
    'step5: 提案指向唯一会话',
    proposal
  );

  // 造一条进行中的派出记录：上限 3 时提案能建，设置面板改成 1 后确认就该被拒
  log('== step5b 设置面板改派发上限');
  const profileFile = path.join(ENV, 'secretary', 'profile.json');
  await waitFor(
    () =>
      Object.values(readJson(dispatchFile).dispatched).every(
        (record) => record.lastState !== 'running'
      ) || null,
    'dispatched sessions settled',
    60_000,
    500
  );
  const limitSeed = readJson(dispatchFile);
  const seededState = limitSeed.dispatched[dispatchedId].lastState;
  limitSeed.dispatched[dispatchedId].lastState = 'running';
  writeFileSync(dispatchFile, JSON.stringify(limitSeed));
  const limitProposal = await page(`
    const secretary = await SEC();
    const fresh = await secretary.getState().newSecretaryConversation();
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    const draft = ${JSON.stringify({ ...draft, prompt: '创建 limit.txt', title: '写 limit.txt' })};
    await S().send(
      '超限前先提个派活 [[tool:session_create ' + JSON.stringify(draft) + ']]',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      fresh
    );
    const proposal = await until(() => {
      const pending = Object.values(secretary.getState().secretary.proposals).filter(
        (p) => p.status === 'pending' && p.secretaryConversationId === fresh
      );
      return pending.at(-1) ?? null;
    }, 30000);
    return JSON.stringify({ proposalId: proposal?.id });
  `);
  assert(Boolean(limitProposal.proposalId), 'step5b: 上限 3、进行中 1 时提案能建', limitProposal);

  await page(`
    await window.electronAPI.window.openSettings({
      category: 'secretary',
      rowId: 'secretary.dispatchLimit',
    });
    return 'null';
  `);
  const settingsPage = await waitFor(
    async () => {
      try {
        return await connect('settings.html');
      } catch {
        return null;
      }
    },
    'settings window',
    30_000,
    500
  );
  const pickLimit = (value) =>
    settingsPage.json(`
      const row = () => document.querySelector(
        '[data-settings-row="secretary.dispatchLimit"] [data-enso=secretary-dispatch-limit]'
      );
      const pressed = () =>
        [...(row()?.querySelectorAll('button[aria-pressed=true]') ?? [])].map((b) => b.innerText);
      await until(() => row(), 30000);
      const before = pressed();
      const options = [...(row()?.querySelectorAll('button') ?? [])].map((b) => b.innerText);
      [...row().querySelectorAll('button')].find((b) => b.innerText === ${JSON.stringify(String(value))})?.click();
      const after = await until(
        () => (pressed().join() === ${JSON.stringify(String(value))} ? pressed() : null),
        15000
      );
      return JSON.stringify({
        before,
        after,
        options,
        text: document.querySelector('[data-settings-row="secretary.dispatchLimit"]')?.innerText,
      });
    `);
  const lowered = await pickLimit(1);
  assert(lowered.before?.join() === '3', 'step5b: 设置面板显示当前上限 3', lowered);
  assert(
    lowered.options?.join() === '1,2,3,4,5,6,7,8,9,10',
    'step5b: 可选范围是 1 到 10',
    lowered.options
  );
  assert(
    lowered.text?.includes('超过上限时新派发会被拒绝'),
    'step5b: 文案说明超限会拒绝新派发',
    lowered.text
  );
  assert(lowered.after?.join() === '1', 'step5b: 面板上选中 1', lowered);
  await settingsPage.shot(path.join(ART, '05b-dispatch-limit.png'));
  const savedLow = await waitFor(
    () => (readJson(profileFile).maxRunningDispatches === 1 ? readJson(profileFile) : null),
    'profile.json limit 1',
    10_000,
    200
  ).catch(() => readJson(profileFile));
  assert(
    savedLow.maxRunningDispatches === 1,
    'step5b: profile.json 里的上限改成 1',
    savedLow.maxRunningDispatches
  );

  const limitBefore = readJson(registryFile).conversations.filter(
    (entry) => entry.projectId === setup.projectId
  ).length;
  const refused = await page(`
    return JSON.stringify(
      await window.electronAPI.secretary.resolveProposal(${JSON.stringify(limitProposal.proposalId)}, 'confirm')
    );
  `);
  assert(
    refused.ok &&
      refused.proposal?.status === 'failed' &&
      refused.proposal?.error === 'dispatch-limit',
    'step5b: 不重启秘书，确认时按新上限 1 拒绝',
    refused
  );
  assert(
    readJson(registryFile).conversations.filter((entry) => entry.projectId === setup.projectId)
      .length === limitBefore,
    'step5b: 被拒的派发没有建会话'
  );

  const restored = await pickLimit(3);
  assert(restored.after?.join() === '3', 'step5b: 面板改回 3', restored);
  const savedBack = await waitFor(
    () => (readJson(profileFile).maxRunningDispatches === 3 ? readJson(profileFile) : null),
    'profile.json limit 3',
    10_000,
    200
  ).catch(() => readJson(profileFile));
  assert(savedBack.maxRunningDispatches === 3, 'step5b: profile.json 里的上限改回 3', savedBack);
  await settingsPage.evaluate('window.close()').catch(() => undefined);
  settingsPage.close();
  const unseed = readJson(dispatchFile);
  unseed.dispatched[dispatchedId].lastState = seededState;
  writeFileSync(dispatchFile, JSON.stringify(unseed));

  log('== 秘书面板');
  const board = await page(`
    const toggles = [...document.querySelectorAll('button')].filter(
      (b) => b.getAttribute('aria-label') === '新建标签页'
    );
    toggles.at(-1).click();
    await sleep(500);
    const item = document.querySelector('[data-enso=secretary-panel-open]');
    if (!item) return JSON.stringify({ ok: false });
    item.click();
    await sleep(800);
    [...document.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === '折叠/展开右侧面板')
      .click();
    await sleep(1200);
    const panel = document.querySelector('[data-enso=secretary-panel]');
    return JSON.stringify({
      ok: Boolean(panel) && panel.innerText.includes('需要你处理'),
      tabs: [...document.querySelectorAll('[data-enso=secretary-panel-tab]')].map(
        (node) => node.dataset.tab
      ),
    });
  `);
  assert(board.ok, '秘书面板打开', board);
  assert(board.tabs?.join(',') === 'workbench,memory,schedules', '秘书面板三个标签', board.tabs);
  await cdp.shot(path.join(ART, '05-workbench.png'));
  // 秘书面板挂在当时的会话上；下面新建秘书会话会切走，结束后要回来
  const panelHost = await page('return JSON.stringify(S().activeId);');

  log('== 定时：秘书建的定时不刷新就出现在面板');
  const scheduled = await page(`
    document.querySelector('[data-enso=secretary-panel-tab][data-tab=schedules]').click();
    const rows = () => [...document.querySelectorAll('[data-enso=secretary-schedule]')]
      .filter((node) => node.textContent.includes('验收巡检'));
    const before = rows().length;
    const secretary = await SEC();
    const id = await secretary.getState().newSecretaryConversation();
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    await S().send(
      '每十分钟巡检一次 [[tool:schedule_add {"name":"验收巡检","prompt":"看看进展","cron":"*/10 * * * *"}]]',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      id
    );
    const scheduleRow = await until(() => rows()[0] ?? null, 40000);
    return JSON.stringify({
      before,
      shown: Boolean(scheduleRow),
      rowText: scheduleRow?.textContent ?? null,
      marker: window.__secVerifyMarker,
    });
  `);
  assert(scheduled.before === 0, '定时: 新建前面板里没有这条', scheduled);
  assert(
    scheduled.shown && scheduled.marker === setup.marker,
    '定时: schedule_add 之后面板不用手动刷新就显示新定时',
    scheduled
  );
  await cdp.shot(path.join(ART, '05b-schedules.png'));
  const scheduleId = await page(`
    const listed = await window.electronAPI.secretary.listSchedules();
    const rows = Array.isArray(listed) ? listed : (listed?.schedules ?? []);
    return JSON.stringify(rows.find((row) => row.name === '验收巡检')?.id ?? null);
  `);
  const unscheduled = await page(`
    const secretary = await SEC();
    const id = await secretary.getState().newSecretaryConversation();
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    await S().send(
      '不用巡检了 [[tool:schedule_remove {"scheduleId":${JSON.stringify(scheduleId ?? '')}}]]',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      id
    );
    const gone = await until(() => ![...document.querySelectorAll('[data-enso=secretary-schedule]')]
      .some((node) => node.textContent.includes('验收巡检')), 40000);
    return JSON.stringify({ gone: Boolean(gone) });
  `);
  assert(Boolean(scheduleId) && unscheduled.gone, '定时: schedule_remove 之后面板自动去掉这条', {
    scheduleId,
    ...unscheduled,
  });

  const panelBack = await page(`
    S().selectConversation(${JSON.stringify(panelHost)});
    const panel = await until(
      () => document.querySelector('[data-enso=secretary-panel]')?.offsetParent != null,
      10000
    );
    document.querySelector('[data-enso=secretary-panel-tab][data-tab=workbench]')?.click();
    await sleep(300);
    return JSON.stringify({ shown: Boolean(panel) });
  `);
  assert(panelBack.shown, '定时: 回到原会话后秘书面板仍在', panelBack);

  const welcome = await page(`
    const secretary = await SEC();
    secretary.getState().openWelcome();
    await new Promise((r) => setTimeout(r, 300));
    const main = document.querySelector('[data-enso="main"]');
    const heading = [...document.querySelectorAll('h2')].find((h) => h.textContent.includes('设置你的秘书'));
    const side = document.querySelector('[data-enso="secretary-panel"]');
    const out = { shown: Boolean(heading), inMain: Boolean(heading && main?.contains(heading)), sideVisible: Boolean(side && side.getBoundingClientRect().width > 0) };
    secretary.getState().closeWelcome();
    return JSON.stringify(out);
  `);
  assert(
    welcome.shown && welcome.inMain && welcome.sideVisible,
    '初次设置页只盖聊天区，右侧面板仍在',
    welcome
  );

  // 两个派出会话跨一个整分钟先后开始、慢慢流式输出：动态的时间应停在各自开始的那一分钟，顺序不跳
  log('== 动态：各自的开始时间，运行期间顺序不变');
  const dispatchSlow = async (title, slowMs) => {
    const started = await page(`
      const todo = await window.electronAPI.secretary.mutateTodo({
        action: 'add', text: ${JSON.stringify(title)}, projectId: ${JSON.stringify(setup.projectId)},
      });
      if (!todo.ok) return JSON.stringify({ ok: false, error: todo.error });
      const sent = await window.electronAPI.secretary.mutateTodo({
        action: 'dispatch', todoId: todo.todoId, prompt: ${JSON.stringify(`慢慢回复 [[slow:${slowMs}]]`)},
      });
      if (!sent.ok) return JSON.stringify({ ok: false, error: sent.error });
      const secretary = await SEC();
      const proposal = await until(() => Object.values(secretary.getState().secretary.proposals).find(
        (p) => p.status === 'pending' && p.kind === 'dispatch' && p.draft.todoId === todo.todoId
      ), 5000);
      if (proposal) {
        const resolved = await window.electronAPI.secretary.resolveProposal(proposal.id, 'confirm', {
          title: ${JSON.stringify(title)},
        });
        if (!resolved.ok) return JSON.stringify({ ok: false, error: resolved.error });
      }
      return JSON.stringify({ ok: true, todoId: todo.todoId });
    `);
    assert(started.ok, `动态：派出「${title}」`, started);
    return waitFor(
      () =>
        Object.values(readJson(dispatchFile).dispatched).find(
          (record) => record.todoId === started.todoId
        ) ?? null,
      `dispatch record of ${title}`,
      30_000,
      300
    );
  };
  const clockOf = (at) => {
    const date = new Date(at);
    return [date.getHours(), date.getMinutes()];
  };
  const sameClock = (text, at) => {
    const match = text?.match(/(\d{1,2}):(\d{2})/);
    const [hour, minute] = clockOf(at);
    return Boolean(match) && Number(match[1]) % 24 === hour && Number(match[2]) === minute;
  };
  const sampleFeed = (ids) =>
    page(`
      const secretary = await SEC();
      const board = secretary.getState().secretary.board;
      const cards = [...board.needsYou, ...board.running, ...board.done].filter((c) => c.kind === 'session');
      const ids = ${JSON.stringify(ids)};
      const rows = [...document.querySelectorAll('[data-enso=secretary-feed-event]')].map((node) => ({
        tone: node.dataset.tone,
        text: node.innerText,
      }));
      const out = {};
      for (const id of ids) {
        const card = cards.find((c) => c.conversationId === id);
        const index = card ? rows.findIndex((row) => row.text.includes(card.title)) : -1;
        out[id] = { card, index, row: rows[index] ?? null };
      }
      return JSON.stringify(out);
    `);

  const firstMinute = 60_000 - (Date.now() % 60_000);
  const feedA = await dispatchSlow('动态时间 A', firstMinute + 45_000);
  // 等到墙钟进入下一分钟再派第二个，两条的开始时间落在不同的分钟里
  await waitFor(
    () => Math.floor(Date.now() / 60_000) > Math.floor(feedA.createdAt / 60_000) || null,
    'next minute',
    70_000,
    250
  );
  await delay(1000);
  const feedB = await dispatchSlow('动态时间 B', 25_000);
  const feedIds = [feedB.conversationId, feedA.conversationId];
  const feedSamples = [];
  for (let index = 0; index < 6; index += 1) {
    await delay(index === 0 ? 1500 : 2000);
    feedSamples.push(await sampleFeed(feedIds));
  }
  // 刚派出时 worker 状态可能再切一次，以第一次采样为基准，之后不许再动
  const since = Object.fromEntries(feedIds.map((id) => [id, feedSamples[0][id].card?.stateSince]));
  assert(
    feedIds.every(
      (id) =>
        typeof since[id] === 'number' &&
        Math.abs(since[id] - feedSamples[0][id].card.startedAt) < 5000
    ),
    '动态：状态起始时间就是派出时间',
    feedIds.map((id) => feedSamples[0][id].card)
  );
  await cdp.shot(path.join(ART, '05b-feed-running.png'));
  const sampleIssues = feedSamples.flatMap((sample, index) =>
    feedIds.flatMap((id) => {
      const entry = sample[id];
      const issues = [];
      if (entry.card?.state !== 'running' || entry.row?.tone !== 'run') issues.push('not running');
      if (entry.card?.stateSince !== since[id]) issues.push('stateSince moved');
      if (!sameClock(entry.row?.text, since[id])) issues.push('clock is not the start time');
      return issues.length > 0 ? [{ sample: index, id, issues, entry }] : [];
    })
  );
  assert(sampleIssues.length === 0, '动态：运行期间两条都显示各自的开始时间', sampleIssues);
  assert(
    !sameClock(feedSamples[0][feedA.conversationId].row?.text, since[feedB.conversationId]),
    '动态：两条的开始时间不同（跨了一分钟）',
    feedSamples[0]
  );
  const orders = feedSamples.map((sample) => feedIds.map((id) => sample[id].index).join(','));
  assert(
    new Set(orders).size === 1 &&
      feedSamples[0][feedIds[0]].index < feedSamples[0][feedIds[1]].index,
    '动态：运行期间顺序不变，后开始的在前',
    orders
  );
  const busy = readJson(dispatchFile).dispatched;
  assert(
    feedIds.every(
      (id) => busy[id].lastEventAt > since[id] + 5000 && busy[id].stateSince === since[id]
    ),
    '动态：采样期间会话一直有活动，开始时间没被活动刷新',
    feedIds.map((id) => busy[id])
  );
  const feedDone = await waitFor(
    () => {
      const file = readJson(dispatchFile).dispatched;
      return feedIds.every(
        (id) => file[id]?.lastState === 'idle' && file[id]?.lastResult?.kind === 'turn-ended'
      )
        ? file
        : null;
    },
    'slow dispatches finished',
    150_000,
    500
  );
  const doneSample = await sampleFeed(feedIds);
  assert(
    feedIds.every(
      (id) =>
        doneSample[id].row?.tone === 'ok' &&
        sameClock(doneSample[id].row?.text, feedDone[id].lastResult.at)
    ),
    '动态：结束后显示各自结束的时间',
    { doneSample, results: feedIds.map((id) => feedDone[id].lastResult) }
  );

  log('== step7 worker 退出');
  const restarted = await page(`
    return JSON.stringify(await window.electronAPI.caCert.apply('/etc/ssl/cert.pem'));
  `);
  assert(restarted.source === 'setting', 'step7: 改 CA 证书让 Main 重启 agent worker', restarted);
  const exited = await waitFor(
    () => (readJson(dispatchFile).dispatched[dispatchedId]?.lastState === 'error' ? true : null),
    'worker exit observed',
    20_000,
    300
  ).catch(() => null);
  assert(
    Boolean(exited),
    'step7: Main 看到了 worker 退出',
    readJson(dispatchFile).dispatched[dispatchedId]
  );
  const afterExit = readJson(dispatchFile);
  const failed = Object.values(afterExit.dispatched).filter(
    (record) => record.lastResult?.kind === 'failed'
  );
  assert(failed.length === 0, 'step7: 空闲的派出会话不因 worker 退出记失败', failed);
  assert(
    !afterExit.outbox.some((update) => update.kind === 'failed'),
    'step7: 回传队列里没有失败',
    afterExit.outbox
  );

  // 失败结果最稳的造法是直接改隔离实例的 dispatch.json，再用一次待办写入触发推送
  log('== step8 结果卡「知道了」');
  const seeded = readJson(dispatchFile);
  const seededRecord = seeded.dispatched[dispatchedId];
  seededRecord.lastResult = { kind: 'failed', turn: seededRecord.turn, at: Date.now() };
  writeFileSync(dispatchFile, JSON.stringify(seeded));
  const published = await page(`
    return JSON.stringify(
      await window.electronAPI.secretary.mutateTodo({ action: 'add', text: '验收占位待办' })
    );
  `);
  assert(published.ok, 'step8: 写盘后触发一次状态推送', published);
  const shown = await page(`
    const visible = (selector) =>
      [...document.querySelectorAll(selector)].filter((node) => node.offsetParent !== null);
    const button = await until(() => visible('[data-enso=secretary-dismiss-result]')[0] ?? null, 15000);
    if (!button) return JSON.stringify({ ok: false });
    const card = button.closest('[data-enso=secretary-card]');
    return JSON.stringify({
      ok: Boolean(card) && Boolean(card.closest('[data-enso=secretary-needs-you]')),
      text: card?.innerText,
    });
  `);
  assert(shown.ok, 'step8: 失败结果卡挂在需要你处理', shown);
  await cdp.shot(path.join(ART, '06-result-card.png'));
  const dismissed = await page(`
    const visible = (selector) =>
      [...document.querySelectorAll(selector)].filter((node) => node.offsetParent !== null);
    const button = visible('[data-enso=secretary-dismiss-result]')[0];
    if (!button) return JSON.stringify({ ok: false, error: 'no dismiss button' });
    button.click();
    const gone = await until(
      () => visible('[data-enso=secretary-dismiss-result]').length === 0 &&
        visible('[data-enso=secretary-needs-you]').every((node) => !node.innerText.includes('写 hello.txt')),
      15000
    );
    return JSON.stringify({ ok: Boolean(gone) });
  `);
  assert(dismissed.ok, 'step8: 点「知道了」后卡片从需要你处理消失', dismissed);
  const dismissedOnDisk = await waitFor(
    () =>
      readJson(dispatchFile).dispatched[dispatchedId]?.lastResult?.dismissed === true ? true : null,
    'dismissed persisted',
    15_000,
    300
  ).catch(() => null);
  assert(
    Boolean(dismissedOnDisk),
    'step8: 磁盘上记下这条结果已清掉',
    readJson(dispatchFile).dispatched[dispatchedId]
  );
  const dismissAudit = readFileSync(auditFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.op === 'result_dismiss' && entry.targetId === dispatchedId);
  assert(dismissAudit.length === 1, 'step8: audit 里记了一条 result_dismiss', dismissAudit);

  // 新开一个秘书会话出提案再带编辑确认；指令放在编辑里，fake provider 的指令解析不支持嵌套
  const dispatchConfirmed = (directive, edits) =>
    page(`
    const secretary = await SEC();
    const fresh = await secretary.getState().newSecretaryConversation();
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    await S().send(
      '派活 ' + ${JSON.stringify(directive)},
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      fresh
    );
    const proposal = await until(() => {
      const pending = Object.values(secretary.getState().secretary.proposals).filter(
        (p) => p.status === 'pending' && p.secretaryConversationId === fresh
      );
      return pending.at(-1) ?? null;
    }, 30000);
    if (!proposal) return JSON.stringify({ ok: false, error: 'no proposal' });
    const resolved = await window.electronAPI.secretary.resolveProposal(
      proposal.id, 'confirm', ${JSON.stringify(edits ?? {})}
    );
    if (!resolved.ok) return JSON.stringify({ ok: false, error: resolved.error });
    const done = await until(() => {
      const p = secretary.getState().secretary.proposals[proposal.id];
      return p && p.status !== 'pending' && p.status !== 'executing' ? p : null;
    }, 30000);
    return JSON.stringify({
      ok: done?.status === 'succeeded',
      secretaryId: fresh,
      conversationId: done?.conversationId,
      error: done?.error,
    });
  `);
  const secretarySaw = (secretaryId, conversationId, kind) =>
    page(`
    return JSON.stringify(texts(${JSON.stringify(secretaryId)}).some((text) =>
      text.includes(${JSON.stringify(`[${kind} session:${conversationId}]`)})));
  `);
  const secretaryCount = (secretaryId, conversationId, kind) =>
    page(`
    const needle = ${JSON.stringify(`[${kind} session:${conversationId}]`)};
    return JSON.stringify(texts(${JSON.stringify(secretaryId)}).filter((text) => text.includes(needle)).length);
  `);

  log('== step9 等后台任务不报 needs-user，真提问才报');
  const waitDispatch = await dispatchConfirmed(
    `[[tool:session_create ${JSON.stringify({
      projectId: setup.projectId,
      prompt: '跑全量测试',
      title: '等后台任务',
    })}]]`,
    { goal: '跑完测试 [[tool:goal_wait {"reason":"真机验收已在后台运行，完成后会通知我"}]]' }
  );
  assert(waitDispatch.ok, 'step9: 带目标的派出会话建成', waitDispatch);
  const waitId = waitDispatch.conversationId;
  const waitGoal = await page(`
    const row = await until(() => {
      const r = S().conversations[${JSON.stringify(waitId)}];
      return r?.goal?.status === 'waiting' ? r : null;
    }, 60000);
    return JSON.stringify({ status: row?.goal?.status ?? null });
  `);
  assert(waitGoal.status === 'waiting', 'step9: 派出会话调了 goal_wait 在等后台任务', waitGoal);
  await waitFor(
    () => {
      const record = readJson(dispatchFile).dispatched[waitId];
      return record?.turn >= 1 && record.lastState === 'idle' ? record : null;
    },
    'goal_wait turn settled',
    60_000,
    500
  );
  await delay(2000);
  const waitRecord = readJson(dispatchFile).dispatched[waitId];
  assert(
    waitRecord.lastResult?.kind !== 'needs-user',
    'step9: goal_wait 等后台任务不记 needs-user',
    waitRecord
  );
  assert(
    !(await secretarySaw(waitDispatch.secretaryId, waitId, 'needs-user')),
    'step9: 秘书没收到该会话的 needs-user',
    waitId
  );

  const askDispatch = await dispatchConfirmed(
    `[[tool:session_create ${JSON.stringify({
      projectId: setup.projectId,
      prompt: '占位',
      title: '真提问',
    })}]]`,
    { prompt: '选方案 [[tool:ask_user {"question":"用哪个方案？","options":["A","B"]}]]' }
  );
  assert(askDispatch.ok, 'step9: 会提问的派出会话建成', askDispatch);
  const askId = askDispatch.conversationId;
  const askRecord = await waitFor(
    () => {
      const record = readJson(dispatchFile).dispatched[askId];
      return record?.lastResult?.kind === 'needs-user' ? record : null;
    },
    'ask_user needs-user recorded',
    60_000,
    500
  ).catch(() => null);
  assert(
    Boolean(askRecord),
    'step9: 真有 ask_user 时记 needs-user',
    readJson(dispatchFile).dispatched[askId]
  );
  const askSeen = await waitFor(
    () => secretarySaw(askDispatch.secretaryId, askId, 'needs-user'),
    'secretary got needs-user',
    60_000,
    500
  ).catch(() => false);
  assert(askSeen, 'step9: 秘书收到该会话的 needs-user', askId);
  const answered = await page(`
    const id = ${JSON.stringify(askId)};
    const ask = await until(() => (S().conversations[id]?.pendingAsks ?? [])[0] ?? null, 15000);
    if (!ask) return JSON.stringify({ ok: false, error: 'no pending ask' });
    const reply = await window.electronAPI.agent.respondAsk(id, ask.requestId, 'A');
    const cleared = await until(() => (S().conversations[id]?.pendingAsks ?? []).length === 0, 30000);
    return JSON.stringify({ ok: Boolean(cleared), reply });
  `);
  assert(answered.ok, 'step9: 回答后提问会话收尾', answered);
  await waitFor(
    () => (readJson(dispatchFile).dispatched[askId]?.lastState === 'idle' ? true : null),
    'ask session idle',
    30_000,
    500
  );

  log('== step10 待办派出的会话标题用待办文本');
  const todoText = '修复秘书通知误报';
  const todoAdded = await page(`
    return JSON.stringify(await window.electronAPI.secretary.mutateTodo({
      action: 'add', text: ${JSON.stringify(todoText)}, projectId: ${JSON.stringify(setup.projectId)},
    }));
  `);
  assert(todoAdded.ok, 'step10: 建出带项目的待办', todoAdded);
  const todoDispatch = await dispatchConfirmed(
    `[[tool:todo_item_dispatch ${JSON.stringify({
      todoId: todoAdded.todoId,
      prompt: '背景：秘书功能在 feat/secretary-agent 分支上开发，这个分支检出在别处',
    })}]]`
  );
  assert(todoDispatch.ok, 'step10: 待办派出会话建成', todoDispatch);
  const todoRow = await page(`
    const row = await until(() => S().conversations[${JSON.stringify(todoDispatch.conversationId)}], 15000);
    return JSON.stringify({ title: row?.title ?? null });
  `);
  assert(todoRow.title === todoText, 'step10: 会话标题是待办文本', todoRow);
  const todoPersisted = await waitFor(
    () => conversationsIn()?.[todoDispatch.conversationId],
    'todo dispatched row persisted',
    15_000,
    250
  ).catch(() => null);
  assert(todoPersisted?.title === todoText, 'step10: 落盘的会话行标题也是待办文本', todoPersisted);

  log('== step11 等后台任务不误报，完成只在结束后推一次');
  const profilePath = path.join(ENV, 'secretary', 'profile.json');
  const profile = readJson(profilePath);
  profile.updateWindowMs = 1000;
  writeFileSync(profilePath, JSON.stringify(profile));
  const bgDispatch = await dispatchConfirmed(
    `[[tool:session_create ${JSON.stringify({
      projectId: setup.projectId,
      prompt: '把检查放到后台',
      title: '等后台续跑',
    })}]]`,
    {
      goal: '先把检查丢到后台再等通知 [[tool:bash {"command":"sleep 12","background":true}]]',
    }
  );
  assert(bgDispatch.ok, 'step11: 等后台任务的派出会话建成', bgDispatch);
  const bgId = bgDispatch.conversationId;
  const bgSettled = await waitFor(
    () => {
      const record = readJson(dispatchFile).dispatched[bgId];
      return record?.turn >= 1 && (record.lastState === 'idle' || record.lastState === 'error')
        ? record
        : null;
    },
    'background wait turn settled',
    60_000,
    400
  ).catch(() => null);
  assert(bgSettled?.lastState === 'idle', 'step11: 等后台任务被续跑后会话不是 error', bgSettled);
  assert(
    bgSettled.lastResult?.kind !== 'goal-blocked' && bgSettled.lastResult?.kind !== 'failed',
    'step11: 等后台任务不记 goal-blocked 或 failed',
    bgSettled
  );
  await delay(2500);
  const bgAfter = readJson(dispatchFile).dispatched[bgId];
  assert(bgAfter.lastState !== 'error', 'step11: 等过收口窗口会话仍不是 error', bgAfter);
  assert(
    !(await secretarySaw(bgDispatch.secretaryId, bgId, 'goal-blocked')) &&
      !(await secretarySaw(bgDispatch.secretaryId, bgId, 'failed')),
    'step11: 秘书没收到该会话的 goal-blocked 或 failed',
    bgId
  );

  const blockedDispatch = await dispatchConfirmed(
    `[[tool:session_create ${JSON.stringify({
      projectId: setup.projectId,
      prompt: '停下来',
      title: '真受阻',
    })}]]`,
    { goal: '缺决定 [[tool:goal_blocked {"reason":"缺一个只有用户知道的决定"}]]' }
  );
  assert(blockedDispatch.ok, 'step11: 会调用 goal_blocked 的会话建成', blockedDispatch);
  const blockedId = blockedDispatch.conversationId;
  const blockedSeen = await waitFor(
    () => secretarySaw(blockedDispatch.secretaryId, blockedId, 'goal-blocked'),
    'secretary got goal-blocked',
    60_000,
    400
  ).catch(() => false);
  assert(blockedSeen, 'step11: 真正调用 goal_blocked 时秘书能收到', blockedId);
  await delay(2500);
  assert(
    (await secretaryCount(blockedDispatch.secretaryId, blockedId, 'goal-blocked')) === 1,
    'step11: goal-blocked 只推一次',
    await secretaryCount(blockedDispatch.secretaryId, blockedId, 'goal-blocked')
  );

  const completeDispatch = await dispatchConfirmed(
    `[[tool:session_create ${JSON.stringify({
      projectId: setup.projectId,
      prompt: '写完就停',
      title: '真完成',
    })}]]`,
    { goal: '收尾 [[tool:goal_complete {"summary":"step11 文件已写好"}]]' }
  );
  assert(completeDispatch.ok, 'step11: 会调用 goal_complete 的会话建成', completeDispatch);
  const completeId = completeDispatch.conversationId;
  let completeWhileRunning = false;
  const completeRecord = await waitFor(
    async () => {
      const record = readJson(dispatchFile).dispatched[completeId];
      const live = await page(
        `return JSON.stringify(S().conversations[${JSON.stringify(completeId)}]?.status ?? null)`
      );
      if (record?.lastResult?.kind === 'goal-complete' && live !== 'idle')
        completeWhileRunning = true;
      return record?.lastResult?.kind === 'goal-complete' &&
        record.lastState === 'idle' &&
        live === 'idle'
        ? record
        : null;
    },
    'goal-complete after idle',
    60_000,
    200
  ).catch(() => null);
  assert(
    Boolean(completeRecord) && !completeWhileRunning,
    'step11: goal-complete 只在会话结束后出现',
    { completeRecord, completeWhileRunning }
  );
  const completeSeen = await waitFor(
    () => secretarySaw(completeDispatch.secretaryId, completeId, 'goal-complete'),
    'secretary saw goal-complete',
    20_000,
    300
  ).catch(() => false);
  assert(completeSeen, 'step11: 完成后秘书收到更新', completeId);
  await delay(1500);
  assert(
    (await secretaryCount(completeDispatch.secretaryId, completeId, 'goal-complete')) === 1,
    'step11: goal-complete 只推一次',
    await secretaryCount(completeDispatch.secretaryId, completeId, 'goal-complete')
  );

  log('== step12 目标会话的中间轮不打扰，完成时才开口');
  const quietDispatch = await dispatchConfirmed(
    `[[tool:session_create ${JSON.stringify({
      projectId: setup.projectId,
      prompt: '连续检查几轮',
      title: '连续验收',
    })}]]`,
    { goal: '把检查做完。先不要调用 goal_complete 或 goal_blocked' }
  );
  assert(quietDispatch.ok, 'step12: 连续跑的目标会话建成', quietDispatch);
  const quietId = quietDispatch.conversationId;
  const quietTurns = await waitFor(
    () => {
      const record = readJson(dispatchFile).dispatched[quietId];
      return record?.turn >= 3 ? record : null;
    },
    'goal session ran several turns',
    60_000,
    400
  ).catch(() => null);
  assert(quietTurns?.turn >= 3, 'step12: 目标会话连续跑了几轮', quietTurns);
  assert(
    !(await secretarySaw(quietDispatch.secretaryId, quietId, 'turn-ended')) &&
      !(await secretarySaw(quietDispatch.secretaryId, quietId, 'failed')) &&
      !(await secretarySaw(quietDispatch.secretaryId, quietId, 'goal-blocked')),
    'step12: 中间轮没有推进秘书聊天',
    quietId
  );
  const quietFeed = await page(`
    const secretary = await SEC();
    const board = secretary.getState().secretary.board;
    const activity = (board.activity ?? []).filter((entry) => entry.conversationId === ${JSON.stringify(quietId)});
    const cards = [...board.running, ...board.done, ...board.needsYou].filter(
      (card) => card.kind === 'session' && card.conversationId === ${JSON.stringify(quietId)}
    );
    return JSON.stringify({ activity: activity.length, cards: cards.length, title: cards[0]?.title ?? null });
  `);
  assert(quietFeed.activity >= 1 && quietFeed.cards === 1, 'step12: 动态里能看到这几轮', quietFeed);

  const bgQuiet = await dispatchConfirmed(
    `[[tool:session_create ${JSON.stringify({
      projectId: setup.projectId,
      prompt: '把检查放到后台',
      title: '后台别打扰',
    })}]]`,
    { goal: '先放后台再等 [[tool:bash {"command":"sleep 8","background":true}]]' }
  );
  assert(bgQuiet.ok, 'step12: 等后台任务的目标会话建成', bgQuiet);
  const bgQuietId = bgQuiet.conversationId;
  const bgQuietSettled = await waitFor(
    () => {
      const record = readJson(dispatchFile).dispatched[bgQuietId];
      return record?.turn >= 1 && (record.lastState === 'idle' || record.lastState === 'error')
        ? record
        : null;
    },
    'background goal turn settled',
    60_000,
    400
  ).catch(() => null);
  assert(
    bgQuietSettled?.lastState === 'idle',
    'step12: 等后台任务没有把会话打成 error',
    bgQuietSettled
  );
  assert(
    !(await secretarySaw(bgQuiet.secretaryId, bgQuietId, 'turn-ended')) &&
      !(await secretarySaw(bgQuiet.secretaryId, bgQuietId, 'failed')),
    'step12: 等后台任务的那一轮没有推给秘书',
    bgQuietId
  );

  const doneDispatch = await dispatchConfirmed(
    `[[tool:session_create ${JSON.stringify({
      projectId: setup.projectId,
      prompt: '收尾',
      title: '合并后开口',
    })}]]`,
    { goal: '收尾 [[tool:goal_complete {"summary":"step12 做完了"}]]' }
  );
  assert(doneDispatch.ok, 'step12: 会完成的目标会话建成', doneDispatch);
  const doneId = doneDispatch.conversationId;
  const doneSeen = await waitFor(
    () => secretarySaw(doneDispatch.secretaryId, doneId, 'goal-complete'),
    'secretary saw goal-complete',
    30_000,
    300
  ).catch(() => false);
  assert(doneSeen, 'step12: 完成后秘书收到更新', doneId);
  const doneReply = await page(`
    const messages = S().conversations[${JSON.stringify(doneDispatch.secretaryId)}]?.messages ?? [];
    const body = (message) =>
      (Array.isArray(message?.content) ? message.content : [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
    const hit = messages.findIndex((message) =>
      body(message).includes(${JSON.stringify(`[goal-complete session:${doneId}]`)})
    );
    const reply = messages.slice(hit + 1).find((message) => message.role === 'assistant');
    return JSON.stringify({ reply: reply ? body(reply) : null });
  `);
  assert(
    Boolean(doneReply.reply) && !doneReply.reply.includes('<secretary-silent/>'),
    'step12: 完成后秘书正常回复',
    doneReply
  );

  log('== 插件：勾选后才进秘书会话');
  const installed = await page(`
    const staged = await window.electronAPI.extensionPlugins.stageFromUrl(${JSON.stringify(pluginZipUrl)});
    if (!staged.ok) return JSON.stringify({ ok: false, error: staged.error });
    const committed = await window.electronAPI.extensionPlugins.commit(staged.preview.token);
    if (!committed.ok) return JSON.stringify({ ok: false, error: committed.error });
    const enabled = await window.electronAPI.extensionPlugins.setEnabled('enso.secretarytest', true);
    if (!enabled.ok) return JSON.stringify({ ok: false, error: enabled.error });
    const listed = (await window.electronAPI.extensionPlugins.list()).find(
      (plugin) => plugin.id === 'enso.secretarytest'
    );
    const saved = await window.electronAPI.secretary.saveProfile({
      pluginIds: ['enso.secretarytest'],
    });
    if (!saved.ok) return JSON.stringify({ ok: false, error: saved.error });
    const secretary = await SEC();
    const id = await secretary.getState().newSecretaryConversation();
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    await S().send(
      '插件回显一次 [[tool:plugin_enso-secretarytest__echo {"text":"hi"}]]',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      id
    );
    const textOf = (message) =>
      (Array.isArray(message.content) ? message.content : [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
    const result = await until(
      () => (S().conversations[id]?.messages ?? []).find(
        (message) => message.toolName === 'plugin_enso-secretarytest__echo'
      ) ?? null,
      40000
    );
    return JSON.stringify({
      ok: Boolean(result),
      state: listed?.state,
      tools: listed?.tools.map((tool) => tool.name),
      secretaryId: id,
      text: result ? textOf(result) : null,
      isError: result?.isError === true,
    });
  `);
  assert(
    installed.ok && installed.state === 'enabled',
    '插件: 隔离实例里装好并启用测试插件',
    installed
  );
  assert(
    installed.text?.includes('echo:hi') && !installed.isError,
    '插件: 勾选后秘书会话能调只读插件工具并拿到返回',
    installed
  );

  log('== 插件：非只读工具每次都要审批');
  const poked = await page(`
    const secretary = await SEC();
    const id = await secretary.getState().newSecretaryConversation();
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    await S().send(
      '发一条消息 [[tool:plugin_enso-secretarytest__poke {"text":"hello"}]]',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      id
    );
    const pending = await until(() => (S().conversations[id]?.pendingApprovals ?? [])[0] ?? null, 40000);
    if (!pending) return JSON.stringify({ ok: false, error: 'no approval card' });
    const approved = await window.electronAPI.agent.respondApproval(id, pending.requestId, 'allow');
    const textOf = (message) =>
      (Array.isArray(message.content) ? message.content : [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
    const result = await until(
      () => (S().conversations[id]?.messages ?? []).find(
        (message) => message.toolName === 'plugin_enso-secretarytest__poke'
      ) ?? null,
      40000
    );
    return JSON.stringify({
      ok: Boolean(result),
      tool: pending.tool,
      approved: approved?.ok ?? null,
      text: result ? textOf(result) : null,
      isError: result?.isError === true,
    });
  `);
  assert(poked.tool === 'plugin_enso-secretarytest__poke', '插件: 非只读插件工具弹出审批卡', poked);
  assert(
    poked.approved === true && poked.text?.includes('poked:hello') && !poked.isError,
    '插件: 批准后非只读插件工具才执行',
    poked
  );

  log('== 插件：取消勾选后工具不可用');
  const unchecked = await page(`
    const saved = await window.electronAPI.secretary.saveProfile({ pluginIds: [] });
    if (!saved.ok) return JSON.stringify({ ok: false, error: saved.error });
    const secretary = await SEC();
    const id = await secretary.getState().newSecretaryConversation();
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    await S().send(
      '取消勾选后再回显 [[tool:plugin_enso-secretarytest__echo {"text":"again"}]]',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      id
    );
    const result = await until(
      () => (S().conversations[id]?.messages ?? []).find(
        (message) => message.toolName === 'plugin_enso-secretarytest__echo'
      ) ?? null,
      40000
    );
    return JSON.stringify({ ok: Boolean(result), isError: result?.isError === true });
  `);
  const toolList = await fakeRequests().then((entries) =>
    entries.filter((entry) => entry.lastUserText.includes('取消勾选后再回显')).at(-1)
  );
  assert(
    !(toolList?.toolNames ?? []).includes('plugin_enso-secretarytest__echo'),
    '插件: 取消勾选后新会话不再下发该插件工具',
    toolList
  );
  assert(unchecked.isError === true, '插件: 取消勾选后同一调用报错', unchecked);

  log('== 技能：提案 → 确认 → 写盘 → 新会话读到');
  const skillFile = path.join(ENV, 'secretary', 'workspace', 'skills', 'deploy-check', 'SKILL.md');
  const skillDraft = {
    name: 'deploy-check',
    description: '发布前跑一遍',
    body: '# 步骤\n\n- 跑测试',
  };
  // 整条指令由 JSON.stringify 注入：否则 page 源码里的 \\n 会变成真换行，fake provider 解析不出参数
  const skillAsk = `把这个做法沉淀成 skill [[tool:skill_propose ${JSON.stringify(skillDraft)}]]`;
  const skillProposed = await page(`
    const secretary = await SEC();
    const id = await secretary.getState().newSecretaryConversation();
    S().selectConversation(id);
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    await S().send(
      ${JSON.stringify(skillAsk)},
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      id
    );
    const card = await until(() => shown('[data-enso=secretary-proposal][data-kind=skill]'), 30000);
    if (!card)
      return JSON.stringify({
        ok: false,
        error: 'no proposal card',
        messages: (S().conversations[id]?.messages ?? []).slice(-6).map((message) => ({
          tool: message.toolName,
          text: (Array.isArray(message.content) ? message.content : [])
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('')
            .slice(0, 300),
          isError: message.isError === true,
        })),
      });
    const proposal = Object.values(secretary.getState().secretary.proposals).at(-1);
    return JSON.stringify({
      ok: proposal.status === 'pending' && proposal.kind === 'skill',
      proposalId: proposal.id,
      cardText: card.innerText,
      buttons: [...card.querySelectorAll('button')].map((b) => b.innerText),
    });
  `);
  assert(
    skillProposed.ok && skillProposed.cardText.includes('deploy-check'),
    '技能: 聊天里出现待确认的 skill 卡片',
    skillProposed
  );
  await cdp.shot(path.join(ART, '09-skill-proposal.png'));

  const skillConfirmed = await page(`
    const secretary = await SEC();
    await secretary.getState().resolveProposal(${JSON.stringify(skillProposed.proposalId)}, 'confirm');
    const done = await until(() => {
      const p = secretary.getState().secretary.proposals[${JSON.stringify(skillProposed.proposalId)}];
      return p && p.status !== 'pending' && p.status !== 'executing' ? p : null;
    }, 30000);
    return JSON.stringify({ status: done?.status, error: done?.error });
  `);
  assert(skillConfirmed.status === 'succeeded', '技能: 确认后提案执行成功', skillConfirmed);
  const skillOnDisk = await waitFor(
    () => (existsSync(skillFile) ? readFileSync(skillFile, 'utf8') : null),
    'skill file on disk',
    15_000,
    300
  ).catch(() => null);
  assert(
    Boolean(skillOnDisk?.includes('name: deploy-check') && skillOnDisk.includes('跑测试')),
    '技能: 磁盘上出现 SKILL.md',
    skillOnDisk
  );
  const skillAudit = readFileSync(auditFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.op === 'skill_save' && entry.targetId === 'deploy-check');
  assert(
    skillAudit.length === 1 && skillAudit[0].ok === true,
    '技能: audit 里记了一条 skill_save',
    skillAudit
  );

  log('== 技能：新会话里 skill_read 读到内容');
  const skillRead = await page(`
    const secretary = await SEC();
    const id = await secretary.getState().newSecretaryConversation();
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    const textOf = (message) =>
      (Array.isArray(message.content) ? message.content : [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
    await S().send(
      '读一下 deploy-check [[tool:skill_read {"name":"deploy-check"}]]',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      id
    );
    const result = await until(
      () => (S().conversations[id]?.messages ?? []).find(
        (message) => message.toolName === 'skill_read'
      ) ?? null,
      40000
    );
    return JSON.stringify({
      ok: Boolean(result),
      text: result ? textOf(result) : null,
      isError: result?.isError === true,
    });
  `);
  assert(
    skillRead.text?.includes('跑测试') && !skillRead.isError,
    '技能: 新秘书会话里 skill_read 读到 SKILL.md 正文',
    skillRead
  );

  log('== 技能：skill_read 只认已加载的名字');
  const skillRejected = await page(`
    const secretary = await SEC();
    const id = await secretary.getState().newSecretaryConversation();
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    const textOf = (message) =>
      (Array.isArray(message.content) ? message.content : [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
    await S().send(
      '读两个不存在的东西 [[tool:skill_read {"name":"no-such-skill"}]] [[tool:skill_read {"name":"../secretary/profile.json"}]]',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      id
    );
    const results = await until(() => {
      const found = (S().conversations[id]?.messages ?? []).filter(
        (message) => message.toolName === 'skill_read'
      );
      return found.length >= 2 ? found : null;
    }, 40000);
    return JSON.stringify({
      ok: Boolean(results),
      texts: (results ?? []).map(textOf),
      errors: (results ?? []).map((message) => message.isError === true),
    });
  `);
  assert(
    skillRejected.ok && skillRejected.errors.every(Boolean),
    '技能: 不存在的名字与路径名都被拒绝',
    skillRejected
  );

  log('== 工具：提案 → 确认 → 写盘 → 新会话调用');
  const toolDir = path.join(ENV, 'secretary', 'workspace', 'tools', 'upper-text');
  const upperDraft = {
    name: 'upper-text',
    description: '把文本转成大写',
    runtime: 'node',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    readOnly: true,
    code: 'let raw = "";\nprocess.stdin.on("data", (chunk) => (raw += chunk));\nprocess.stdin.on("end", () => {\n  process.stdout.write(JSON.parse(raw).text.toUpperCase());\n});',
  };
  const upperAsk = `造一个常用工具 [[tool:tool_propose ${JSON.stringify(upperDraft)}]]`;
  const upperProposed = await page(`
    const secretary = await SEC();
    const id = await secretary.getState().newSecretaryConversation();
    S().selectConversation(id);
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    await S().send(
      ${JSON.stringify(upperAsk)},
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      id
    );
    const card = await until(() => shown('[data-enso=secretary-proposal][data-kind=tool]'), 30000);
    if (!card)
      return JSON.stringify({
        ok: false,
        error: 'no tool proposal card',
        messages: (S().conversations[id]?.messages ?? []).slice(-4).map((message) => ({
          tool: message.toolName,
          text: (Array.isArray(message.content) ? message.content : [])
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('')
            .slice(0, 300),
          isError: message.isError === true,
        })),
      });
    const proposal = Object.values(secretary.getState().secretary.proposals).at(-1);
    return JSON.stringify({
      ok: proposal.status === 'pending' && proposal.kind === 'tool',
      proposalId: proposal.id,
      cardText: card.innerText,
    });
  `);
  assert(
    upperProposed.ok &&
      upperProposed.cardText.includes('upper-text') &&
      upperProposed.cardText.includes('Node'),
    '工具: 聊天里出现待确认的工具卡片',
    upperProposed
  );
  await cdp.shot(path.join(ART, '10-tool-proposal.png'));

  const upperConfirmed = await page(`
    const secretary = await SEC();
    await secretary.getState().resolveProposal(${JSON.stringify(upperProposed.proposalId)}, 'confirm');
    const done = await until(() => {
      const p = secretary.getState().secretary.proposals[${JSON.stringify(upperProposed.proposalId)}];
      return p && p.status !== 'pending' && p.status !== 'executing' ? p : null;
    }, 30000);
    return JSON.stringify({ status: done?.status, error: done?.error });
  `);
  assert(upperConfirmed.status === 'succeeded', '工具: 确认后提案执行成功', upperConfirmed);
  const upperOnDisk = await waitFor(
    () => {
      const meta = path.join(toolDir, 'tool.json');
      const script = path.join(toolDir, 'main.mjs');
      if (!existsSync(meta) || !existsSync(script)) return null;
      return { meta: readJson(meta), script: readFileSync(script, 'utf8') };
    },
    'tool files on disk',
    15_000,
    300
  ).catch(() => null);
  assert(
    upperOnDisk?.meta.name === 'upper-text' &&
      upperOnDisk.meta.readOnly === true &&
      upperOnDisk.script.includes('toUpperCase'),
    '工具: 磁盘上出现 tool.json 与 main.mjs',
    upperOnDisk
  );
  const toolAudit = readFileSync(auditFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.op === 'tool_save' && entry.targetId === 'upper-text');
  assert(
    toolAudit.length === 1 && toolAudit[0].ok === true,
    '工具: audit 里记了一条 tool_save',
    toolAudit
  );

  log('== 工具：新会话里 my_<name> 直接执行');
  const upperRan = await page(`
    const secretary = await SEC();
    const id = await secretary.getState().newSecretaryConversation();
    S().selectConversation(id);
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    const textOf = (message) =>
      (Array.isArray(message.content) ? message.content : [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
    await S().send(
      '把 hello 转成大写 [[tool:my_upper_text {"text":"hello"}]]',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      id
    );
    const result = await until(
      () => (S().conversations[id]?.messages ?? []).find(
        (message) => message.toolName === 'my_upper_text'
      ) ?? null,
      40000
    );
    return JSON.stringify({
      ok: Boolean(result),
      text: result ? textOf(result) : null,
      isError: result?.isError === true,
    });
  `);
  assert(
    !upperRan.isError &&
      upperRan.text?.includes('HELLO') &&
      upperRan.text?.includes('<untrusted-content source="tool:upper-text">'),
    '工具: 新秘书会话里只读工具直接执行并包成不可信内容',
    upperRan
  );

  log('== 工具：非只读工具每次都要审批');
  const stampDraft = {
    name: 'stamp-file',
    description: '把文本写进工具目录的 out.txt',
    runtime: 'node',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    readOnly: false,
    code: 'import { writeFileSync } from "node:fs";\nlet raw = "";\nprocess.stdin.on("data", (chunk) => (raw += chunk));\nprocess.stdin.on("end", () => {\n  writeFileSync("out.txt", JSON.parse(raw).text);\n  process.stdout.write("wrote");\n});',
  };
  const stampAsk = `再造一个会写文件的工具 [[tool:tool_propose ${JSON.stringify(stampDraft)}]]`;
  const stampProposed = await page(`
    const secretary = await SEC();
    const id = await secretary.getState().newSecretaryConversation();
    S().selectConversation(id);
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    await S().send(
      ${JSON.stringify(stampAsk)},
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      id
    );
    const card = await until(() => shown('[data-enso=secretary-proposal][data-kind=tool]'), 30000);
    if (!card) return JSON.stringify({ ok: false, error: 'no tool proposal card' });
    const proposal = Object.values(secretary.getState().secretary.proposals).at(-1);
    return JSON.stringify({
      ok: proposal.status === 'pending' && proposal.kind === 'tool',
      proposalId: proposal.id,
      cardText: card.innerText,
    });
  `);
  assert(
    stampProposed.ok && stampProposed.cardText.includes('stamp-file'),
    '工具: 非只读工具也走确认卡片',
    stampProposed
  );
  const stampConfirmed = await page(`
    const secretary = await SEC();
    await secretary.getState().resolveProposal(${JSON.stringify(stampProposed.proposalId)}, 'confirm');
    const done = await until(() => {
      const p = secretary.getState().secretary.proposals[${JSON.stringify(stampProposed.proposalId)}];
      return p && p.status !== 'pending' && p.status !== 'executing' ? p : null;
    }, 30000);
    return JSON.stringify({ status: done?.status, error: done?.error });
  `);
  assert(stampConfirmed.status === 'succeeded', '工具: 非只读工具确认后写盘', stampConfirmed);

  const stampRan = await page(`
    const secretary = await SEC();
    const id = await secretary.getState().newSecretaryConversation();
    S().selectConversation(id);
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    const textOf = (message) =>
      (Array.isArray(message.content) ? message.content : [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
    await S().send(
      '写一下 [[tool:my_stamp_file {"text":"hi"}]]',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      id
    );
    const pending = await until(() => (S().conversations[id]?.pendingApprovals ?? [])[0] ?? null, 40000);
    if (!pending) return JSON.stringify({ ok: false, error: 'no approval card' });
    const approved = await window.electronAPI.agent.respondApproval(id, pending.requestId, 'allow');
    const result = await until(
      () => (S().conversations[id]?.messages ?? []).find(
        (message) => message.toolName === 'my_stamp_file'
      ) ?? null,
      40000
    );
    return JSON.stringify({
      ok: Boolean(result),
      tool: pending.tool,
      approved: approved?.ok ?? null,
      text: result ? textOf(result) : null,
      isError: result?.isError === true,
    });
  `);
  assert(stampRan.tool === 'my_stamp_file', '工具: 非只读工具弹出审批卡', stampRan);
  assert(
    stampRan.approved === true && stampRan.text?.includes('wrote') && !stampRan.isError,
    '工具: 批准后才执行非只读工具',
    stampRan
  );
  const stampOut = await waitFor(
    () => {
      const file = path.join(ENV, 'secretary', 'workspace', 'tools', 'stamp-file', 'out.txt');
      return existsSync(file) ? readFileSync(file, 'utf8') : null;
    },
    'tool output file',
    15_000,
    300
  ).catch(() => null);
  assert(stampOut === 'hi', '工具: 非只读工具真的写到了自己的目录', stampOut);

  log('== 工具：删除后新会话不再下发');
  const toolListed = await page(`
    const listed = await window.electronAPI.secretary.listTools();
    return JSON.stringify({
      ok: listed.ok,
      names: (listed.tools ?? []).map((tool) => tool.name),
      hasCode: (listed.tools ?? []).every((tool) => typeof tool.code === 'string' && tool.code.length > 0),
    });
  `);
  assert(
    toolListed.names?.includes('upper-text') && toolListed.hasCode === true,
    '工具: 设置页列表带名字与代码',
    toolListed
  );

  const toolRemoved = await page(`
    const removed = await window.electronAPI.secretary.removeTool('upper-text');
    return JSON.stringify(removed);
  `);
  assert(toolRemoved.ok === true, '工具: 删除成功', toolRemoved);
  const toolDeleteAudit = readFileSync(auditFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.op === 'tool_delete' && entry.targetId === 'upper-text');
  assert(
    toolDeleteAudit.length === 1 && toolDeleteAudit[0].ok === true,
    '工具: audit 里记了一条 tool_delete',
    toolDeleteAudit
  );

  const toolGone = await page(`
    const secretary = await SEC();
    const id = await secretary.getState().newSecretaryConversation();
    S().selectConversation(id);
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    await S().send(
      '删除后再看看工具表',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      id
    );
    await until(() => (S().conversations[id]?.messages ?? []).some((m) => m.role === 'assistant'), 40000);
    return JSON.stringify({ ok: true });
  `);
  assert(toolGone.ok === true, '工具: 删除后新会话照常回话', toolGone);
  const afterDelete = await fakeRequests().then((entries) =>
    entries.filter((entry) => entry.lastUserText.includes('删除后再看看工具表')).at(-1)
  );
  assert(
    !(afterDelete?.toolNames ?? []).includes('my_upper_text') &&
      (afterDelete?.toolNames ?? []).includes('my_stamp_file'),
    '工具: 删除后新会话不再下发该工具，其它工具还在',
    afterDelete
  );

  await verifyTakeover(cdp, setup);

  copyFileSync(auditFile, path.join(ART, 'audit.jsonl'));
  log(`  copied ${path.join(ART, 'audit.jsonl')}`);

  await verifyMemoryManualEdit(cdp, setup);
}

/**
 * 秘书经 memory_capture 写两条私有记忆，再在设置页「记忆」里按秘书空间筛选、编辑一条、删除一条：
 * 编辑后新词搜得到、旧词搜不到（精确与 agent 同款检索都查），删除后搜不到，两次操作都落记忆审计。
 */
async function verifyMemoryManualEdit(cdp, setup) {
  const page = cdp.json.bind(cdp);
  const spaceId = `proj:${setup.secretaryProjectId}`;
  log('== 记忆：秘书写入私有记忆');
  const captures = [
    { title: 'Deploy window', content: 'deploy window is tuesday zebrafish' },
    { title: 'Cache layer', content: 'cache layer uses walrusdb' },
  ];
  for (const capture of captures) {
    const directive = `[[tool:memory_capture ${JSON.stringify({ ...capture, spaceId: 'project', importance: 0.6 })}]]`;
    const written = await page(`
      const secretary = await SEC();
      const id = await secretary.getState().newSecretaryConversation();
      S().selectConversation(id);
      const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
      await S().send(
        ${JSON.stringify(`记一下 ${directive}`)},
        { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
        undefined,
        id
      );
      const result = await until(
        () => (S().conversations[id]?.messages ?? []).find((m) => m.toolName === 'memory_capture') ?? null,
        40000
      );
      return JSON.stringify({ ok: Boolean(result), isError: result?.isError === true });
    `);
    assert(written.ok && !written.isError, `记忆: 秘书写入「${capture.title}」`, written);
  }
  const seeded = await page(`
    const listed = await window.electronAPI.memory.list({ spaceId: ${JSON.stringify(spaceId)}, limit: 20, offset: 0 });
    return JSON.stringify(listed.items.map((item) => ({ id: item.id, title: item.title })));
  `);
  const target = seeded.find((item) => item.title === 'Deploy window');
  const doomed = seeded.find((item) => item.title === 'Cache layer');
  assert(target && doomed, '记忆: 两条都落在秘书私有空间', seeded);

  log('== 记忆：设置页筛选秘书空间');
  await page(`
    await window.electronAPI.window.openSettings({ category: 'memory', rowId: 'memory.library' });
    return JSON.stringify(true);
  `);
  const settingsCdp = await waitFor(
    () => connect('settings.html').catch(() => null),
    'settings window',
    30_000,
    500
  );
  try {
    const ui = settingsCdp.json.bind(settingsCdp);
    const UI = `
      const q = (s) => document.querySelector(s);
      const press = (el) => {
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
          el.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, button: 0, pointerType: 'mouse' }));
        }
        el.click();
      };
      const typeInto = (el, value) => {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const rowIds = () => [...document.querySelectorAll('[data-memory-id]')].map((el) => el.getAttribute('data-memory-id'));
    `;
    const filtered = await ui(`
      ${UI}
      const trigger = await until(() => q('[data-memory-filter="space-kind"]'), 30000);
      if (!trigger) return JSON.stringify({ ok: false, error: 'no space kind filter' });
      await until(() => rowIds().length >= 2, 15000);
      press(trigger);
      const option = await until(
        () => [...document.querySelectorAll('[role="option"]')].find((el) => ['秘书', 'Secretary'].includes(el.textContent.trim())),
        5000
      );
      if (!option) return JSON.stringify({ ok: false, error: 'no secretary option', html: document.body.innerText.slice(0, 400) });
      press(option);
      await sleep(800);
      return JSON.stringify({ ok: true, ids: rowIds(), label: trigger.textContent.trim() });
    `);
    assert(
      filtered.ok &&
        ['秘书', 'Secretary'].includes(filtered.label) &&
        filtered.ids.includes(target.id) &&
        filtered.ids.includes(doomed.id),
      '记忆: 设置页按「秘书」空间筛出秘书的两条记忆',
      filtered
    );

    log('== 记忆：设置页编辑一条');
    const edited = await ui(`
      ${UI}
      q('[data-memory-id=${JSON.stringify(target.id)}] button:not([role=checkbox])').click();
      const editButton = await until(() => q('[data-memory-action="edit"]'), 10000);
      if (!editButton) return JSON.stringify({ ok: false, error: 'no edit button' });
      editButton.click();
      const title = await until(() => q('[data-memory-field="title"]'), 5000);
      typeInto(title, 'Release window');
      typeInto(q('[data-memory-field="content"]'), 'release window is friday narwhal');
      typeInto(q('[data-memory-field="importance"]'), '0.85');
      await sleep(200);
      q('[data-memory-action="save"]').click();
      const saved = await until(
        () => q('[data-memory-detail] [data-memory-field="content"]')?.textContent.includes('narwhal'),
        15000
      );
      return JSON.stringify({ ok: Boolean(saved), error: q('[data-memory-edit] .text-destructive')?.textContent ?? null });
    `);
    assert(edited.ok, '记忆: 设置页编辑保存后详情显示新内容', edited);
    await settingsCdp.shot(path.join(ART, '40-memory-edited.png'));
    const afterEdit = await ui(`
      const find = async (query, mode) =>
        (await window.electronAPI.memory.list({ query, mode, limit: 20, offset: 0 })).items.map((i) => i.id);
      const detail = await window.electronAPI.memory.detail(${JSON.stringify(target.id)});
      return JSON.stringify({
        title: detail?.title,
        importance: detail?.importance,
        newExact: await find('narwhal', 'exact'),
        newFast: await find('narwhal', 'fast'),
        oldExact: await find('zebrafish', 'exact'),
        oldFast: await find('zebrafish', 'fast'),
      });
    `);
    assert(
      afterEdit.title === 'Release window' && afterEdit.importance === 0.85,
      '记忆: 标题与重要度已更新',
      afterEdit
    );
    assert(
      afterEdit.newExact.includes(target.id) && afterEdit.newFast.includes(target.id),
      '记忆: 编辑后新内容在精确与检索模式都能命中',
      afterEdit
    );
    assert(
      !afterEdit.oldExact.includes(target.id) && !afterEdit.oldFast.includes(target.id),
      '记忆: 编辑后旧内容搜不到',
      afterEdit
    );

    log('== 记忆：设置页删除一条（二次确认）');
    const deleted = await ui(`
      ${UI}
      // 详情框还开着：点另一行直接换成那条的详情，等换好再点删除，别点到上一条的按钮
      const row = await until(() => q('[data-memory-id=${JSON.stringify(doomed.id)}] button:not([role=checkbox])'), 5000);
      if (!row) return JSON.stringify({ ok: false, error: 'row missing' });
      row.click();
      const opened = await until(() => q('[data-memory-detail=${JSON.stringify(doomed.id)}]'), 10000);
      if (!opened) return JSON.stringify({ ok: false, error: 'detail not switched' });
      const del = q('[data-memory-action="delete"]');
      del.click();
      const confirm = await until(() => {
        const button = q('[data-memory-action="confirm-delete"]');
        return button && !button.disabled ? button : null;
      }, 10000);
      if (!confirm) return JSON.stringify({ ok: false, error: 'confirm not ready' });
      const impact = q('[data-memory-delete-impact]')?.innerText ?? '';
      const stillThere = Boolean(await window.electronAPI.memory.detail(${JSON.stringify(doomed.id)}));
      confirm.click();
      const gone = await until(() => !rowIds().includes(${JSON.stringify(doomed.id)}), 15000);
      return JSON.stringify({ ok: Boolean(gone), impact, stillThereBeforeConfirm: stillThere });
    `);
    assert(
      deleted.stillThereBeforeConfirm &&
        (deleted.impact.includes('不影响其他记忆') ||
          deleted.impact.includes('No other memories are affected')),
      '记忆: 删除先弹确认并说明影响，确认前不删',
      deleted
    );
    assert(deleted.ok, '记忆: 确认后列表里消失', deleted);
    const afterDelete = await ui(`
      const listed = await window.electronAPI.memory.list({ query: 'walrusdb', limit: 20, offset: 0 });
      const fast = await window.electronAPI.memory.list({ query: 'walrusdb', mode: 'fast', limit: 20, offset: 0 });
      return JSON.stringify({
        detail: await window.electronAPI.memory.detail(${JSON.stringify(doomed.id)}),
        exact: listed.items.map((i) => i.id),
        fast: fast.items.map((i) => i.id),
      });
    `);
    assert(
      afterDelete.detail === null &&
        afterDelete.exact.length === 0 &&
        afterDelete.fast.length === 0,
      '记忆: 删除后精确与检索模式都搜不到',
      afterDelete
    );
    await settingsCdp.shot(path.join(ART, '41-memory-deleted.png'));
  } finally {
    settingsCdp.close();
  }

  const memoryAudit = readFileSync(memoryAuditFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const editAudit = memoryAudit.filter(
    (entry) => entry.action === 'memory.edit' && entry.memoryId === target.id
  );
  const deleteAudit = memoryAudit.filter(
    (entry) => entry.action === 'memory.delete' && entry.requested.includes(doomed.id)
  );
  assert(
    editAudit.length === 1 &&
      editAudit[0].changes.title?.to === 'Release window' &&
      editAudit[0].changes.content?.toChars > 0 &&
      !JSON.stringify(editAudit[0]).includes('zebrafish'),
    '记忆: 编辑记了审计，正文只留 hash',
    editAudit
  );
  assert(
    deleteAudit.length === 1 && deleteAudit[0].impact.deleted[0]?.id === doomed.id,
    '记忆: 删除记了审计',
    deleteAudit
  );
  copyFileSync(memoryAuditFile, path.join(ART, 'memory-audit.jsonl'));
  log(`  copied ${path.join(ART, 'memory-audit.jsonl')}`);
}

/** 新开一个秘书会话，让 fake provider 调一次秘书工具，取回工具结果原文 */
async function secretaryTool(cdp, setup, toolName, args, ask) {
  const prompt = `${ask} [[tool:${toolName} ${JSON.stringify(args)}]]`;
  return cdp.json(`
    const secretary = await SEC();
    const id = await secretary.getState().newSecretaryConversation();
    S().selectConversation(id);
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    const textOf = (message) =>
      (Array.isArray(message.content) ? message.content : [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
    await S().send(
      ${JSON.stringify(prompt)},
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      id
    );
    const result = await until(
      () => (S().conversations[id]?.messages ?? []).find(
        (message) => message.toolName === ${JSON.stringify(toolName)}
      ) ?? null,
      40000
    );
    return JSON.stringify({ secretaryId: id, text: result ? textOf(result) : null });
  `);
}

const auditLines = () =>
  readFileSync(auditFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

async function verifyTakeover(cdp, setup) {
  const page = cdp.json.bind(cdp);

  log('== 接管：用户自己开的会话');
  const own = await page(`
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.projectId)});
    const id = await S().newConversation(project.id);
    S().selectConversation(id);
    const sent = await S().send('用户自己开的会话：先打个招呼', {
      providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path,
    }, undefined, id);
    const replied = await until(
      () => (S().conversations[id]?.messages ?? []).some((m) => m.role === 'assistant'),
      30000
    );
    return JSON.stringify({ id, sent, replied: Boolean(replied) });
  `);
  assert(own.sent === null && own.replied, '接管: 用户自己开的会话跑完一轮', own);
  const ownId = own.id;
  await waitFor(() => conversationsIn()?.[ownId], 'own session row persisted', 15_000, 250);

  const refusedStop = await secretaryTool(
    cdp,
    setup,
    'session_stop',
    { conversationId: ownId },
    '停掉用户的会话'
  );
  assert(
    refusedStop.text?.includes('not-operable') &&
      refusedStop.text.includes('session_takeover_propose'),
    '接管: 未授权时 session_stop 被拒，并提示可以申请接管',
    refusedStop
  );

  const ownSecretary = await secretaryTool(
    cdp,
    setup,
    'session_takeover_propose',
    { conversationId: setup.secretaryId },
    '接管秘书自己的会话'
  );
  assert(
    ownSecretary.text?.includes('secretary-session'),
    '接管: 秘书会话不能被接管',
    ownSecretary
  );

  log('== 接管：会话界面入口');
  const granted = await page(`
    const id = ${JSON.stringify(ownId)};
    S().selectConversation(id);
    const visible = (selector) =>
      [...document.querySelectorAll(selector)].filter((node) => node.offsetParent !== null);
    const button = await until(() => visible('[data-enso=secretary-takeover-grant]')[0] ?? null, 15000);
    if (!button) return JSON.stringify({ ok: false, error: 'no grant button' });
    button.click();
    const chip = await until(() => visible('[data-enso=secretary-takeover-chip]')[0] ?? null, 15000);
    return JSON.stringify({
      ok: Boolean(chip),
      chip: chip?.innerText,
      badge: visible('[data-enso=secretary-takeover]').length,
    });
  `);
  assert(granted.ok, '接管: 会话顶栏点「交给秘书接管」后显示接管中', granted);
  assert(granted.badge >= 1, '接管: 侧栏显示「秘书接管中」', granted);
  await cdp.shot(path.join(ART, '07-takeover-chip.png'));
  const userGrant = readJson(dispatchFile).dispatched[ownId];
  assert(userGrant?.takeover?.via === 'user', '接管: 界面授权落盘，来源记 user', userGrant);
  const listed = await page(`
    return JSON.stringify(await window.electronAPI.secretary.listTakeovers());
  `);
  assert(
    listed.ok && listed.takeovers.some((entry) => entry.conversationId === ownId),
    '接管: 设置页清单里列出该会话',
    listed
  );
  const userRevoke = await page(`
    return JSON.stringify(await window.electronAPI.secretary.revokeTakeover(${JSON.stringify(ownId)}));
  `);
  assert(
    userRevoke.ok && !readJson(dispatchFile).dispatched[ownId],
    '接管: 界面授权可以撤销',
    userRevoke
  );

  log('== 接管：秘书提出 → 用户确认 → 发消息 → 撤销 → 再发被拒');
  const proposedTakeover = await secretaryTool(
    cdp,
    setup,
    'session_takeover_propose',
    { conversationId: ownId, reason: '帮你盯着这个会话' },
    '把用户的会话交给我接管'
  );
  assert(
    proposedTakeover.text?.includes('awaiting_confirmation'),
    '接管: 秘书提出接管只得到待确认',
    proposedTakeover
  );
  assert(!readJson(dispatchFile).dispatched[ownId], '接管: 确认前没有授权');
  const confirmedTakeover = await page(`
    const visible = (selector) =>
      [...document.querySelectorAll(selector)].filter((node) => node.offsetParent !== null);
    const card = await until(
      () => visible('[data-enso=secretary-proposal][data-kind=takeover]').at(-1) ?? null,
      30000
    );
    if (!card) return JSON.stringify({ ok: false, error: 'no takeover card' });
    const secretary = await SEC();
    const proposal = Object.values(secretary.getState().secretary.proposals)
      .filter((p) => p.kind === 'takeover')
      .at(-1);
    const cardText = card.innerText;
    card.querySelector('button').click();
    const done = await until(() => {
      const p = secretary.getState().secretary.proposals[proposal.id];
      return p && p.status !== 'pending' && p.status !== 'executing' ? p : null;
    }, 30000);
    return JSON.stringify({ ok: true, cardText, status: done?.status, error: done?.error });
  `);
  assert(
    confirmedTakeover.ok && confirmedTakeover.cardText.includes('帮你盯着这个会话'),
    '接管: 聊天里出现接管确认卡',
    confirmedTakeover
  );
  await cdp.shot(path.join(ART, '08-takeover-card.png'));
  assert(confirmedTakeover.status === 'succeeded', '接管: 用户确认后接管生效', confirmedTakeover);
  const proposalGrant = readJson(dispatchFile).dispatched[ownId];
  assert(proposalGrant?.takeover?.via === 'proposal', '接管: 确认卡授权落盘', proposalGrant);

  const sentByTakeover = await secretaryTool(
    cdp,
    setup,
    'session_send',
    { conversationId: ownId, message: '秘书接手：请回一句收到' },
    '给接管的会话发消息'
  );
  assert(
    /"status":"(sent|queued)"/u.test(sentByTakeover.text ?? ''),
    '接管: 秘书给接管的会话发消息成功',
    sentByTakeover
  );
  const arrived = await page(`
    const hit = await until(
      () => texts(${JSON.stringify(ownId)}).some((text) => text.includes('秘书接手：请回一句收到')),
      30000
    );
    return JSON.stringify({ arrived: Boolean(hit) });
  `);
  assert(arrived.arrived, '接管: 目标会话收到秘书的消息', arrived);
  const pushed = await page(`
    const secretaryId = ${JSON.stringify(proposedTakeover.secretaryId)};
    const target = ${JSON.stringify(ownId)};
    const hit = await until(
      () => texts(secretaryId).find(
        (text) =>
          text.startsWith('<session-updates>') && text.includes('[turn-ended session:' + target + ']')
      ),
      60000
    );
    return JSON.stringify({ received: Boolean(hit), update: hit ?? null });
  `);
  assert(
    pushed.received,
    '接管: 接管的会话跑完一轮后像派出会话一样回传给提出接管的秘书会话',
    pushed
  );
  log(`  ${pushed.update?.slice(0, 300)}`);

  const revoked = await page(`
    const id = ${JSON.stringify(ownId)};
    S().selectConversation(id);
    const visible = (selector) =>
      [...document.querySelectorAll(selector)].filter((node) => node.offsetParent !== null);
    const button = await until(() => visible('[data-enso=secretary-takeover-revoke]')[0] ?? null, 15000);
    if (!button) return JSON.stringify({ ok: false, error: 'no revoke button' });
    button.click();
    const back = await until(() => visible('[data-enso=secretary-takeover-grant]')[0] ?? null, 15000);
    return JSON.stringify({ ok: Boolean(back) });
  `);
  assert(revoked.ok, '接管: 会话顶栏点 × 撤销后恢复成可交给秘书', revoked);
  assert(!readJson(dispatchFile).dispatched[ownId], '接管: 撤销后授权从盘上删除');

  const refusedSend = await secretaryTool(
    cdp,
    setup,
    'session_send',
    { conversationId: ownId, message: '撤销后还想再发' },
    '撤销后再给它发消息'
  );
  assert(
    refusedSend.text?.includes('not-operable') &&
      refusedSend.text.includes('session_takeover_propose'),
    '接管: 撤销后秘书再发消息被拒，并提示可以申请接管',
    refusedSend
  );

  const audit = auditLines().filter(
    (entry) => entry.targetId === ownId || entry.op === 'session_takeover_propose'
  );
  const count = (op, ok, detail) =>
    audit.filter(
      (entry) =>
        entry.op === op && entry.ok === ok && (detail === undefined || entry.detail === detail)
    ).length;
  assert(
    count('takeover_grant', true, 'user') === 1 &&
      count('takeover_grant', true, 'proposal') === 1 &&
      count('takeover_revoke', true) === 2 &&
      count('session_takeover_propose', true) >= 1 &&
      count('session_send', true) === 1 &&
      count('session_send', false, 'not-operable') === 1 &&
      count('session_stop', false, 'not-operable') === 1,
    '接管: 授权、撤销与秘书发的每条消息都有审计',
    audit
  );
}

process.on('SIGINT', () => {
  log('\nSIGINT, cleaning up');
  void finish(130);
});
process.on('SIGTERM', () => {
  log('\nSIGTERM, cleaning up');
  void finish(143);
});
process.on('uncaughtException', (error) => {
  console.error(error);
  void finish(1);
});
process.on('unhandledRejection', (error) => {
  console.error(error);
  void finish(1);
});

main()
  .then(async () => {
    log(`\n== ${results.filter((entry) => entry.ok).length}/${results.length} checks passed`);
    await finish(0);
  })
  .catch(async (error) => {
    console.error(`\nFAIL ${error.message}`);
    for (const { name, chunks } of children) {
      if (chunks.length === 0) continue;
      console.error(`--- ${name} output (tail) ---`);
      console.error(chunks.join('').slice(-2000));
    }
    await finish(1);
  });
