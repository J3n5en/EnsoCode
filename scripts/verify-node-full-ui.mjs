#!/usr/bin/env node
// 「连接到节点」完整版真机验证：同机起本地中继 + 两个隔离实例（A=guest、B=host），
// A 粘贴 B 的配对链接后按步骤断言。前置：pnpm build（宿主经隧道下发 out/renderer，两实例都跑 out/）。
//   node scripts/verify-node-full-ui.mjs [--keep] [--out /tmp/dir]
// 中继用 packages/relay-go（需要 go），模型用 scripts/fake-provider-issue-27.mjs；不碰真实 userData。
// --keep：断言后不退出，实例留着手动看（Ctrl+C 结束并清理）。--relay-bin：复用已编译的 relay-go。
// 退出码：全部通过 0，否则 1。

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const outFlag = argv.indexOf('--out');
const OUT = outFlag !== -1 ? argv[outFlag + 1] : mkdtempSync('/tmp/enso-nodeui-');
const relayFlag = argv.indexOf('--relay-bin');
const RELAY_BIN = relayFlag !== -1 ? argv[relayFlag + 1] : null;
mkdirSync(OUT, { recursive: true });

const children = [];
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(line) {
  console.log(line);
}

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
    `timeout waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`
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

  async key(key, { meta = false } = {}) {
    const code = `Key${key.toUpperCase()}`;
    const base = {
      key,
      code,
      modifiers: meta ? (process.platform === 'darwin' ? 4 : 2) : 0,
      windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
    };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async shot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  close() {
    this.ws.close();
  }
}

class Instance {
  constructor(name) {
    this.name = name;
    this.userData = path.join(OUT, name);
    this.pages = new Map();
  }

  async launch(env) {
    this.cdpPort = await freePort();
    this.inspectPort = await freePort();
    const electron = createRequire(path.join(ROOT, 'package.json'))('electron');
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(ENSO_|ELECTRON_)/.test(key))
    );
    const logFd = openSync(path.join(OUT, `${this.name}.log`), 'a');
    const child = spawn(electron, [`--inspect=${this.inspectPort}`, '.'], {
      cwd: ROOT,
      env: {
        ...clean,
        ...env,
        ENSO_USER_DATA_DIR: this.userData,
        ENSO_CDP_PORT: String(this.cdpPort),
      },
      stdio: ['ignore', logFd, logFd],
    });
    children.push(child);
    this.child = child;
    await waitFor(() => this.target((t) => /\/renderer\/index\.html/.test(t.url)), {
      timeout: 60_000,
      label: `${this.name} main window`,
    });
    this.local = await this.page((t) => /\/renderer\/index\.html/.test(t.url));
    await waitFor(
      () => this.local.eval('document.readyState === "complete" && !!window.electronAPI'),
      {
        label: `${this.name} renderer ready`,
      }
    );
    this.main = await this.mainInspector();
  }

  async targets() {
    const response = await fetch(`http://127.0.0.1:${this.cdpPort}/json/list`);
    return (await response.json()).filter((t) => t.type === 'page');
  }

  async target(predicate) {
    return (await this.targets()).find(predicate) ?? null;
  }

  async page(predicate) {
    const target = await this.target(predicate);
    if (!target) return null;
    let cdp = this.pages.get(target.id);
    if (!cdp) {
      cdp = await Cdp.open(target.webSocketDebuggerUrl);
      cdp.targetId = target.id;
      this.pages.set(target.id, cdp);
    }
    return cdp;
  }

  async mainInspector() {
    const list = await waitFor(
      async () => {
        const r = await fetch(`http://127.0.0.1:${this.inspectPort}/json/list`);
        const items = await r.json();
        return items.length > 0 ? items : null;
      },
      { label: `${this.name} main inspector` }
    );
    const cdp = await Cdp.open(list[0].webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.eval(
      `globalThis.__nodeuiE = process.getBuiltinModule('module').createRequire(process.execPath)('electron'); true`
    );
    return cdp;
  }

  /** 主窗口 contentView 的子视图（底→顶），附 URL 与可见性 */
  layers() {
    return this.main.eval(`(() => {
      const { BrowserWindow } = globalThis.__nodeuiE;
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.contentView.children.some((v) => v.webContents && /\\/renderer\\/index\\.html/.test(v.webContents.getURL())));
      if (!win) return null;
      return win.contentView.children.map((v) => ({
        id: v.webContents?.id ?? null,
        url: v.webContents?.getURL() ?? '',
        visible: typeof v.getVisible === 'function' ? v.getVisible() : null,
      }));
    })()`);
  }

  async topLayer() {
    const layers = (await this.layers()) ?? [];
    return layers.filter((l) => l.visible !== false).at(-1) ?? null;
  }

  /** 拦截系统通知（dev 下 mac 走 osascript；打包走 Notification），只记录不真弹 */
  spyNotifications() {
    return this.main.eval(`(() => {
      globalThis.__nodeuiNotes = [];
      const cp = process.getBuiltinModule('child_process');
      const original = cp.execFile;
      cp.execFile = function (file, args, ...rest) {
        if (file === 'osascript' && String(args?.[1] ?? '').includes('display notification')) {
          globalThis.__nodeuiNotes.push(String(args[1]));
          return undefined;
        }
        return original.call(this, file, args, ...rest);
      };
      process.getBuiltinModule('module').syncBuiltinESMExports();
      const { Notification } = globalThis.__nodeuiE;
      Notification.prototype.show = function () {
        globalThis.__nodeuiNotes.push(JSON.stringify({ title: this.title, body: this.body }));
      };
      return true;
    })()`);
  }

  notes() {
    return this.main.eval('globalThis.__nodeuiNotes ?? []');
  }
}

