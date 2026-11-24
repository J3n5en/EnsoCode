#!/usr/bin/env node
// 对象认领 + 需求线程真机验收。隔离 userData、假模型和假 Telegram，不碰真实账号。
//   node scripts/verify-event-claim-threads.mjs [--keep]
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { uiElementElectron } from './verify-electron.mjs';
import {
  explicitPort,
  keepRequested,
  mergeOwnedPids,
  ownedProcessGroups,
  reservePorts,
} from './verify-secretary-isolation.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const ART = mkdtempSync('/tmp/claim-thread-verify-');
const ENV = `${ART}-env`;
const PLUGIN_ID = 'enso.claimthread';
const CHAT_ID = -100777888;
const OWNER_ID = 42001;
const ORIGIN_MESSAGE_ID = 777;
const CLAIM_KEY = `tg:${CHAT_ID}:${ORIGIN_MESSAGE_ID}`;
const REPO_NAME = 'J3n5en/EnsoCode';
const PR_NUMBER = 123;
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const CLAIM_TEXT = 'CLAIM-777-ONLY-A 登录超时';
const COMMENT_TEXT = 'COMMENT-EXTERNAL-123 登录超时还在';
const KEEP = keepRequested(process.env, process.argv);

const settingsFile = path.join(ENV, 'settings.json');
const children = [];
const results = [];
let CDP_PORT = 0;
let FAKE_PORT = 0;
let PLUGIN_PORT = 0;
let RENDERER_PORT = 0;
let TG_PORT = 0;
let GH_PORT = 0;
let portLease = null;
let githubLease = null;
let pluginServer = null;
let telegram = null;
let github = null;
const trackedPids = [];

const log = (message) => console.log(message);
const step = (message) => log(`[${new Date().toISOString()}] STEP: ${message}`);
const sleep = (ms) => delay(ms);

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
  await githubLease?.close();
  githubLease = null;
  pluginServer?.close();
  pluginServer = null;
  telegram?.server?.close();
  telegram = null;
  github?.server?.close();
  github = null;
  for (const { name, child } of [...children].reverse()) {
    log(`  stopped ${name} (${child.pid ?? 'not-started'})`);
  }
  signalOwned('SIGTERM');
  await sleep(1500);
  signalOwned('SIGKILL');
  await sleep(200);
}

function removeIsolateDirs() {
  rmSync(ENV, { recursive: true, force: true });
  rmSync(`${ENV}-proj`, { recursive: true, force: true });
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

function writePlugin() {
  const dir = path.join(ART, 'plugin');
  mkdirSync(dir, { recursive: true });
  const control = `http://127.0.0.1:${PLUGIN_PORT}`;
  writeFileSync(
    path.join(dir, 'enso-plugin.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: PLUGIN_ID,
        name: 'Claim Thread Verify',
        version: '0.0.1',
        description: '隔离验收：认领、需求线程、假 GitHub 事件。',
        main: 'main.mjs',
        resident: true,
        permissions: ['agent.inject', 'net.fetch', 'process.background'],
        net: { domains: ['example.com'] },
      },
      null,
      2
    )
  );
  writeFileSync(
    path.join(dir, 'main.mjs'),
    `const CONTROL = ${JSON.stringify(control)};
async function handle(enso, job) {
  if (job.op === 'inject') return enso.session.inject(job.input);
  if (job.op === 'claims.list') return enso.claims.list(job.filter ?? {});
  if (job.op === 'claims.renew') return enso.claims.renew(job.key, job.sessionId);
  if (job.op === 'claims.release') return enso.claims.release(job.key, job.sessionId);
  if (job.op === 'threads.open') return enso.threads.open(job.input);
  if (job.op === 'threads.bindPr') return enso.threads.bindPr(job.target, job.pr);
  if (job.op === 'threads.list') return enso.threads.list(job.filter ?? {});
  if (job.op === 'threads.routePrEvent') {
    const response = await fetch(job.github + '/repos/' + job.event.repo + '/pulls/' + job.event.number);
    const meta = await response.json();
    return {
      pr: { status: response.status, number: meta.number ?? null, title: meta.title ?? null },
      route: await enso.threads.routePrEvent(job.event),
    };
  }
  return { error: 'unknown op ' + job.op };
}
export function activate(enso) {
  let cursor = 0;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch(CONTROL + '/jobs?after=' + cursor);
      const body = await response.json();
      for (const job of body.jobs ?? []) {
        cursor = job.id;
        let result;
        try {
          result = await handle(enso, job);
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) };
        }
        await fetch(CONTROL + '/results', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: job.id, result: result ?? null }),
        });
      }
    } finally {
      busy = false;
    }
  };
  setInterval(() => { void tick(); }, 200);
  void fetch(CONTROL + '/ready', { method: 'POST' });
}
`
  );
  return dir;
}

