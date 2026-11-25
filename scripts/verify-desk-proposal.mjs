#!/usr/bin/env node
// 远程 /desk 完整模式：秘书 skill_propose 确认卡能否点通。
//   node scripts/verify-desk-proposal.mjs [--keep]
// 截图：/tmp/desk-proposal-*.png。退出码：跑到确认结论为 0，没走到点击为 1。

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const KEEP = process.argv.includes('--keep');
const OUT = mkdtempSync(path.join(os.tmpdir(), 'enso-desk-proposal-'));
const USER_DATA = path.join(OUT, 'userData');
const PROJ = path.join(OUT, 'proj');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(PROJ, { recursive: true });

const HARD_TIMEOUT_MS = 180_000;
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(line) {
  console.log(line);
}

function shutdown(code) {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
  process.exit(code);
}

const hardTimeout = setTimeout(() => {
  console.error('hard timeout');
  shutdown(1);
}, HARD_TIMEOUT_MS);
hardTimeout.unref();

async function waitFor(fn, { timeout = 30_000, interval = 300, label = 'condition' } = {}) {
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
  throw new Error(
    `timeout waiting for ${label}${last instanceof Error ? `: ${last.message}` : last ? `: ${JSON.stringify(last).slice(0, 400)}` : ''}`
  );
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

class Cdp {
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`ws open failed ${wsUrl}`));
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
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp ${method} timeout`));
      }, 30_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
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
        result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)
      );
    }
    return result.result?.value;
  }

  async shot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const HEADLESS_SHELL = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
);

async function launchBrowser() {
  if (!existsSync(HEADLESS_SHELL)) throw new Error(`missing chromium ${HEADLESS_SHELL}`);
  const debugPort = await freePort();
  const userDir = mkdtempSync(path.join(os.tmpdir(), 'enso-desk-proposal-chrome-'));
  const logFd = openSync(path.join(OUT, 'chromium.log'), 'a');
  const child = spawn(
    HEADLESS_SHELL,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDir}`,
      '--window-size=390,844',
      '--force-device-scale-factor=1',
      '--disable-features=Animation',
      '--no-first-run',
      'about:blank',
    ],
    { stdio: ['ignore', logFd, logFd] }
  );
  children.push(child);
  const pageTarget = await waitFor(
    async () => {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      return list.find((t) => t.type === 'page');
    },
    { label: 'chromium page target' }
  );
  const cdp = await Cdp.open(pageTarget.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return cdp;
}

const FRAME_DOC = `(() => {
  const settings = document.querySelector('iframe.settings');
  if (settings?.contentDocument) return settings.contentDocument;
  const main = document.querySelector('iframe.main');
  if (main?.contentDocument) return main.contentDocument;
  return document;
})()`;

async function frame(cdp, source) {
  return cdp.eval(`(async () => {
    const doc = ${FRAME_DOC};
    const view = doc.defaultView;
    if (!view) return { error: 'no view' };
    try {
      return await (async () => {
        ${source}
      })();
    } catch (error) {
      return { error: String(error && error.stack ? error.stack : error) };
    }
  })()`);
}

async function nav(cdp, url) {
  await cdp.send('Page.navigate', { url });
}

function prepareProject() {
  writeFileSync(path.join(PROJ, 'README.md'), 'desk proposal target\n');
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: PROJ, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} ${result.status} ${result.stderr}`);
    }
  };
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init']);
}

function writeSettings(fakePort) {
  const projectId = randomUUID();
  const state = {
    providers: [
      {
        id: 'pv-A',
        name: 'Provider A',
        api: 'anthropic-messages',
        apiKey: 'sk-fake-A',
        baseUrl: `http://127.0.0.1:${fakePort}`,
        enabled: true,
        models: [{ id: 'fake-model-1' }],
      },
    ],
    defaultModel: { providerId: 'pv-A', modelId: 'fake-model-1' },
    onboarded: true,
    language: 'zh',
    secretaryEnabled: true,
    theme: 'system',
    projects: [{ id: projectId, name: 'desk-proposal', path: PROJ }],
  };
  writeFileSync(
    path.join(USER_DATA, 'settings.json'),
    JSON.stringify({ 'enso-settings': { state, version: 18 } })
  );
  return projectId;
}

const SKILL_DRAFT = {
  name: 'deploy-check',
  description: '发布前跑一遍',
  body: '# 步骤\n\n- 跑测试',
};
const SKILL_ASK = `派活 [[tool:skill_propose ${JSON.stringify(SKILL_DRAFT)}]]`;