function writeSettings(dir, providerPort) {
  mkdirSync(dir, { recursive: true });
  const state = {
    providers: [
      {
        id: 'pv-A',
        name: 'Provider A',
        api: 'anthropic-messages',
        apiKey: 'sk-fake-A',
        baseUrl: `http://127.0.0.1:${providerPort}`,
        enabled: true,
        models: [{ id: 'fake-model-1' }],
      },
    ],
    defaultModel: { providerId: 'pv-A', modelId: 'fake-model-1' },
    onboarded: true,
    theme: 'light',
    language: 'en',
  };
  writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ 'enso-settings': { state, version: 2 } })
  );
}

function relayBinary() {
  if (RELAY_BIN) return RELAY_BIN;
  const bin = path.join(OUT, 'enso-relay');
  if (!existsSync(bin)) {
    execFileSync('go', ['build', '-o', bin, '.'], {
      cwd: path.join(ROOT, 'packages/relay-go'),
      stdio: 'inherit',
    });
  }
  return bin;
}

function startProcess(name, command, args, env = {}) {
  const logFd = openSync(path.join(OUT, `${name}.log`), 'a');
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', logFd, logFd],
  });
  children.push(child);
  return child;
}

function cleanup() {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

async function step(name, run) {
  const started = Date.now();
  try {
    const detail = await run();
    results.push({ name, ok: true, detail });
    log(`PASS  ${name}${detail ? `  (${detail})` : ''}  [${Date.now() - started}ms]`);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    log(`FAIL  ${name}  (${detail})  [${Date.now() - started}ms]`);
    return false;
  }
}

function check(ok, message) {
  if (!ok) throw new Error(message);
}

const clickNodeOption = (labelJson) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const trigger = document.querySelector('[data-enso="node-switcher"]');
  if (!trigger) return 'no-switcher';
  trigger.click();
  for (let i = 0; i < 30; i++) {
    const option = [...document.querySelectorAll('[data-slot="popover-viewport"] button, [role="dialog"] button')]
      .find((b) => b.textContent.trim().startsWith(${labelJson}));
    if (option) { option.click(); return 'clicked'; }
    await sleep(100);
  }
  return 'no-option';
})()`;

const nodeUrl = /^enso-node:\/\/[0-9a-f]+\/r\/index\.html/;

async function main() {
  for (const file of [
    'out/main/index.js',
    'out/renderer/index.html',
    'out/renderer/web-preload.js',
  ]) {
    check(existsSync(path.join(ROOT, file)), `缺少 ${file}，先运行 pnpm build`);
  }
  log(`output: ${OUT}`);

  const relayPort = await freePort();
  const providerPort = await freePort();
  const relayUrl = `http://127.0.0.1:${relayPort}`;
  startProcess('relay', relayBinary(), [
    '--listen',
    `127.0.0.1:${relayPort}`,
    '--db',
    path.join(OUT, 'relay.sqlite'),
    '--auto-update=false',
  ]);
  startProcess('provider', process.execPath, ['scripts/fake-provider-issue-27.mjs'], {
    FAKE_PROVIDER_PORT: String(providerPort),
  });
  await waitFor(() => fetch(`${relayUrl}/`).then((r) => r.status > 0), { label: 'relay' });

  const projectDir = path.join(OUT, 'nodeui-proj-b');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, 'README.md'), 'node full ui project\n');

  const A = new Instance('A');
  const B = new Instance('B');
  writeSettings(A.userData, providerPort);
  writeSettings(B.userData, providerPort);
  await Promise.all([A.launch(), B.launch()]);
  await A.spyNotifications();
  await B.spyNotifications();
  log(`A cdp=${A.cdpPort} inspect=${A.inspectPort}  B cdp=${B.cdpPort} inspect=${B.inspectPort}`);

  const created = await B.local.eval(`window.electronAPI.sourceAuthority.createProject({
    requestId: crypto.randomUUID(), path: ${JSON.stringify(projectDir)} })`);
  check(created?.accepted, `B 建项目失败 ${JSON.stringify(created)}`);
  await B.local.eval(`window.electronAPI.pair.setRelayUrl(${JSON.stringify(relayUrl)})`);
  const pairing = await B.local.eval('window.electronAPI.pair.start()');
  check(pairing?.ok && pairing.inviteUri, `B 配对码生成失败 ${JSON.stringify(pairing)}`);
  const paired = await A.local.eval(
    `window.electronAPI.nodes.pair(${JSON.stringify(pairing.inviteUri)})`
  );
  check(paired?.ok, `A 认领失败 ${JSON.stringify(paired)}`);
  const nodeId = paired.node.nodeId;
  const nodeLabel = await waitFor(
    async () => {
      const status = await A.local.eval('window.electronAPI.nodes.list()');
      const node = status.nodes.find((n) => n.nodeId === nodeId);
      return node?.hostOnline && node.hostname ? node.label : null;
    },
    { timeout: 45_000, label: 'B 在线' }
  );
  log(`paired node=${nodeId} label=${nodeLabel}`);

  await A.local.eval('window.__nodeuiMarker = "local"; true');
  let overlay = null;
  let overlayTargetId = null;

  await step('A 左下角节点切换器切到 B', async () => {
    const r = await A.local.eval(clickNodeOption(JSON.stringify(nodeLabel)));
    check(r === 'clicked', r);
    await sleep(1500);
    await A.local.shot(path.join(OUT, 'a-local-after-switch.png'));
  });

  const fullUi = await step('A 主窗口可见层是 B 的完整主界面（项目侧栏 + 输入区）', async () => {
    const top = await waitFor(
      async () => {
        const layer = await A.topLayer();
        return layer && nodeUrl.test(layer.url) ? layer : null;
      },
      {
        timeout: 20_000,
        label: `顶层为 enso-node 主界面，当前 ${JSON.stringify(await A.layers())}`,
      }
    );
    overlay = await A.page((t) => t.url === top.url);
    overlayTargetId = overlay.targetId;
    const projectName = path.basename(projectDir);
    await waitFor(
      () =>
        overlay.eval(`(() => {
          const sidebar = document.querySelector('[data-enso="sidebar"]');
          return !!sidebar && sidebar.innerText.includes(${JSON.stringify(projectName)});
        })()`),
      { timeout: 60_000, label: `B 侧栏出现项目 ${projectName}` }
    );
    await overlay.shot(path.join(OUT, 'a-overlay-b.png'));
    return `top=${top.url}`;
  });

  const dependent = [
    '焦点在可见层，Cmd+N 在 B 新建会话',
    'B 输入框有斜杠命令',
    'B 的右侧面板与终端可打开',
    'B 界面按本机原生窗口布局：窗口控件可用，无精简版入口',
    'B 界面左下角节点切换器列出本机与 B',
    '经 B 界面切回本机，本机界面未重载',
    '再切 B 复用同一 webContents（不重新加载）',
    'B 的设置可从完整界面打开',
    'B 会话完成后由 A 弹出系统通知',
    'B 界面不能直接配对，「连接到节点…」回到本机界面打开配对对话框',
  ];
  if (!fullUi) {
    for (const name of dependent) {
      results.push({ name, ok: false, detail: 'skipped: 没有 B 的完整界面' });
      log(`SKIP  ${name}`);
    }
  } else {
    await overlay.eval('window.__nodeuiMarker = "overlay"; true');

    await step('焦点在可见层，Cmd+N 在 B 新建会话', async () => {
      await A.main.eval(`(() => {
        const { app, BrowserWindow } = globalThis.__nodeuiE;
        app.focus({ steal: true });
        BrowserWindow.getAllWindows().find((w) => w.isVisible())?.focus();
        return true;
      })()`);
      await sleep(500);
      const focused = await A.main.eval(
        'globalThis.__nodeuiE.webContents.getFocusedWebContents()?.getURL() ?? null'
      );
      check(focused && nodeUrl.test(focused), `获得焦点的是 ${focused}`);
      await overlay.key('n', { meta: true });
      await waitFor(() => overlay.eval('!!document.querySelector("[data-enso=\\"composer\\"]")'), {
        timeout: 15_000,
        label: 'B 出现输入区',
      });
      return `focused=${focused}`;
    });

    await step('B 输入框有斜杠命令', async () => {
      await overlay.eval(`(() => {
        const editor = document.querySelector('[data-enso="composer"] [contenteditable="true"]');
        editor?.focus();
        return !!editor;
      })()`);
      await overlay.send('Input.insertText', { text: '/' });
      const count = await waitFor(
        () =>
          overlay.eval(
            'document.querySelectorAll("[role=listbox][aria-label=\\"Command suggestions\\"] [role=option]").length'
          ),
        { timeout: 10_000, label: '斜杠命令列表' }
      );
      await overlay.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
      });
      await overlay.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
      });
      return `options=${count}`;
    });

    await step('B 的右侧面板与终端可打开', async () => {
      await overlay.key('j', { meta: true });
      await waitFor(
        () => overlay.eval('!!document.querySelector("[data-enso=\\"side-panel\\"]")'),
        {
          timeout: 10_000,
          label: '右侧面板',
        }
      );
      await overlay.eval(`(() => {
        const panel = document.querySelector('[data-enso="side-panel"]');
        const target = panel.querySelector('button, [tabindex]');
        target?.focus();
        return !!target;
      })()`);
      await overlay.key('t', { meta: true });
      await waitFor(
        () => overlay.eval('!!document.querySelector("[data-enso=\\"side-panel\\"] .xterm")'),
        {
          timeout: 15_000,
          label: '终端 xterm',
        }
      );
    });

    await step('B 界面按本机原生窗口布局：窗口控件可用，无精简版入口', async () => {
      const state = await overlay.eval(`(async () => ({
        nativePlatform: window.electronAPI.remote?.nativePlatform ?? null,
        maximized: await window.electronAPI.window.isMaximized().catch((e) => String(e)),
        compact: !!document.querySelector('[title="Compact view"]'),
      }))()`);
      check(state.nativePlatform === process.platform, `nativePlatform=${state.nativePlatform}`);
      check(typeof state.maximized === 'boolean', `isMaximized=${state.maximized}`);
      check(!state.compact, '仍有精简版入口');
      return JSON.stringify(state);
    });

    await step('B 界面左下角节点切换器列出本机与 B', async () => {
      const text = await overlay.eval(`(async () => {
        document.querySelector('[data-enso="node-switcher"]')?.click();
        await new Promise((r) => setTimeout(r, 400));
        const popup = document.querySelector('[data-slot="popover-viewport"]');
        const text = popup?.innerText ?? '';
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return text;
      })()`);
      check(
        text.includes('This computer') && text.includes(nodeLabel),
        `popup=${JSON.stringify(text)}`
      );
    });

    await step('经 B 界面切回本机，本机界面未重载', async () => {
      await overlay.eval(
        'document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true'
      );
      const r = await overlay.eval(clickNodeOption(JSON.stringify('This computer')));
      check(r === 'clicked', r);
      await waitFor(async () => /\/renderer\/index\.html/.test((await A.topLayer())?.url ?? ''), {
        timeout: 10_000,
        label: '顶层回到本机 workbench',
      });
      const marker = await A.local.eval('window.__nodeuiMarker');
      check(marker === 'local', `本机 renderer marker=${marker}`);
      await A.local.shot(path.join(OUT, 'a-local-after.png'));
    });

    await step('再切 B 复用同一 webContents（不重新加载）', async () => {
      const before = await A.topLayer();
      check(!nodeUrl.test(before?.url ?? ''), `前置不成立：可见层仍是 ${before?.url}`);
      const r = await A.local.eval(clickNodeOption(JSON.stringify(nodeLabel)));
      check(r === 'clicked', r);
      const top = await waitFor(
        async () => {
          const layer = await A.topLayer();
          return layer && nodeUrl.test(layer.url) ? layer : null;
        },
        { timeout: 10_000, label: '顶层为 B' }
      );
      const again = await A.page((t) => t.url === top.url);
      check(again.targetId === overlayTargetId, `target ${again.targetId} != ${overlayTargetId}`);
      const marker = await again.eval('window.__nodeuiMarker');
      check(marker === 'overlay', `B 界面 marker=${marker}`);
    });

    await step('B 的设置可从完整界面打开', async () => {
      await overlay.eval(
        'document.querySelector("[data-enso=\\"settings-button\\"]")?.click(); true'
      );
      const settings = await waitFor(
        () =>
          A.page(
            (t) => /^enso-node:\/\/[0-9a-f]+\/shell\.html/.test(t.url) && !/page=main/.test(t.url)
          ),
        { timeout: 15_000, label: '节点设置窗口' }
      );
      const text = await waitFor(
        () =>
          settings.eval(
            `(document.querySelector('iframe')?.contentDocument?.body?.innerText ?? '').trim()`
          ),
        { timeout: 60_000, label: '设置页内容' }
      );
      await settings.shot(path.join(OUT, 'a-node-settings.png'));
      return `settings text ${text.length} chars`;
    });

    await step('B 会话完成后由 A 弹出系统通知', async () => {
      await overlay.eval(`(() => {
        const editor = document.querySelector('[data-enso="composer"] [contenteditable="true"]');
        editor?.focus();
        return !!editor;
      })()`);
      await overlay.send('Input.insertText', { text: 'hello from node ui [[slow:4000]]' });
      await overlay.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        text: '\r',
        windowsVirtualKeyCode: 13,
      });
      await overlay.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
      await sleep(1500);
      // 窗口聚焦且正看着该会话时不弹（同本机）：回复放慢，切回本机后再完成
      const r = await overlay.eval(clickNodeOption(JSON.stringify('This computer')));
      check(r === 'clicked', `切回本机 ${r}`);
      const notes = await waitFor(
        async () => {
          const list = await A.notes();
          return list.length > 0 ? list : null;
        },
        { timeout: 30_000, label: `A 的通知（B 侧通知 ${JSON.stringify(await B.notes())}）` }
      );
      return notes.join(' | ').slice(0, 200);
    });

    await step('B 界面不能直接配对，「连接到节点…」回到本机界面打开配对对话框', async () => {
      const r = await A.local.eval(clickNodeOption(JSON.stringify(nodeLabel)));
      check(r === 'clicked', `切到 B ${r}`);
      await waitFor(async () => nodeUrl.test((await A.topLayer())?.url ?? ''), {
        timeout: 10_000,
        label: '顶层为 B',
      });
      const before = (await A.local.eval('window.electronAPI.nodes.list()')).nodes.length;
      const pair = await overlay.eval(
        `window.electronAPI.nodes.pair('https://relay.invalid/#pk=1').then((v) => JSON.stringify(v), (e) => 'rejected: ' + e.message)`
      );
      check(!/"ok":true/.test(pair), `B 界面 nodes:pair 未被拒 ${pair}`);
      const after = (await A.local.eval('window.electronAPI.nodes.list()')).nodes.length;
      check(after === before, `节点数 ${before} → ${after}`);
      const click = await overlay.eval(clickNodeOption(JSON.stringify('Connect to a node')));
      check(click === 'clicked', click);
      await waitFor(async () => /\/renderer\/index\.html/.test((await A.topLayer())?.url ?? ''), {
        timeout: 10_000,
        label: '顶层回到本机 workbench',
      });
      await waitFor(
        () =>
          A.local.eval(
            `[...document.querySelectorAll('[role="dialog"]')].some((d) => d.innerText.includes('Connect to a node'))`
          ),
        { timeout: 10_000, label: '本机界面打开配对对话框' }
      );
      await A.local.shot(path.join(OUT, 'a-local-pair-dialog.png'));
      return pair;
    });
  }

  await step('src 中已无 RemoteNodeView', async () => {
    let out = '';
    try {
      out = execFileSync('git', ['grep', '-n', 'RemoteNodeView', '--', 'src'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
    } catch {
      out = '';
    }
    check(out.trim() === '', out.trim().split('\n').slice(0, 3).join('; '));
  });

  const failed = results.filter((r) => !r.ok);
  writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  log(`\n${results.length - failed.length}/${results.length} passed  → ${OUT}/results.json`);
  if (KEEP) {
    log('--keep：实例保持运行，Ctrl+C 结束');
    await new Promise(() => {});
  }
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(2);
  });