function packZip(source) {
  const target = path.join(ART, 'claim-thread-plugin.zip');
  return new Promise((resolve, reject) => {
    const child = spawn('zip', ['-qr', target, '.'], { cwd: source, stdio: 'ignore' });
    child.on('exit', (code) =>
      code === 0 ? resolve(target) : reject(new Error(`zip exited ${code}`))
    );
  });
}

async function servePlugin(zipPath) {
  const zip = readFileSync(zipPath);
  const jobs = [];
  const pending = new Map();
  let seq = 0;
  let ready = false;
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const reply = (status, body, type = 'application/json') => {
        response.writeHead(status, { 'Content-Type': type });
        response.end(body);
      };
      if (request.method === 'GET' && url.pathname === '/claim-thread-plugin.zip') {
        reply(200, zip, 'application/zip');
        return;
      }
      if (request.method === 'POST' && url.pathname === '/ready') {
        ready = true;
        reply(200, '{"ok":true}');
        return;
      }
      if (request.method === 'GET' && url.pathname === '/jobs') {
        const after = Number(url.searchParams.get('after') || 0);
        reply(200, JSON.stringify({ jobs: jobs.filter((job) => job.id > after) }));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/results') {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          body = {};
        }
        const resolve = pending.get(body.id);
        if (resolve) {
          pending.delete(body.id);
          resolve(body.result);
        }
        reply(200, '{"ok":true}');
        return;
      }
      reply(404, '{"ok":false}');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PLUGIN_PORT, '127.0.0.1', resolve);
  });
  pluginServer = server;
  return {
    ready: () => ready,
    call(job, timeoutMs = 45_000) {
      const id = ++seq;
      jobs.push({ id, ...job });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`plugin job ${job.op} timed out`));
        }, timeoutMs);
        pending.set(id, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
      });
    },
  };
}

async function startFakeTelegram(port) {
  const state = {
    token: TOKEN,
    me: { id: 424242, is_bot: true, username: 'enso_verify_bot', first_name: 'Enso Verify' },
    sent: [],
    queue: [],
    waiters: [],
    polls: 0,
  };
  const push = (update) => {
    const waiter = state.waiters.shift();
    if (waiter) waiter([update]);
    else state.queue.push(update);
  };
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let done = false;
      const reply = (payload) => {
        if (done) return;
        done = true;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
      if (!match) {
        reply({ ok: false, error_code: 404, description: 'Not Found' });
        return;
      }
      const [, token, method] = match;
      if (token !== state.token) {
        reply({ ok: false, error_code: 401, description: 'Unauthorized' });
        return;
      }
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        body = {};
      }
      if (method === 'getMe') {
        reply({ ok: true, result: state.me });
        return;
      }
      if (method === 'getUpdates') {
        state.polls += 1;
        if (state.queue.length > 0) {
          reply({ ok: true, result: state.queue.splice(0) });
          return;
        }
        const waiter = (updates) => reply({ ok: true, result: updates });
        state.waiters.push(waiter);
        const timer = setTimeout(() => {
          state.waiters = state.waiters.filter((entry) => entry !== waiter);
          reply({ ok: true, result: [] });
        }, 2000);
        response.on('close', () => {
          clearTimeout(timer);
          state.waiters = state.waiters.filter((entry) => entry !== waiter);
        });
        return;
      }
      if (method === 'sendMessage') {
        const messageId = state.sent.length + 1;
        state.sent.push({ ...body, message_id: messageId });
        reply({ ok: true, result: { message_id: messageId, chat: { id: body.chat_id } } });
        return;
      }
      if (
        method === 'sendChatAction' ||
        method === 'setMyCommands' ||
        method === 'deleteMyCommands' ||
        method === 'setChatMenuButton' ||
        method === 'answerCallbackQuery' ||
        method === 'editMessageText' ||
        method === 'editMessageReplyMarkup'
      ) {
        reply({ ok: true, result: true });
        return;
      }
      reply({ ok: false, error_code: 400, description: `Unsupported method ${method}` });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { state, push, server };
}

