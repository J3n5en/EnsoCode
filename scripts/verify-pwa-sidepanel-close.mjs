#!/usr/bin/env node
// PWA 完整模式（/desk）触屏下右侧面板与面板 tab 能否一次点击关闭。
//   pnpm build:server && node scripts/verify-pwa-sidepanel-close.mjs
// 手机 390x844 与平板 1180x820 两个触屏视口各跑一遍：开两个 tab → 点激活 tab 的 × → 点面板关闭。
// 截图写到 /tmp/pwa-sidepanel-close/。退出码：全部一次点击生效为 0，否则 1。

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOTS = '/tmp/pwa-sidepanel-close';
const OUT = mkdtempSync(path.join(os.tmpdir(), 'enso-pwa-sidepanel-'));
const USER_DATA = path.join(OUT, 'userData');
const PROJ = path.join(OUT, 'proj');
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(PROJ, { recursive: true });

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 1180, height: 820 },
];
const TOGGLE_LABEL = '折叠/展开右侧面板';
const CLOSE_LABEL = '关闭右侧面板';

const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => console.log(line);

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
}, 240_000);
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

  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(SHOTS, `${name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    log(`shot ${file}`);
    return file;
  }
}

const HEADLESS_SHELL = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
);

async function viewport(cdp, { width, height }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
}

async function launchBrowser() {
  if (!existsSync(HEADLESS_SHELL)) throw new Error(`missing chromium ${HEADLESS_SHELL}`);
  const debugPort = await freePort();
  const userDir = mkdtempSync(path.join(os.tmpdir(), 'enso-pwa-sidepanel-chrome-'));
  const logFd = openSync(path.join(OUT, 'chromium.log'), 'a');
  const child = spawn(
    HEADLESS_SHELL,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDir}`,
      '--window-size=1180,844',
      '--touch-events=enabled',
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
  await viewport(cdp, VIEWPORTS[0]);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return cdp;
}

const FRAME_DOC = `(() => {
  const main = document.querySelector('iframe.main');
  if (main?.contentDocument) return main.contentDocument;
  return document;
})()`;

/** 在 /desk 的 iframe 里跑一段代码（doc / view 可用） */
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

/**
 * 找到元素在顶层页面里的中心点，并记下该点真实命中的元素（pointer-events:none 会让命中落到别处）。
 * pick 是在 iframe 里返回目标元素的表达式。
 */
async function locate(cdp, pick) {
  return frame(
    cdp,
    `
    const el = (() => { ${pick} })();
    if (!el) return null;
    const fr = view.frameElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hit = doc.elementFromPoint(cx, cy);
    const style = view.getComputedStyle(el);
    return {
      x: fr.left + cx,
      y: fr.top + cy,
      w: r.width,
      h: r.height,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      display: style.display,
      hitsTarget: !!hit && (hit === el || el.contains(hit)),
      hit: hit ? hit.tagName.toLowerCase() + (hit.getAttribute('aria-label') ? '[' + hit.getAttribute('aria-label') + ']' : '') + (hit.hasAttribute('data-side-tab') ? '[data-side-tab]' : '') : null,
    };
  `
  );
}

async function tap(cdp, point) {
  await cdp.send('Input.synthesizeTapGesture', {
    x: point.x,
    y: point.y,
    gestureSourceType: 'touch',
  });
  await sleep(900);
}

const PANEL_STATE = `
  const aside = doc.querySelector('[data-slot="side-panel"]');
  const width = aside ? Math.round(aside.getBoundingClientRect().width) : 0;
  const dock = [...doc.querySelectorAll('.enso-side-dock')].find((d) => d.offsetParent !== null);
  const tabs = dock ? [...dock.querySelectorAll('[data-side-tab]')].filter((t) => t.offsetParent !== null) : [];
  return {
    open: width > 0,
    width,
    tabs: tabs.map((t) => t.getAttribute('data-panel-id')),
    active: tabs.find((t) => t.hasAttribute('data-active'))?.getAttribute('data-panel-id') ?? null,
  };
`;
const panelState = (cdp) => frame(cdp, PANEL_STATE);