async function main() {
  log(`out ${OUT}`);
  prepareProject();
  const fakePort = await freePort();
  const projectId = writeSettings(fakePort);
  log(`project ${projectId} ${PROJ}`);

  const fakeLog = openSync(path.join(OUT, 'fake.log'), 'a');
  const fake = spawn(process.execPath, [path.join(ROOT, 'scripts/fake-provider-issue-27.mjs')], {
    env: { ...process.env, FAKE_PROVIDER_PORT: String(fakePort) },
    stdio: ['ignore', fakeLog, fakeLog],
    cwd: ROOT,
  });
  children.push(fake);
  await waitFor(
    async () => {
      try {
        return (await fetch(`http://127.0.0.1:${fakePort}/__requests`)).ok;
      } catch {
        return false;
      }
    },
    { label: 'fake provider', timeout: 15_000 }
  );
  log(`fake provider ${fakePort}`);

  const webPort = await freePort();
  const serverLog = openSync(path.join(OUT, 'server.log'), 'a');
  const serverEnv = {
    ...process.env,
    ENSO_VERIFY: '1',
    ENSO_PACKAGED: '0',
    ENSO_DATA_DIR: USER_DATA,
  };
  delete serverEnv.ELECTRON_RUN_AS_NODE;
  const server = spawn(
    process.execPath,
    [
      path.join(ROOT, 'out/server/index.js'),
      'start',
      '--web-host',
      '127.0.0.1',
      '--web-port',
      String(webPort),
    ],
    { env: serverEnv, stdio: ['ignore', serverLog, serverLog], cwd: ROOT }
  );
  children.push(server);
  await waitFor(
    async () => {
      try {
        await fetch(`http://127.0.0.1:${webPort}/`);
        return true;
      } catch {
        return false;
      }
    },
    { timeout: 30_000, label: 'enso-server web' }
  );
  log(`enso-server 127.0.0.1:${webPort}`);

  const invite = await new Promise((resolve, reject) => {
    const pair = spawn(process.execPath, [path.join(ROOT, 'out/server/index.js'), 'pair'], {
      env: serverEnv,
      cwd: ROOT,
    });
    children.push(pair);
    let buf = '';
    const timer = setTimeout(() => reject(new Error('pair invite timeout')), 20_000);
    pair.stdout.on('data', (chunk) => {
      buf += chunk;
      const match = buf.match(/enso-pair:\/\/\S+|https?:\/\/[^\s#]+#\S+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0].replace(/[)\].,，。]+$/, ''));
      }
    });
    pair.on('error', reject);
  });
  log(`invite ${invite.slice(0, 60)}…`);

  const cdp = await launchBrowser();
  const webOrigin = `http://127.0.0.1:${webPort}`;
  await nav(cdp, `${webOrigin}/?mode=phone`);
  await waitFor(async () => cdp.eval('document.readyState === "complete"'), {
    label: 'index loaded',
  });
  await cdp.eval(`localStorage.setItem('enso-phone-ui-mode', 'desk'); true`);
  await nav(cdp, `${webOrigin}/?mode=phone`);
  await waitFor(async () => cdp.eval(`!!document.querySelector('input')`), {
    timeout: 20_000,
    label: 'pair screen input',
  });
  await cdp.eval(`(() => {
    const input = document.querySelector('input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(invite)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /配对/.test(b.textContent ?? '') && b.offsetParent !== null);
    btn?.click();
    return !!btn;
  })()`);
  await waitFor(async () => !!(await cdp.eval('localStorage.getItem("enso-phone-devices")')), {
    timeout: 30_000,
    label: 'pairing done',
  });
  log('paired');
  await cdp.eval(`localStorage.setItem('enso-phone-ui-mode', 'desk'); true`);
  await nav(cdp, `${webOrigin}/`);
  await nav(cdp, `${webOrigin}/`);
  await waitFor(async () => (await cdp.eval('location.pathname')).startsWith('/desk'), {
    timeout: 15_000,
    label: 'redirect to /desk',
  });
  await waitFor(
    async () => {
      const state = await cdp.eval(`(() => {
        const frame = document.querySelector('iframe.main');
        const doc = frame?.contentDocument;
        return !!(doc && doc.defaultView?.electronAPI?.secretary && doc.defaultView?.electronAPI?.agent);
      })()`);
      return state || null;
    },
    { timeout: 20_000, label: 'remote renderer boot' }
  );
  log('remote renderer ready');

  const hooked = await frame(
    cdp,
    `
    const api = view.electronAPI.secretary;
    if (!view.__resolveLog) {
      const orig = api.resolveProposal.bind(api);
      view.__resolveLog = [];
      api.resolveProposal = async (...args) => {
        const entry = { args, at: Date.now() };
        try {
          entry.result = await orig(...args);
        } catch (error) {
          entry.error = String(error && error.stack ? error.stack : error);
        }
        view.__resolveLog.push(entry);
        return entry.result;
      };
    }
    // 仪器：推送链每一环
    if (!view.__pushLog) {
      view.__pushLog = [];
      // 1) shim 分发给 store 的最终状态
      const origOn = api.onStateChanged.bind(api);
      api.onStateChanged = (cb) => origOn((state) => {
        view.__pushLog.push({
          ring: 'onStateChanged',
          at: Date.now(),
          secretaryId: state?.secretaryId ?? null,
          proposals: state?.proposals ? Object.fromEntries(Object.entries(state.proposals).map(([k, v]) => [k, v?.status])) : null,
          keys: state ? Object.keys(state).slice(0, 12) : null,
        });
        cb(state);
      });
      // 2) store 侧再挂一个独立监听，对比渲染 store 是否收到
      try {
        origOn((state) => {
          view.__pushLog.push({
            ring: 'probe-listener',
            at: Date.now(),
            secretaryId: state?.secretaryId ?? null,
            proposalStatuses: state?.proposals ? Object.values(state.proposals).map((p) => p?.status) : null,
          });
        });
      } catch (error) {
        view.__pushLog.push({ ring: 'probe-listener-error', error: String(error) });
      }
    }
    return { hooked: true };
  `
  );
  log(`hook ${JSON.stringify(hooked)}`);

  const created = await frame(
    cdp,
    `
    const created = await view.electronAPI.secretary.create();
    if (!created.ok) return created;
    const saved = await view.electronAPI.secretary.saveProfile({
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
    }, created.secretaryId);
    return { created, savedOk: saved.ok, savedError: saved.ok ? null : saved.error, profile: saved.ok ? saved.profile?.name : null };
  `
  );
  log(`secretary ${JSON.stringify(created)}`);
  if (!created?.created?.ok || !created.savedOk) {
    throw new Error(`secretary setup failed ${JSON.stringify(created)}`);
  }
  const secretaryId = created.created.secretaryId;

  // 双秘书场景：用户有 2 个秘书。再建一个 Ken，模拟真实环境
  const second = await frame(
    cdp,
    `
    const created2 = await view.electronAPI.secretary.create();
    if (!created2.ok) return created2;
    const saved2 = await view.electronAPI.secretary.saveProfile({
      name: 'Ken',
      avatar: { color: '#22c55e' },
      visibleProjectIds: 'all',
      maxRunningDispatches: 3,
      patrolEnabled: true,
      replyLanguage: 'ui',
      style: 'concise',
      notify: 'off',
      addressAs: null,
      dailyBriefAt: null,
    }, created2.secretaryId);
    return { created2, savedOk2: saved2.ok };
  `
  );
  log(`second secretary ${JSON.stringify(second)}`);

  const wantedProjectId = created.created.projectId;
  const authority = await waitFor(
    async () => {
      const found = await frame(
        cdp,
        `
        const auth = await view.electronAPI.sourceAuthority.read();
        const project = auth.projects.find((p) => p.projectId === ${JSON.stringify(wantedProjectId)} && p.state === 'active');
        return project ? { projectId: project.projectId, cwd: project.canonicalPath, version: project.version, kind: project.kind } : null;
      `
      );
      return found?.projectId ? found : null;
    },
    { timeout: 15_000, label: 'created secretary project' }
  );
  log(`secretary project ${JSON.stringify(authority)}`);

  const section = `[data-secretary-id=${JSON.stringify(secretaryId)}]`;
  await waitFor(
    async () => {
      const ready = await frame(
        cdp,
        `
        const group = doc.querySelector('[data-enso="secretary-group"]');
        if (group && group.getAttribute('data-expanded') == null) {
          group.querySelector('[data-enso="secretary-group-fold"]')?.click();
        }
        return !!doc.querySelector(${JSON.stringify(section)} + ' [data-enso="secretary-open"]');
      `
      );
      return ready || null;
    },
    { timeout: 15_000, label: 'created secretary row' }
  );
  const opened = await frame(
    cdp,
    `
    const root = doc.querySelector(${JSON.stringify(section)});
    const open = root?.querySelector('[data-enso="secretary-open"]');
    const newer = root?.querySelector('[data-enso="secretary-action"][data-action="new"]');
    (newer ?? open)?.click();
    return { open: !!open, newer: !!newer };
  `
  );
  log(`open secretary ${JSON.stringify(opened)}`);

  const conversation = await waitFor(
    async () => {
      const found = await frame(
        cdp,
        `
        const auth = await view.electronAPI.sourceAuthority.read();
        const conv = auth.conversations.find((c) => c.projectId === ${JSON.stringify(authority.projectId)} && c.kind === 'root' && c.lifecycle !== 'ended');
        if (conv) return { conversationId: conv.conversationId, version: conv.version };
        doc.querySelector(${JSON.stringify(section)})?.querySelector('[data-enso="secretary-action"][data-action="new"]')?.click();
        return null;
      `
      );
      return found?.conversationId ? found : null;
    },
    { timeout: 15_000, label: 'created secretary conversation' }
  );
  log(`conversation ${JSON.stringify(conversation)}`);

  const spawned = await frame(
    cdp,
    `
    const spawned = await view.electronAPI.agent.spawn({
      sessionId: ${JSON.stringify(conversation.conversationId)},
      providerId: 'pv-A',
      modelId: 'fake-model-1',
      cwd: ${JSON.stringify(authority.cwd)},
    });
    return spawned;
  `
  );
  log(`spawn ${JSON.stringify(spawned)}`);
  if (!spawned?.ok) throw new Error(`spawn failed ${JSON.stringify(spawned)}`);

  const prompted = await frame(
    cdp,
    `
    return await view.electronAPI.agent.prompt(
      ${JSON.stringify(conversation.conversationId)},
      ${JSON.stringify(SKILL_ASK)},
      undefined,
      ${JSON.stringify(randomUUID())}
    );
  `
  );
  log(`prompt ${JSON.stringify(prompted)}`);
  if (!prompted?.ok) throw new Error(`prompt failed ${JSON.stringify(prompted)}`);

  const pending = await waitFor(
    async () => {
      const found = await frame(
        cdp,
        `
        const state = await view.electronAPI.secretary.getState(${JSON.stringify(secretaryId)});
        const proposal = Object.values(state.proposals ?? {}).find((p) => p.kind === 'skill' && p.status === 'pending');
        return proposal ? { id: proposal.id, status: proposal.status, kind: proposal.kind } : null;
      `
      );
      return found?.id ? found : null;
    },
    { timeout: 40_000, label: 'pending skill proposal' }
  ).catch(async (error) => {
    const dump = await frame(
      cdp,
      `
      const list = await view.electronAPI.secretary.list();
      const states = {};
      for (const entry of list) {
        const state = await view.electronAPI.secretary.getState(entry.id);
        states[entry.id] = Object.values(state.proposals ?? {}).map((p) => ({ id: p.id, kind: p.kind, status: p.status }));
      }
      return { list: list.map((entry) => ({ id: entry.id, projectId: entry.projectId, name: entry.name })), states };
    `
    );
    log(`proposal dump ${JSON.stringify(dump)}`);
    throw error;
  });
  log(`pending ${JSON.stringify(pending)}`);

  await frame(
    cdp,
    `
    const row = doc.querySelector('[data-enso="session-row"][data-conversation=${JSON.stringify(conversation.conversationId)}]');
    row?.click();
    return { row: !!row };
  `
  );

  const card = await waitFor(
    async () => {
      const found = await frame(
        cdp,
        `
        const card = doc.querySelector('[data-enso="secretary-proposal"][data-kind="skill"]');
        if (!card) return null;
        const buttons = [...card.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
        return { text: (card.innerText ?? '').slice(0, 180), buttons };
      `
      );
      return found?.buttons ? found : null;
    },
    { timeout: 20_000, label: 'proposal card' }
  ).catch(async (error) => {
    const diag = await frame(
      cdp,
      `
      return {
        text: (doc.body?.innerText ?? '').slice(0, 800),
        rows: [...doc.querySelectorAll('[data-enso="session-row"]')].map((n) => n.getAttribute('data-conversation')),
        proposals: [...doc.querySelectorAll('[data-enso="secretary-proposal"]')].map((n) => n.getAttribute('data-kind')),
      };
    `
    );
    log(`card diag ${JSON.stringify(diag)}`);
    throw error;
  });
  log(`card ${JSON.stringify(card)}`);

  const before = '/tmp/desk-proposal-card.png';
  await cdp.shot(before);
  log(`shot ${before}`);

  const point = await frame(
    cdp,
    `
    const frameEl = view.frameElement;
    const card = doc.querySelector('[data-enso="secretary-proposal"][data-kind="skill"]');
    const button = [...(card?.querySelectorAll('button') ?? [])].find((b) => {
      const text = (b.textContent ?? '').trim();
      return text === '确认' || text === 'Confirm';
    });
    if (!button || !frameEl) return { missing: true, frame: !!frameEl, buttons: card ? [...card.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()) : [] };
    button.scrollIntoView({ block: 'center', inline: 'center' });
    const fr = frameEl.getBoundingClientRect();
    const r = button.getBoundingClientRect();
    return {
      x: fr.left + r.left + r.width / 2,
      y: fr.top + r.top + r.height / 2,
      w: r.width,
      h: r.height,
      text: (button.textContent ?? '').trim(),
    };
  `
  );
  log(`click point ${JSON.stringify(point)}`);
  if (!point?.x && point?.x !== 0)
    throw new Error(`confirm button missing ${JSON.stringify(point)}`);
  if (point.w < 2 || point.h < 2)
    throw new Error(`confirm button not visible ${JSON.stringify(point)}`);

  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });

  let after = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    after = await frame(
      cdp,
      `
      const state = await view.electronAPI.secretary.getState(${JSON.stringify(secretaryId)});
      const proposal = state.proposals?.[${JSON.stringify(pending.id)}] ?? null;
      return {
        status: proposal?.status ?? null,
        error: proposal?.error ?? null,
        log: view.__resolveLog ?? [],
      };
    `
    );
    if ((after?.log?.length ?? 0) > 0 && after.status && after.status !== 'pending') break;
    if ((after?.log?.length ?? 0) > 0 && after.status === 'pending') {
      await sleep(400);
      if (after.log.some((entry) => entry.result?.ok === false || entry.error)) break;
    }
    await sleep(300);
  }
  const afterShot = '/tmp/desk-proposal-after.png';
  await cdp.shot(afterShot);
  log(`shot ${afterShot}`);
  log(`after ${JSON.stringify(after)}`);

  // 再等 5 秒：推送链有 300ms+300ms 合并，确认后的 succeeded 推送是否最终到达
  await sleep(5_000);
  const latePush = await frame(cdp, `return (view.__pushLog ?? []).slice(-6)`);
  log(`latePush ${JSON.stringify(latePush)}`);
  const lateCard = await frame(
    cdp,
    `
    const card = doc.querySelector('[data-enso="secretary-proposal"][data-kind="skill"]');
    return { text: card ? (card.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 160) : null };
  `
  );
  log(`lateCard ${JSON.stringify(lateCard)}`);
  await cdp.shot('/tmp/desk-proposal-late.png');

  // 仪器输出：推送链
  const pushLog = await frame(cdp, `return view.__pushLog ?? []`);
  log(`__pushLog ${JSON.stringify(pushLog)}`);
  // UI 实际显示的卡片状态文字
  const cardText = await frame(
    cdp,
    `
    const card = doc.querySelector('[data-enso="secretary-proposal"][data-kind="skill"]');
    return { text: card ? (card.textContent ?? '').slice(0, 200) : null };
  `
  );
  log(`cardText ${JSON.stringify(cardText)}`);

  const status = after?.status;
  const walked = status === 'executing' || status === 'succeeded' || status === 'failed';
  const verdict = walked ? 'A' : 'B';
  log(`RESULT ${verdict}`);
  log(`proposal ${pending.id} ${pending.status} -> ${status}`);
  log(`__resolveLog ${JSON.stringify(after?.log ?? [])}`);
  log(`screenshots ${before} ${afterShot}`);
  log(`logs ${OUT}`);

  cdp.close();
  clearTimeout(hardTimeout);
  if (KEEP) {
    log('--keep: leaving processes running');
    return;
  }
  shutdown(0);
}

process.on('SIGINT', () => shutdown(130));
main().catch((error) => {
  console.error(error);
  shutdown(1);
});