async function startFakeGithub(port) {
  const state = { requests: [], events: [] };
  const pr = {
    number: PR_NUMBER,
    title: '修登录超时',
    state: 'open',
    html_url: `http://127.0.0.1:${port}/${REPO_NAME}/pull/${PR_NUMBER}`,
    head: { sha: 'abc1234' },
    user: { login: 'J3n5en' },
  };
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const body = Buffer.concat(chunks).toString('utf8');
      state.requests.push({ method: request.method || 'GET', path: url.pathname, body });
      const reply = (payload) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (request.method === 'GET' && url.pathname === `/repos/${REPO_NAME}/pulls/${PR_NUMBER}`) {
        reply(pr);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/events') {
        reply({ events: state.events });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/events') {
        state.events.push(JSON.parse(body || '{}'));
        reply({ ok: true });
        return;
      }
      reply({ ok: true, id: state.requests.length });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { state, server };
}

const PRELUDE = `
const S = () => window.__stores.sessions.getState();
const SET = () => window.__stores.settings.getState();
const SEC = async () => (await import('/stores/secretary.ts')).useSecretaryStore;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); }
  return null;
};
const transcript = (id) => (S().conversations[id]?.messages ?? []).map((message) => {
  if (typeof message?.content === 'string') return message.content;
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}).join('\\n');
`;