function prepareProject() {
  writeFileSync(path.join(PROJ, 'README.md'), 'pwa side panel target\n');
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: PROJ, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} ${result.stderr}`);
  };
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init']);
}

function writeSettings() {
  const projectId = randomUUID();
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
    language: 'zh',
    theme: 'light',
    projects: [{ id: projectId, name: 'pwa-sidepanel', path: PROJ }],
  };
  writeFileSync(
    path.join(USER_DATA, 'settings.json'),
    JSON.stringify({ 'enso-settings': { state, version: 18 } })
  );
  return projectId;
}

async function startServer() {
  const webPort = await freePort();
  const serverLog = openSync(path.join(OUT, 'server.log'), 'a');
  const env = { ...process.env, ENSO_VERIFY: '1', ENSO_PACKAGED: '0', ENSO_DATA_DIR: USER_DATA };
  delete env.ELECTRON_RUN_AS_NODE;
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
    { env, stdio: ['ignore', serverLog, serverLog], cwd: ROOT }
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
    { label: 'enso-server web' }
  );
  const invite = await new Promise((resolve, reject) => {
    const pair = spawn(process.execPath, [path.join(ROOT, 'out/server/index.js'), 'pair'], {
      env,
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
  return { origin: `http://127.0.0.1:${webPort}`, invite };
}

async function openDesk(cdp, { origin, invite }) {
  await cdp.send('Page.navigate', { url: `${origin}/?mode=phone` });
  await waitFor(() => cdp.eval('document.readyState === "complete"'), { label: 'index' });
  await cdp.eval(`localStorage.setItem('enso-phone-ui-mode', 'desk'); true`);
  await cdp.send('Page.navigate', { url: `${origin}/?mode=phone` });
  await waitFor(() => cdp.eval(`!!document.querySelector('input')`), { label: 'pair input' });
  await cdp.eval(`(() => {
    const input = document.querySelector('input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(invite)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('button')].find((b) => /配对/.test(b.textContent ?? '') && b.offsetParent !== null)?.click();
    return true;
  })()`);
  await waitFor(async () => !!(await cdp.eval('localStorage.getItem("enso-phone-devices")')), {
    label: 'pairing',
  });
  await cdp.eval(`localStorage.setItem('enso-phone-ui-mode', 'desk'); true`);
  await cdp.send('Page.navigate', { url: `${origin}/` });
  await waitFor(async () => (await cdp.eval('location.pathname')).startsWith('/desk'), {
    label: 'redirect to /desk',
  });
  await waitFor(
    () =>
      cdp.eval(`(() => {
        const doc = document.querySelector('iframe.main')?.contentDocument;
        return !!doc?.querySelector('[data-enso="workbench"]');
      })()`),
    { timeout: 40_000, label: 'remote renderer' }
  );
  // 快照层淡出前会盖在 iframe 上
  await waitFor(() => cdp.eval(`!document.querySelector('iframe.snapshot')`), {
    timeout: 40_000,
    label: 'snapshot gone',
  });
}

async function newConversation(cdp) {
  await frame(
    cdp,
    `doc.querySelector('[data-enso="project-row"] svg.lucide-message-square-plus')?.closest('button')?.click(); return true;`
  );
  await waitFor(
    () => frame(cdp, `return !doc.body.innerText.includes('创建或选择一个项目以开始对话');`),
    { label: 'active conversation' }
  );
}

/** 准备工作（不在被测范围内）：通过新建菜单补足两个 tab */
async function ensureTwoTabs(cdp) {
  for (const icon of ['lucide-folder-open', 'lucide-git-compare']) {
    const state = await panelState(cdp);
    if (state.tabs.length >= 2) return;
    const wanted = icon === 'lucide-folder-open' ? 'files' : 'changes';
    if (state.tabs.includes(wanted)) continue;
    await waitFor(
      () =>
        frame(
          cdp,
          `
          const item = [...doc.querySelectorAll('[role="menuitem"]')].find((m) => m.querySelector('svg.${icon}'));
          if (item) { item.click(); return true; }
          const plus = [...doc.querySelectorAll('[data-slot="side-panel"] svg.lucide-plus')]
            .map((s) => s.closest('button'))
            .find((b) => b && b.getBoundingClientRect().width > 0);
          plus?.click();
          return false;
        `
        ),
      { label: `menu item ${icon}`, timeout: 10_000, interval: 600 }
    );
    await waitFor(async () => (await panelState(cdp)).tabs.includes(wanted), {
      label: `tab ${wanted}`,
    });
    await sleep(400);
  }
}

