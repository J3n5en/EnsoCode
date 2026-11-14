#!/usr/bin/env node
// 秘书真机验收（U10）：派活 → 确认 → 回传 → 并发确认。
// 全程在隔离 userData 与 fake provider 上跑，不碰真实账号与真实数据。
//   node scripts/verify-secretary.mjs [--keep]
// 产物：/tmp/sec-u10/*.png 与 audit.jsonl
// 多个会话同时跑时各用一套端口与目录，例如：
//   SEC_VERIFY_DIR=/tmp/sec-u10-b SEC_VERIFY_CDP_PORT=9433 SEC_VERIFY_FAKE_PORT=8999 \
//   SEC_VERIFY_PLUGIN_PORT=8998 node scripts/verify-secretary.mjs
//
// 步骤编号沿用计划「真机验证脚本思路」，执行顺序按依赖排：
// 计划第 3 步（派活出卡片）先跑，第 1、2 步用它的会话断言。
// 计划第 1 步原本走 dev IPC `secretary:dev-create-session`；该入口已删除，
// 这里改用正常派活路径，落的是同一个 Main 建会话函数。
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const REPO = path.resolve(import.meta.dirname, '..');
const ART = process.env.SEC_VERIFY_DIR || '/tmp/sec-u10';
const ENV = `${ART}-env`;
const PROJ = `${ART}-proj`;
const CDP_PORT = Number(process.env.SEC_VERIFY_CDP_PORT || 9333);
const FAKE_PORT = Number(process.env.SEC_VERIFY_FAKE_PORT || 8899);
const PLUGIN_PORT = Number(process.env.SEC_VERIFY_PLUGIN_PORT || 8898);
const KEEP = process.argv.includes('--keep');

const settingsFile = path.join(ENV, 'settings.json');
const dispatchFile = path.join(ENV, 'secretary', 'dispatch.json');
const auditFile = path.join(ENV, 'secretary', 'audit.jsonl');
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

function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
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
  await new Promise((resolve) => server.listen(PLUGIN_PORT, '127.0.0.1', resolve));
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
  pluginServer?.close();
  for (const { name, child } of [...children].reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    log(`  stopped ${name} (${child.pid})`);
  }
  await delay(1500);
  for (const { child } of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // 已经退出
    }
  }
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
`;

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const target = list.find((entry) => entry.type === 'page' && entry.url.includes('index.html'));
  if (!target) throw new Error('main window page target not found');
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
  for (const provider of settings['enso-settings'].state.providers)
    provider.baseUrl = `http://127.0.0.1:${FAKE_PORT}`;
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
  log('== env');
  for (const port of [CDP_PORT, FAKE_PORT, PLUGIN_PORT]) {
    if (!(await portFree(port))) throw new Error(`port ${port} is already in use`);
  }
  await prepareEnv();
  const pluginZipUrl = await servePluginZip();

  log('== fake provider + dev');
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
  start('dev', 'pnpm', ['dev'], {
    ENSO_USER_DATA_DIR: ENV,
    ENSO_CDP_PORT: String(CDP_PORT),
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

  const cdp = await connect();
  try {
    await run(cdp, pluginZipUrl);
  } finally {
    cdp.close();
  }
}

async function run(cdp, pluginZipUrl) {
  const page = cdp.json.bind(cdp);

  // 主窗口首帧之前 __stores 还不存在，先等 renderer 起来
  await waitFor(
    async () => {
      try {
        return (
          (await cdp.evaluate(
            'typeof window.__stores === "object" && Boolean(window.__stores.sessions)'
          )) === true
        );
      } catch {
        return false;
      }
    },
    'renderer stores',
    60_000,
    500
  );

  log('== setup');
  const setup = await page(`
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
  assert(setup.ok, 'setup: 隔离实例里建出项目与秘书会话', setup);
  await cdp.shot(path.join(ART, '01-sidebar.png'));

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
    // 只认 skill 卡：缓存的其它会话里还留着更早的派活卡
    const card = await until(
      () => document.querySelector('[data-enso=secretary-proposal][data-kind=skill]'),
      30000
    );
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
    const card = await until(
      () => document.querySelector('[data-enso=secretary-proposal][data-kind=tool]'),
      30000
    );
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
    const card = await until(
      () => document.querySelector('[data-enso=secretary-proposal][data-kind=tool]'),
      30000
    );
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
        (text) => text.startsWith('<session-updates>') && text.includes(target)
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

main()
  .then(async () => {
    log(`\n== ${results.filter((entry) => entry.ok).length}/${results.length} checks passed`);
    if (!KEEP) await stopAll();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(`\nFAIL ${error.message}`);
    for (const { name, chunks } of children) {
      if (chunks.length === 0) continue;
      console.error(`--- ${name} output (tail) ---`);
      console.error(chunks.join('').slice(-2000));
    }
    if (!KEEP) await stopAll();
    process.exit(1);
  });