async function connect(entry = 'index.html') {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const target = list.find((page) => page.type === 'page' && page.url.includes(entry));
  if (!target?.webSocketDebuggerUrl) throw new Error(`no CDP page for ${entry}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const pending = new Map();
  let id = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
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
    close: () => socket.close(),
    async json(body) {
      const raw = await evaluate(`(async () => { ${PRELUDE} ${body} })()`);
      return raw === undefined ? undefined : JSON.parse(raw);
    },
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
  const settings = readJson(settingsFile);
  settings['enso-settings'].state.secretaryEnabled = true;
  for (const provider of settings['enso-settings'].state.providers ?? []) {
    provider.baseUrl = `http://127.0.0.1:${FAKE_PORT}`;
  }
  writeFileSync(settingsFile, JSON.stringify(settings));
  const project = `${ENV}-proj`;
  const git = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: project, stdio: 'ignore' });
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} ${code}`))
      );
    });
  await git(['init', '-q']);
  await git(['add', '-A']);
  await git(['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init']);
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
            page = await connect('index.html');
            targetId = target.id;
            streak = 0;
          }
          const ready = await page.json(`
            return JSON.stringify(Boolean(
              window.__stores?.settings?.getState &&
              window.__stores?.sessions?.getState &&
              window.electronAPI?.settings?.read &&
              document.readyState === 'complete' &&
              document.getElementById('root')
            ));
          `);
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

function groupMessages() {
  return telegram.state.sent.filter((message) => Number(message.chat_id) === CHAT_ID);
}

function repliesToOrigin(includes) {
  return groupMessages().filter(
    (message) =>
      Number(message.reply_to_message_id) === ORIGIN_MESSAGE_ID &&
      String(message.text ?? '').includes(includes)
  );
}

function githubCommentWrites() {
  return github.state.requests.filter(
    (request) => request.method === 'POST' && /\/comments(?:\/|$)/.test(request.path)
  );
}

async function run(cdp, plugin) {
  const page = cdp.json.bind(cdp);
  const githubBase = `http://127.0.0.1:${GH_PORT}`;
  const projectPath = `${ENV}-proj`;

  step('隔离实例里建项目和秘书');
  const setup = await page(`
    const ready = await until(
      () => Boolean(window.__stores?.settings?.getState && window.__stores?.sessions?.getState && window.electronAPI?.settings),
      30000
    );
    if (!ready) return JSON.stringify({ ok: false, error: 'renderer stores not ready' });
    await until(() => SET().projects.some((p) => p.kind === 'secretary'), 30000);
    const project = await SET().addProject(${JSON.stringify(projectPath)});
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
    if (!saved.ok) return JSON.stringify({ ok: false, error: saved.error });
    const secretary = await SEC();
    const secretaryId = secretary.getState().focusedId;
    const conversationId = await secretary.getState().newSecretaryConversation();
    return JSON.stringify({
      ok: Boolean(project?.id && conversationId && secretaryId),
      projectId: project?.id ?? null,
      secretaryId,
      conversationId,
    });
  `);
  assert(setup.ok, 'setup: 隔离项目与秘书会话', setup);

  step('绑定假 Telegram：主人私聊 /start，再把测试群 /bind 进路由');
  const bound = await page(`
    const result = await window.electronAPI.secretary.contactBind(
      ${JSON.stringify(TOKEN)},
      ${JSON.stringify(setup.secretaryId)}
    );
    if (!result.ok) return JSON.stringify(result);
    const state = await window.electronAPI.secretary.contactState(${JSON.stringify(setup.secretaryId)});
    return JSON.stringify({ ok: true, code: state.telegram?.bind?.code ?? null });
  `);
  assert(bound.ok && bound.code, 'telegram: 拿到绑定码', bound);
  telegram.push({
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: OWNER_ID, type: 'private' },
      from: { id: OWNER_ID, username: 'j3n5en', first_name: 'J哥' },
      text: `/start ${bound.code}`,
    },
  });
  await waitFor(
    async () => {
      const state = await page(`
        const current = await window.electronAPI.secretary.contactState(${JSON.stringify(setup.secretaryId)});
        return JSON.stringify(current.telegram?.status ?? null);
      `);
      return state === 'bound' ? state : null;
    },
    'owner bound',
    20_000
  );
  const rebound = await page(`
    const result = await window.electronAPI.secretary.contactBind(
      undefined,
      ${JSON.stringify(setup.secretaryId)}
    );
    if (!result.ok) return JSON.stringify(result);
    const state = await window.electronAPI.secretary.contactState(${JSON.stringify(setup.secretaryId)});
    return JSON.stringify({ ok: true, code: state.telegram?.bind?.code ?? null });
  `);
  assert(
    rebound.ok && rebound.code && rebound.code !== bound.code,
    'telegram: 主人绑定后重新生成群绑定码',
    rebound
  );
  step(`假 Telegram 群 ${CHAT_ID} 收到原消息 ${ORIGIN_MESSAGE_ID}（主人 ${OWNER_ID}）`);
  const sentBeforeDemand = telegram.state.sent.length;
  telegram.push({
    update_id: 2,
    message: {
      message_id: ORIGIN_MESSAGE_ID,
      chat: { id: CHAT_ID, type: 'supergroup', title: '需求群' },
      from: { id: OWNER_ID, username: 'j3n5en', first_name: 'J哥' },
      text: '请修登录超时问题',
    },
  });
  await sleep(1200);
  assert(telegram.state.sent.length === sentBeforeDemand, 'telegram: 群还没绑定时不回复原消息', {
    sent: telegram.state.sent.length - sentBeforeDemand,
  });
  telegram.push({
    update_id: 3,
    message: {
      message_id: 3,
      chat: { id: CHAT_ID, type: 'supergroup', title: '需求群' },
      from: { id: OWNER_ID, username: 'j3n5en', first_name: 'J哥' },
      text: `/bind@enso_verify_bot ${rebound.code}`,
    },
  });
  await waitFor(
    async () => {
      const routes = await page(`
        const current = await window.electronAPI.secretary.contactState(${JSON.stringify(setup.secretaryId)});
        return JSON.stringify(current.telegram?.routes ?? []);
      `);
      return routes.some((route) => route.chatId === String(CHAT_ID)) ? routes : null;
    },
    'group route',
    20_000
  );
  assert(true, 'telegram: 测试群已进路由，可以回复原消息');

  step('创建会话 A 与会话 B');
  const sessions = await page(`
    const project = SET().projects.find((item) => item.id === ${JSON.stringify(setup.projectId)});
    const open = async (title) => {
      const id = await S().newConversation(${JSON.stringify(setup.projectId)});
      await S().send(
        title,
        { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
        undefined,
        id
      );
      const reply = await until(() => {
        const messages = S().conversations[id]?.messages ?? [];
        return messages.some((message) => message.role === 'assistant') ? true : null;
      }, 40000);
      return reply ? id : null;
    };
    const sessionA = await open('会话 A 就绪');
    const sessionB = await open('会话 B 就绪');
    return JSON.stringify({ ok: Boolean(sessionA && sessionB), sessionA, sessionB });
  `);
  assert(sessions.ok, 'T1: 会话 A 与会话 B 已就绪', sessions);
  step(`会话 A=${sessions.sessionA} 会话 B=${sessions.sessionB}`);

  step('安装常驻测试插件并打开跨会话注入');
  const installed = await page(`
    const staged = await window.electronAPI.extensionPlugins.stageFromUrl(${JSON.stringify(`http://127.0.0.1:${PLUGIN_PORT}/claim-thread-plugin.zip`)});
    if (!staged.ok) return JSON.stringify({ ok: false, error: staged.error, stage: staged });
    const committed = await window.electronAPI.extensionPlugins.commit(staged.preview.token);
    if (!committed.ok) return JSON.stringify({ ok: false, error: committed.error });
    const enabled = await window.electronAPI.extensionPlugins.setEnabled(${JSON.stringify(PLUGIN_ID)}, true);
    if (!enabled.ok) return JSON.stringify({ ok: false, error: enabled.error });
    const cross = await window.electronAPI.extensionPlugins.setCrossSessionInject(${JSON.stringify(PLUGIN_ID)}, true);
    if (!cross.ok) return JSON.stringify({ ok: false, error: cross.error });
    const listed = (await window.electronAPI.extensionPlugins.list()).find((plugin) => plugin.id === ${JSON.stringify(PLUGIN_ID)});
    return JSON.stringify({
      ok: listed?.state === 'enabled' && listed?.crossSessionInject === true,
      state: listed?.state ?? null,
      running: listed?.running ?? null,
      crossSessionInject: listed?.crossSessionInject ?? null,
      lastError: listed?.lastError ?? null,
    });
  `);
  assert(installed.ok, 'plugin: 已启用且允许跨会话注入', installed);
  await waitFor(async () => (plugin.ready() ? true : null), 'plugin ready', 20_000);
  step('测试插件已连上控制端口');

  const pluginCall = async (label, job) => {
    const result = await plugin.call(job);
    if (result && typeof result === 'object' && result.error) {
      throw new Error(`${label}: ${result.error}`);
    }
    return result;
  };
  const textOf = async (sessionId) =>
    page(`return JSON.stringify(transcript(${JSON.stringify(sessionId)}));`);

  step('同一需求对象同时投给 A 和 B');
  const claimed = await pluginCall('claim A', {
    op: 'inject',
    input: {
      text: CLAIM_TEXT,
      sessionId: sessions.sessionA,
      claimKey: CLAIM_KEY,
      claimLabel: '修登录超时',
      deliverAs: 'followUp',
      triggerTurn: false,
    },
  });
  const skipped = await pluginCall('claim B', {
    op: 'inject',
    input: {
      text: CLAIM_TEXT,
      sessionId: sessions.sessionB,
      claimKey: CLAIM_KEY,
      deliverAs: 'followUp',
      triggerTurn: false,
    },
  });
  await waitFor(
    async () => ((await textOf(sessions.sessionA)).includes(CLAIM_TEXT) ? true : null),
    'session A claim text',
    20_000
  );
  await sleep(600);
  const textB = await textOf(sessions.sessionB);
  assert(
    claimed?.delivered === true && claimed.ownerSessionId === sessions.sessionA,
    'T2: 会话 A 认领成功并收到注入',
    claimed
  );
  assert(
    skipped?.delivered === false && skipped?.status === 'held-by-other',
    'T2: 会话 B 被跳过（宿主把 skipped 收成 held-by-other）',
    skipped
  );
  assert(!textB.includes(CLAIM_TEXT), 'T2: 会话 B 对话里没有这条消息', textB.slice(-400));
  const listedClaims = await pluginCall('claims.list', { op: 'claims.list', filter: {} });
  const owned = (Array.isArray(listedClaims) ? listedClaims : []).find(
    (claim) => claim.key === CLAIM_KEY
  );
  assert(owned?.sessionId === sessions.sessionA, 'T2: claims.list 显示认领属于会话 A', owned);
  const renewed = await pluginCall('claims.renew', {
    op: 'claims.renew',
    key: CLAIM_KEY,
    sessionId: sessions.sessionA,
  });
  assert(renewed?.sessionId === sessions.sessionA, 'T2: 会话 A 续租成功', renewed);
  const released = await pluginCall('claims.release', {
    op: 'claims.release',
    key: CLAIM_KEY,
    sessionId: sessions.sessionA,
  });
  assert(released === true, 'T2: 会话 A 释放认领', released);
  const moved = await pluginCall('claim move', {
    op: 'inject',
    input: {
      text: 'CLAIM-777-MOVED-B',
      sessionId: sessions.sessionB,
      claimKey: CLAIM_KEY,
      deliverAs: 'followUp',
      triggerTurn: false,
    },
  });
  assert(
    moved?.delivered === true && moved.ownerSessionId === sessions.sessionB,
    'T2: 释放后对象转到会话 B',
    moved
  );
  await pluginCall('release B', {
    op: 'claims.release',
    key: CLAIM_KEY,
    sessionId: sessions.sessionB,
  });
  const restored = await pluginCall('claim restore', {
    op: 'inject',
    input: {
      text: 'CLAIM-777-RESTORED-A',
      sessionId: sessions.sessionA,
      claimKey: CLAIM_KEY,
      deliverAs: 'followUp',
      triggerTurn: false,
    },
  });
  assert(restored?.delivered === true, 'T2: 认领回到会话 A', restored);

  step('打开群需求线程并核验主人');
  const opened = await pluginCall('threads.open', {
    op: 'threads.open',
    input: {
      source: {
        channel: 'telegram',
        chatId: String(CHAT_ID),
        messageId: String(ORIGIN_MESSAGE_ID),
        senderId: String(OWNER_ID),
        senderName: 'J哥',
        summary: '修登录超时',
      },
      sessionId: sessions.sessionA,
    },
  });
  assert(opened?.requesterIsOwner === true, 'T3: 主人消息 requesterIsOwner === true', opened);
  const external = await pluginCall('threads.open external', {
    op: 'threads.open',
    input: {
      source: {
        channel: 'telegram',
        chatId: String(CHAT_ID),
        messageId: '778',
        senderId: '99999',
        senderName: '外人',
        summary: '外部需求',
      },
      sessionId: sessions.sessionB,
    },
  });
  assert(external?.requesterIsOwner === false, 'T3: 外部用户 requesterIsOwner === false', external);

  step('绑定假 GitHub PR 并路由 pr_opened');
  const boundPr = await pluginCall('threads.bindPr', {
    op: 'threads.bindPr',
    target: { threadId: opened.id },
    pr: {
      repo: REPO_NAME,
      number: PR_NUMBER,
      title: '修登录超时',
      url: `${githubBase}/${REPO_NAME}/pull/${PR_NUMBER}`,
      headSha: 'abc1234',
    },
  });
  assert(boundPr?.pr?.number === PR_NUMBER, 'T4: 线程绑上 PR #123', boundPr);
  const beforeOpen = groupMessages().length;
  const openedEvent = await pluginCall('pr_opened', {
    op: 'threads.routePrEvent',
    github: githubBase,
    event: {
      repo: REPO_NAME,
      number: PR_NUMBER,
      kind: 'pr_opened',
      text: 'PR-OPENED-123 已开',
      title: '修登录超时',
      url: `${githubBase}/${REPO_NAME}/pull/${PR_NUMBER}`,
      summary: '修登录超时',
    },
  });
  assert(
    openedEvent?.pr?.status === 200 && openedEvent.route?.delivered === true,
    'T4: 插件读到假 PR 且只注入负责会话',
    openedEvent
  );
  assert(openedEvent.route.milestonePushed === true, 'T4: PR 打开里程碑已回群', openedEvent.route);
  await waitFor(
    async () => ((await textOf(sessions.sessionA)).includes('PR-OPENED-123') ? true : null),
    'session A pr opened',
    20_000
  );
  await sleep(500);
  assert(
    !(await textOf(sessions.sessionB)).includes('PR-OPENED-123'),
    'T4: 会话 B 没有 PR 打开注入'
  );
  const openedReply = await waitFor(
    () => repliesToOrigin('PR 已开')[0] ?? null,
    'telegram pr opened',
    15_000
  );
  assert(
    openedReply.allow_sending_without_reply === true && groupMessages().length === beforeOpen + 1,
    'T4: 群里只多一条回复 777 的「PR 已开」',
    openedReply
  );

  step('PR 普通评论：只进负责会话，不回群，不写回 GitHub');
  const writesBeforeComment = githubCommentWrites().length;
  const sentBeforeComment = groupMessages().length;
  github.state.events.push({
    kind: 'comment',
    user: 'reviewer-bot',
    body: COMMENT_TEXT,
  });
  const comment = await pluginCall('comment', {
    op: 'threads.routePrEvent',
    github: githubBase,
    event: {
      repo: REPO_NAME,
      number: PR_NUMBER,
      kind: 'comment',
      text: COMMENT_TEXT,
      sender: { channel: 'github', userId: 'reviewer-bot', displayName: 'reviewer-bot' },
    },
  });
  assert(
    comment.route?.delivered === true && comment.route.milestonePushed === false,
    'T5: 评论注入负责会话且不是里程碑',
    comment.route
  );
  await waitFor(
    async () => ((await textOf(sessions.sessionA)).includes(COMMENT_TEXT) ? true : null),
    'session A comment',
    20_000
  );
  const commentText = await textOf(sessions.sessionA);
  assert(
    commentText.includes('role="external"') && commentText.includes('<untrusted-content'),
    'T5: 外部评论带不可信包装',
    commentText.slice(
      commentText.indexOf(COMMENT_TEXT) - 180,
      commentText.indexOf(COMMENT_TEXT) + 80
    )
  );
  await sleep(800);
  assert(!(await textOf(sessions.sessionB)).includes(COMMENT_TEXT), 'T5: 会话 B 没有这条评论');
  assert(groupMessages().length === sentBeforeComment, 'T5: 假 Telegram 没有新消息', {
    before: sentBeforeComment,
    after: groupMessages().length,
  });
  assert(
    githubCommentWrites().length === writesBeforeComment,
    'T5: 假 GitHub 没有反向写评论',
    githubCommentWrites()
  );

  step('同一 headSha 的 CI 失败只回群一次');
  const ciEvent = {
    repo: REPO_NAME,
    number: PR_NUMBER,
    kind: 'ci_failed',
    text: 'CI-FAILED-abc1234',
    headSha: 'abc1234',
    summary: '登录测试失败',
  };
  const firstCi = await pluginCall('ci 1', {
    op: 'threads.routePrEvent',
    github: githubBase,
    event: ciEvent,
  });
  const secondCi = await pluginCall('ci 2', {
    op: 'threads.routePrEvent',
    github: githubBase,
    event: { ...ciEvent, text: 'CI-FAILED-abc1234-AGAIN' },
  });
  assert(firstCi.route?.milestonePushed === true, 'T6: 第一次 CI 失败回群', firstCi.route);
  assert(
    secondCi.route?.milestonePushed === false,
    'T6: 同一 headSha 第二次不回群',
    secondCi.route
  );
  await waitFor(
    async () => ((await textOf(sessions.sessionA)).includes('CI-FAILED-abc1234') ? true : null),
    'session A ci',
    20_000
  );
  await sleep(800);
  const ciReplies = repliesToOrigin('CI 失败');
  assert(ciReplies.length === 1, 'T6: 群里只有一条回复 777 的「CI 失败」', ciReplies);
  assert(
    ciReplies[0].allow_sending_without_reply === true,
    'T6: CI 失败回复允许原消息已不在',
    ciReplies[0]
  );

  step('PR 合并里程碑回复原消息');
  const merged = await pluginCall('merged', {
    op: 'threads.routePrEvent',
    github: githubBase,
    event: {
      repo: REPO_NAME,
      number: PR_NUMBER,
      kind: 'merged',
      text: 'MERGED-123',
      summary: '已合并',
    },
  });
  assert(merged.route?.milestonePushed === true, 'T7: 合并里程碑已回群', merged.route);
  const mergedReply = await waitFor(
    () => repliesToOrigin('已合并')[0] ?? null,
    'telegram merged',
    15_000
  );
  assert(
    Number(mergedReply.reply_to_message_id) === ORIGIN_MESSAGE_ID &&
      mergedReply.allow_sending_without_reply === true,
    'T7: 「已合并」回复原消息 777',
    mergedReply
  );
  const threads = await pluginCall('threads.list', {
    op: 'threads.list',
    filter: { repo: REPO_NAME },
  });
  const mergedThread = (Array.isArray(threads) ? threads : []).find(
    (thread) => thread.id === opened.id
  );
  assert(mergedThread?.status === 'merged', 'T7: 线程状态变为 merged', mergedThread);
  assert(
    githubCommentWrites().length === 0,
    'T7: 群消息没有镜像成 GitHub 评论',
    githubCommentWrites()
  );

  step('看板能看到已合并的需求线程');
  const board = await page(`
    const fresh = await window.electronAPI.secretary.getState(${JSON.stringify(setup.secretaryId)});
    const store = window.__stores.secretary;
    store.setState((current) => ({
      states: { ...current.states, [${JSON.stringify(setup.secretaryId)}]: fresh },
      secretary: fresh,
      focusedId: ${JSON.stringify(setup.secretaryId)},
    }));
    S().selectConversation(${JSON.stringify(setup.conversationId)});
    await sleep(300);
    const toggles = [...document.querySelectorAll('button')].filter(
      (button) => button.getAttribute('aria-label') === '新建标签页' && button.offsetParent !== null
    );
    toggles.at(-1)?.click();
    const item = await until(() => document.querySelector('[data-enso=secretary-panel-open]'), 5000);
    item?.click();
    await sleep(500);
    document.querySelector('[data-enso=secretary-panel-tab][data-tab=workbench]')?.click();
    await sleep(400);
    const node = document.querySelector('[data-enso=secretary-threads]');
    return JSON.stringify({
      threads: fresh.board?.threads ?? [],
      dom: node?.innerText ?? null,
    });
  `);
  const threadOnBoard = (board.threads ?? []).find(
    (thread) => thread.pr?.number === PR_NUMBER && thread.status === 'merged'
  );
  assert(Boolean(threadOnBoard), 'T8: secretaryState.board.threads 有 PR #123 且 merged', {
    threads: board.threads,
  });
  assert(
    typeof board.dom === 'string' && board.dom.includes('#123') && board.dom.includes('merged'),
    'T8: 看板 DOM data-enso=secretary-threads 可见 #123 与 merged',
    board.dom
  );
  step('全部断言通过');
}

async function main() {
  portLease = await reservePorts(
    {
      cdp: explicitPort('SEC_VERIFY_CDP_PORT', process.env.SEC_VERIFY_CDP_PORT),
      fake: explicitPort('SEC_VERIFY_FAKE_PORT', process.env.SEC_VERIFY_FAKE_PORT),
      plugin: explicitPort('SEC_VERIFY_PLUGIN_PORT', process.env.SEC_VERIFY_PLUGIN_PORT),
      renderer: explicitPort('SEC_VERIFY_RENDERER_PORT', process.env.SEC_VERIFY_RENDERER_PORT),
      telegram: explicitPort('SEC_VERIFY_TG_PORT', process.env.SEC_VERIFY_TG_PORT),
    },
    listenLoopback
  );
  githubLease = await listenLoopback(0);
  CDP_PORT = portLease.ports.cdp;
  FAKE_PORT = portLease.ports.fake;
  PLUGIN_PORT = portLease.ports.plugin;
  RENDERER_PORT = portLease.ports.renderer;
  TG_PORT = portLease.ports.telegram;
  GH_PORT = githubLease.port;
  step('隔离环境');
  log(`  dir: ${ART}`);
  log(`  env: ${ENV}`);
  log(
    `  ports: cdp=${CDP_PORT} fake=${FAKE_PORT} plugin=${PLUGIN_PORT} renderer=${RENDERER_PORT} telegram=${TG_PORT} github=${GH_PORT}`
  );
  await prepareEnv();
  await portLease.release('plugin');
  const plugin = await servePlugin(await packZip(writePlugin()));
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
  await portLease.release('telegram');
  telegram = await startFakeTelegram(TG_PORT);
  await githubLease.close();
  githubLease = null;
  github = await startFakeGithub(GH_PORT);
  await portLease.release('cdp');
  await portLease.release('renderer');
  start('dev', 'pnpm', ['dev'], {
    ENSO_USER_DATA_DIR: ENV,
    ENSO_CDP_PORT: String(CDP_PORT),
    ENSO_ELECTRON_DEBUG_PORT: String(CDP_PORT),
    ENSO_RENDERER_PORT: String(RENDERER_PORT),
    ENSO_VERIFY: '1',
    ENSO_ELECTRON_OFFSCREEN: '1',
    ELECTRON_EXEC_PATH: uiElementElectron(createRequire(import.meta.url)('electron')),
    ENSO_TELEGRAM_API_BASE: `http://127.0.0.1:${TG_PORT}`,
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
  const cdp = await waitForStableRenderer();
  try {
    await run(cdp, plugin);
  } finally {
    cdp.close();
  }
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
    console.error(`\nFAIL ${error instanceof Error ? error.message : String(error)}`);
    for (const { name, chunks } of children) {
      if (chunks.length === 0) continue;
      console.error(`--- ${name} output (tail) ---`);
      console.error(chunks.join('').slice(-2000));
    }
    await finish(1);
  });