async function runViewport(cdp, vp) {
  const result = { viewport: `${vp.width}x${vp.height}`, steps: {} };
  await viewport(cdp, vp);
  await sleep(1500);
  result.media = await frame(
    cdp,
    `return { coarse: view.matchMedia('(pointer: coarse)').matches, hoverNone: view.matchMedia('(hover: none)').matches, width: view.innerWidth };`
  );

  // 1. 顶栏开关打开面板
  const toggle = await locate(
    cdp,
    `return doc.querySelector('[data-enso="title-bar"] button[aria-label="${TOGGLE_LABEL}"]');`
  );
  if (!(await panelState(cdp)).open) {
    if (!toggle) throw new Error('title bar toggle missing');
    await tap(cdp, toggle);
  }
  await waitFor(async () => (await panelState(cdp)).open, { label: 'panel open' });
  await ensureTwoTabs(cdp);
  // 关掉自动弹出的新建菜单等残留浮层
  await frame(cdp, `doc.activeElement?.blur?.(); return true;`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  await sleep(600);
  const opened = await panelState(cdp);
  await cdp.shot(`${vp.name}-1-panel-open`);

  // 2. 点一次激活 tab 的 × 关单个 tab
  const close = await locate(
    cdp,
    `return [...doc.querySelectorAll('[data-side-tab][data-active] svg.lucide-x')].map((s) => s.closest('button')).find((b) => b && b.offsetParent !== null) ?? null;`
  );
  if (close) await tap(cdp, close);
  const afterTab = await panelState(cdp);
  result.steps.closeTab = {
    button: close,
    before: opened.tabs,
    after: afterTab.tabs,
    pass:
      !!close &&
      afterTab.open &&
      afterTab.tabs.length === opened.tabs.length - 1 &&
      !afterTab.tabs.includes(opened.active),
  };
  await cdp.shot(`${vp.name}-2-tab-closed`);

  // 3. 点一次面板自己标题行里的关闭/收起按钮关整个面板
  const header = await frame(
    cdp,
    `
    const actions = [...doc.querySelectorAll('[data-slot="side-panel"] [data-side-actions]')].find((a) => a.getBoundingClientRect().width > 0);
    if (!actions) return null;
    const visible = (b) => !!b && b.getBoundingClientRect().width > 0 && view.getComputedStyle(b).visibility !== 'hidden';
    const plus = actions.querySelector('svg.lucide-plus')?.closest('button');
    return {
      newTabVisible: visible(plus),
      closeVisible: visible(doc.querySelector('[data-slot="side-panel"] button[aria-label="${CLOSE_LABEL}"]')),
      toggleVisible: visible(actions.querySelector('button[aria-label="${TOGGLE_LABEL}"]')),
      moreIconShown: [...actions.querySelectorAll('svg.lucide-ellipsis, svg.lucide-more-horizontal')].some((s) => view.getComputedStyle(s).display !== 'none'),
    };
  `
  );
  const panelClose = await locate(
    cdp,
    `
    const scope = doc.querySelector('[data-slot="side-panel"]');
    const visible = (b) => !!b && b.getBoundingClientRect().width > 0;
    const close = scope?.querySelector('button[aria-label="${CLOSE_LABEL}"]');
    if (visible(close)) return close;
    const toggle = [...(scope?.querySelectorAll('[data-side-actions] button[aria-label="${TOGGLE_LABEL}"]') ?? [])].find(visible);
    return toggle ?? null;
  `
  );
  if (panelClose) await tap(cdp, panelClose);
  const afterPanel = await panelState(cdp);
  result.steps.closePanel = {
    header,
    button: panelClose,
    pass:
      !!panelClose &&
      !afterPanel.open &&
      // 触屏不依赖 hover：新建 + 常显，收起按钮显示明确图标而非「…」
      !!header?.newTabVisible &&
      !header?.moreIconShown,
  };
  await cdp.shot(`${vp.name}-3-panel-closed`);
  if (afterPanel.open) {
    // 留给下一个视口一个关着的初态
    const fallback = await locate(
      cdp,
      `return doc.querySelector('[data-enso="title-bar"] button[aria-label="${TOGGLE_LABEL}"]') ?? doc.querySelector('[data-slot="side-panel"] button[aria-label="${TOGGLE_LABEL}"]');`
    );
    if (fallback) await tap(cdp, fallback);
  }
  return result;
}

async function main() {
  log(`out ${OUT}`);
  prepareProject();
  writeSettings();
  const server = await startServer();
  log(`server ${server.origin}`);
  const cdp = await launchBrowser();
  await openDesk(cdp, server);
  log('desk ready');
  await newConversation(cdp);
  const results = [];
  for (const vp of VIEWPORTS) {
    const result = await runViewport(cdp, vp);
    log(`RESULT ${vp.name} ${JSON.stringify(result)}`);
    results.push(result);
  }
  const ok = results.every((r) => Object.values(r.steps).every((s) => s.pass));
  log(ok ? 'PASS' : 'FAIL');
  log(`screenshots ${SHOTS}`);
  shutdown(ok ? 0 : 1);
}

process.on('SIGINT', () => shutdown(130));
main().catch((error) => {
  console.error(error);
  shutdown(1);
});
