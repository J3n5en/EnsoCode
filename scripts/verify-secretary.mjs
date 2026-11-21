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
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';
import { uiElementElectron } from './verify-electron.mjs';
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
let TG_PORT = 0;
/** 假 Telegram Bot API：getMe / getUpdates / sendMessage / answerCallbackQuery */
let telegram = null;
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

/**
 * fake provider 的 `[[tool:name {json}]]` 指令不支持嵌套：参数里还要带一条给派出会话用的指令时，
 * 把里面的 `]]` 写成 JSON 转义，外层解析时不会提前收尾，JSON.parse 后又还原成原文。
 */
function toolDirective(name, args) {
  return `[[tool:${name} ${JSON.stringify(args).replaceAll(']]', '\\u005d\\u005d')}]]`;
}

/** 派发直接执行：新开一个秘书会话发指令，从工具结果里拿到建出的会话 id */
function directDispatcher(page, setup) {
  return (toolName, args) =>
    page(`
    const secretary = await SEC();
    const fresh = await secretary.getState().newSecretaryConversation();
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    await S().send(
      ${JSON.stringify(`派活 ${toolDirective(toolName, args)}`)},
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      fresh
    );
    const message = await until(
      () => (S().conversations[fresh]?.messages ?? []).find((m) => m.toolName === ${JSON.stringify(toolName)}) ?? null,
      30000
    );
    const text = (Array.isArray(message?.content) ? message.content : [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
    const conversationId = /"conversationId":"([^"]+)"/.exec(text)?.[1] ?? null;
    return JSON.stringify({
      ok: Boolean(message) && message.isError !== true && /"status":"created"/.test(text) && Boolean(conversationId),
      secretaryId: fresh,
      conversationId,
      error: message ? (message.isError ? text : null) : 'no tool result',
    });
  `);
}

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
  telegram?.server?.close();
  telegram = null;
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
// 缓存的其它会话与还没排进布局的面板不认。
// visible 返回已排进布局的全部节点；shown 返回最后一张有文字的卡片。只在这里定义一份。
const visible = (selector) =>
  [...document.querySelectorAll(selector)].filter((node) => node.offsetParent !== null);
const shown = (selector) =>
  [...document.querySelectorAll(selector)].filter((node) => node.innerText.trim()).at(-1) ?? null;
// 切过会话后 DOM 里会留着已缓存、宽高为 0 的秘书面板；只认当前看得见的那个
const visiblePanel = () =>
  [...document.querySelectorAll('[data-enso=secretary-panel]')].find((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }) ?? null;
`;

async function closeSettingsWindow(page) {
  // 页面里的 window.close() 会把 evaluate 一起挂死，不能一直等它回包。
  // 用这条连接自己的 target 走 CDP /json/close，最多 2 秒，然后断开。
  const closed = page.evaluate('window.close()').catch(() => undefined);
  if (page.targetId) {
    try {
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${page.targetId}`, {
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // 窗口已经没了，或者关闭请求没有在时限内返回
    }
  }
  await Promise.race([closed, delay(2_000)]);
  page.close();
}

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
  // 页面被关掉或崩了时 CDP 不会再回包；把挂着的请求都结束掉，免得整个验收无声卡死
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
  // 验收窗口始终隐藏：连着的这段时间让页面按可见且聚焦运行，rAF、:hover、指针事件照常
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
    async shot(file) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
      log(`  shot ${file}`);
    },
    /** 只截一块区域（CSS 像素），看清侧边栏里的行 */
    async shotClip(file, rect) {
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { ...rect, scale: 2 },
      });
      if (!shot.result?.data)
        throw new Error(`shotClip ${JSON.stringify({ rect, error: shot.error })}`);
      writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
      log(`  shot ${file}`);
    },
    /** 真实鼠标事件：:hover 只认这个，脚本里 dispatchEvent 触发不了 */
    mouse: (type, x, y) =>
      send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: type === 'mouseMoved' ? 'none' : 'left',
        clickCount: type === 'mouseMoved' ? 0 : 1,
      }),
    /** 真实按键（Tab 移焦点会带 :focus-visible） */
    async key(key, code = key, keyCode = 0) {
      for (const type of ['keyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', {
          type,
          key,
          code,
          windowsVirtualKeyCode: keyCode,
        });
      }
    },
    close: () => socket.close(),
    targetId: target.id,
    async setFiles(selector, files) {
      await send('DOM.enable');
      const doc = await send('DOM.getDocument', { depth: 0 });
      const found = await send('DOM.querySelector', {
        nodeId: doc.result.root.nodeId,
        selector,
      });
      if (!found.result?.nodeId) throw new Error(`no node ${selector}`);
      const reply = await send('DOM.setFileInputFiles', { nodeId: found.result.nodeId, files });
      if (reply.error) throw new Error(reply.error.message ?? 'setFileInputFiles failed');
    },
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
  // 普通会话的工具行回归要用真实的 mcp__ 工具：挂一个只提供 echo 的最小 MCP 服务
  settings['enso-settings'].state.mcpServers = [
    ...(settings['enso-settings'].state.mcpServers ?? []),
    {
      id: 'fake-mcp',
      name: 'fake',
      description: '验收用的最小 MCP 服务',
      transport: 'stdio',
      command: process.execPath,
      args: [path.join(REPO, 'scripts/fake-mcp-echo.mjs')],
      source: 'user',
      enabled: true,
    },
  ];
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
      telegram: explicitPort('SEC_VERIFY_TG_PORT', process.env.SEC_VERIFY_TG_PORT),
    },
    listenLoopback
  );
  CDP_PORT = portLease.ports.cdp;
  FAKE_PORT = portLease.ports.fake;
  PLUGIN_PORT = portLease.ports.plugin;
  RENDERER_PORT = portLease.ports.renderer;
  TG_PORT = portLease.ports.telegram;
  log('== isolation');
  log(`  dir: ${ART}`);
  log(`  env: ${ENV}`);
  log(`  project: ${PROJ}`);
  log(
    `  ports: cdp=${CDP_PORT} fake=${FAKE_PORT} plugin=${PLUGIN_PORT} renderer=${RENDERER_PORT} telegram=${TG_PORT}`
  );
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
  log('== fake telegram');
  await portLease.release('telegram');
  telegram = await startFakeTelegram(TG_PORT);
  log(`  listening on http://127.0.0.1:${TG_PORT}`);
  await portLease.release('cdp');
  await portLease.release('renderer');
  start('dev', 'pnpm', ['dev'], {
    ENSO_USER_DATA_DIR: ENV,
    ENSO_CDP_PORT: String(CDP_PORT),
    ENSO_RENDERER_PORT: String(RENDERER_PORT),
    // 验收实例：不进 Dock、不抢前台、窗口不弹出，CDP 照常读写截图
    ENSO_VERIFY: '1',
    ELECTRON_EXEC_PATH: uiElementElectron(createRequire(import.meta.url)('electron')),
    // 联系方式只打这个假服务，不碰真实的 api.telegram.org
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
      await sleep(500);
      continue;
    }
    if (setup?.error !== 'renderer stores not ready' || attempt >= 3) break;
    log(`  renderer not ready, retry ${attempt}`);
    await sleep(500);
  }
  assert(setup.ok, 'setup: 隔离实例里建出项目与秘书会话', setup);
  await cdp.shot(path.join(ART, '01-sidebar.png'));
  if (MEMORY_ONLY) {
    await verifyMemoryManualEdit(cdp, setup);
    return;
  }
  await verifyAvatar(cdp, setup);
  const dispatchDirect = directDispatcher(page, setup);

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
    // 派发不再出确认卡：工具一返回会话就已经建好，看板上直接出现这条派出会话
    const secretary = await SEC();
    const card = await until(() => {
      const board = secretary.getState().secretary.board;
      return [...board.needsYou, ...board.running, ...board.done].find(
        (c) => c.kind === 'session' && c.title === ${JSON.stringify(draft.title)}
      ) ?? null;
    }, 30000);
    const tool = await until(() => {
      const node = [...document.querySelectorAll('[data-enso=tool-card]')].find((el) =>
        el.innerText.includes(${JSON.stringify(draft.title)})
      );
      node?.scrollIntoView({ block: 'center' });
      return node ?? null;
    }, 15000);
    const pending = Object.values(secretary.getState().secretary.proposals).filter(
      (p) => p.kind === 'dispatch' && p.status === 'pending'
    );
    return JSON.stringify({
      ok: Boolean(card),
      conversationId: card?.conversationId ?? null,
      toolCard: Boolean(tool),
      pendingDispatchCards: pending.length,
      proposalCard: Boolean(document.querySelector('[data-enso=secretary-proposal]')),
    });
  `);
  assert(proposed.ok, 'step3: 派活直接建出会话，看板上出现派出会话', proposed);
  assert(
    proposed.pendingDispatchCards === 0 && !proposed.proposalCard,
    'step3: 派活不再出待确认卡片',
    proposed
  );
  assert(proposed.toolCard, 'step3: 聊天里有派活的工具卡片', proposed);
  await cdp.shot(path.join(ART, '02-dispatch-card.png'));
  const dispatchedId = proposed.conversationId;

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
    await until(() => {
      const scroller = document.querySelector('[data-virtuoso-scroller]');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      return visible('[data-enso=secretary-updates]').length > 0;
    }, 30000);
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
  await sleep(1500);
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
  // 目标随派发一起带上：派发不再出卡，没有确认时的编辑可用
  const goalDispatch = await dispatchDirect('session_create', {
    projectId: setup.projectId,
    prompt: '创建 goal.txt',
    title: '写 goal.txt',
    goal: '收尾 [[tool:goal_complete {"summary":"goal.txt 已写好"}]]',
  });
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
  // 不存在的 id 走 not-found，真实但未授权的会话走 not-operable：两者都要写明原因，
  // 都不能退化成 invalid arguments（模型会当成参数写错而反复重试）。
  const deniedPrefixes = [
    'permission denied (not-operable)',
    'not found: no root session with this id',
  ];
  assert(
    deniedPrefixes.some((prefix) => deniedResult?.includes(prefix)) &&
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
      sendAudit.some((entry) => !entry.ok && ['not-operable', 'not-found'].includes(entry.detail)),
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

  log('== step5 再派一个活：直接建出，只多一个会话');
  const beforeCount = readJson(registryFile).conversations.filter(
    (entry) => entry.projectId === setup.projectId
  ).length;
  const secondDispatch = await dispatchDirect('session_create', {
    ...draft,
    prompt: '创建 notes.md，写一行说明',
    title: '写 notes.md',
  });
  assert(secondDispatch.ok, 'step5: 第二个派活直接建出会话', secondDispatch);
  const projectConversations = await waitFor(
    () => {
      const rows = readJson(registryFile).conversations.filter(
        (entry) => entry.projectId === setup.projectId
      );
      return rows.length > beforeCount ? rows : null;
    },
    'second dispatch persisted',
    15_000,
    250
  ).catch(() =>
    readJson(registryFile).conversations.filter((entry) => entry.projectId === setup.projectId)
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
  const createAudit = readFileSync(auditFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter(
      (entry) => entry.op === 'session_create' && entry.targetId === secondDispatch.conversationId
    );
  assert(
    createAudit.length === 1 && createAudit[0].ok && createAudit[0].detail === 'created',
    'step5: audit 里这次派发只有一条 created',
    createAudit
  );
  assert(
    !Object.values(dispatchFinal.proposals).some(
      (proposal) => proposal.kind === 'dispatch' && proposal.status === 'pending'
    ),
    'step5: 派发没有留下待确认卡',
    dispatchFinal.proposals
  );

  // 造一条进行中的派出记录：设置面板改成 1 后，新派发当场被拒
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
  const seededState = readJson(dispatchFile).dispatched[dispatchedId].lastState;

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
  // 进行中标记写在确认前一刻。host 的 tick 和会话事件会按真实状态把 lastState 改回去
  const limitSeedNow = readJson(dispatchFile);
  limitSeedNow.dispatched[dispatchedId].lastState = 'running';
  writeFileSync(dispatchFile, JSON.stringify(limitSeedNow));
  const refused = await dispatchDirect('session_create', {
    ...draft,
    prompt: '创建 limit.txt',
    title: '写 limit.txt',
  });
  assert(
    !refused.ok && /dispatch-limit/.test(refused.error ?? ''),
    'step5b: 不重启秘书，派发时按新上限 1 拒绝',
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
  await closeSettingsWindow(settingsPage);
  const unseed = readJson(dispatchFile);
  unseed.dispatched[dispatchedId].lastState = seededState;
  writeFileSync(dispatchFile, JSON.stringify(unseed));

  log('== 秘书面板');
  const board = await page(`
    S().selectConversation(${JSON.stringify(setup.secretaryId)});
    await sleep(300);
    const toggles = [...document.querySelectorAll('button')].filter(
      (b) => b.getAttribute('aria-label') === '新建标签页' && b.offsetParent !== null
    );
    toggles.at(-1)?.click();
    const item = await until(() => document.querySelector('[data-enso=secretary-panel-open]'), 5000);
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
  // 日报（daily）是 SecretaryPanel 的 TABS 里第二个标签，顺序即渲染顺序
  assert(
    board.tabs?.join(',') === 'workbench,daily,memory,schedules,contact,skills',
    '秘书面板六个标签（技能排在联系方式后面）',
    board.tabs
  );
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
  // 两条都要跑过 Main 每 30 秒一次的 lastEventAt 补存，磁盘上才看得到运行期间的活动
  const feedA = await dispatchSlow('动态时间 A', firstMinute + 60_000);
  // 等到墙钟进入下一分钟再派第二个，两条的开始时间落在不同的分钟里
  await waitFor(
    () => Math.floor(Date.now() / 60_000) > Math.floor(feedA.createdAt / 60_000) || null,
    'next minute',
    70_000,
    250
  );
  await sleep(1000);
  const feedB = await dispatchSlow('动态时间 B', 45_000);
  const feedIds = [feedB.conversationId, feedA.conversationId];
  const feedSamples = [];
  for (let index = 0; index < 6; index += 1) {
    await sleep(index === 0 ? 1500 : 2000);
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
      if (!sameClock(entry.row?.text, since[id]))
        issues.push(
          `clock is not the start time: row=${JSON.stringify(entry.row?.text)} want=${clockOf(since[id]).join(':')}`
        );
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
  // lastEventAt 单独变化不立即落盘（#298），等到两条都还在跑时的那次补存
  const busy = await waitFor(
    () => {
      const file = readJson(dispatchFile).dispatched;
      return feedIds.every(
        (id) => file[id]?.lastState === 'running' && file[id].lastEventAt > since[id] + 5000
      )
        ? file
        : null;
    },
    'running activity persisted',
    40_000,
    500
  ).catch(() => readJson(dispatchFile).dispatched);
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
  const resultCard = await page(`
    const button = await until(() => visible('[data-enso=secretary-dismiss-result]')[0] ?? null, 15000);
    if (!button) return JSON.stringify({ ok: false });
    const card = button.closest('[data-enso=secretary-card]');
    return JSON.stringify({
      ok: Boolean(card) && Boolean(card.closest('[data-enso=secretary-needs-you]')),
      text: card?.innerText,
    });
  `);
  assert(resultCard.ok, 'step8: 失败结果卡挂在需要你处理', resultCard);
  await cdp.shot(path.join(ART, '06-result-card.png'));
  const dismissed = await page(`
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
  const waitDispatch = await dispatchDirect('session_create', {
    projectId: setup.projectId,
    prompt: '跑全量测试',
    title: '等后台任务',
    goal: '跑完测试 [[tool:goal_wait {"reason":"真机验收已在后台运行，完成后会通知我"}]]',
  });
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
  await sleep(2000);
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

  // 派出的会话默认无人值守，但 ask_user 不再被直接拒绝：提问先转给秘书，秘书用 session_answer
  // 代答，原会话拿到答案继续跑。这一步不需要临时关掉无人值守。
  log('== step9b 派出会话的 ask_user 先转给秘书');
  const askDispatch = await dispatchDirect('session_create', {
    projectId: setup.projectId,
    prompt: '选方案 [[tool:ask_user {"question":"用哪个方案？","options":["A","B"]}]]',
    title: '真提问',
  });
  assert(askDispatch.ok, 'step9: 会提问的派出会话建成', askDispatch);
  const askId = askDispatch.conversationId;
  const relayRecord = await waitFor(
    () => {
      const relays = readJson(dispatchFile).relays ?? {};
      return (
        Object.values(relays).find(
          (relay) => relay.conversationId === askId && relay.status === 'pending'
        ) ?? null
      );
    },
    'ask relay recorded',
    60_000,
    500
  );
  assert(relayRecord.question.includes('用哪个方案'), 'step9: 提问原文进了转交记录', relayRecord);
  assert(relayRecord.options?.join(',') === 'A,B', 'step9: 选项一起转交', relayRecord);
  assert(
    !readJson(dispatchFile).dispatched[askId]?.lastResult,
    'step9: 转交的提问不再记 needs-user',
    readJson(dispatchFile).dispatched[askId]
  );
  const relaySeen = await waitFor(
    () => secretarySaw(askDispatch.secretaryId, askId, 'ask-relay'),
    'secretary got ask-relay',
    60_000,
    500
  ).catch(() => false);
  assert(relaySeen, 'step9: 秘书收到该会话的 ask-relay 回传', askId);
  const relayedCard = await page(`
    const id = ${JSON.stringify(askId)};
    const ask = await until(() => (S().conversations[id]?.pendingAsks ?? [])[0] ?? null, 15000);
    return JSON.stringify({ relay: ask?.relay ?? null, question: ask?.question ?? null });
  `);
  assert(relayedCard.relay?.name, 'step9: 原会话的提问卡标着已转给秘书', relayedCard);
  const answered = await secretaryTool(
    cdp,
    setup,
    'session_answer',
    { conversationId: askId, askId: relayRecord.askId, answer: 'A' },
    '替它决定用哪个方案'
  );
  assert(
    answered.text?.includes('"status":"answered"'),
    'step9: 秘书用 session_answer 代答成功',
    answered
  );
  const continued = await page(`
    const id = ${JSON.stringify(askId)};
    const cleared = await until(
      () => (S().conversations[id]?.pendingAsks ?? []).length === 0,
      30000
    );
    return JSON.stringify({ cleared: Boolean(cleared) });
  `);
  assert(continued.cleared, 'step9: 回答后原会话的提问卡消失', continued);
  await waitFor(
    () => (readJson(dispatchFile).dispatched[askId]?.lastState === 'idle' ? true : null),
    'ask session idle',
    60_000,
    500
  );
  const answeredRecord = readJson(dispatchFile).relays?.[`${askId}|${relayRecord.askId}`];
  assert(
    answeredRecord?.status === 'answered' && answeredRecord.answer === 'A',
    'step9: 转交记录收尾为已代答',
    answeredRecord
  );
  const relayAudit = auditLines().filter(
    (entry) => entry.targetId === askId && String(entry.op).startsWith('ask_relay')
  );
  assert(
    relayAudit.some((entry) => entry.op === 'ask_relay') &&
      relayAudit.some((entry) => entry.op === 'ask_relay_answer'),
    'step9: 转交与代答都记了审计',
    relayAudit
  );

  log('== step10 待办派出的会话标题用待办文本');
  const todoText = '修复秘书通知误报';
  const todoAdded = await page(`
    return JSON.stringify(await window.electronAPI.secretary.mutateTodo({
      action: 'add', text: ${JSON.stringify(todoText)}, projectId: ${JSON.stringify(setup.projectId)},
    }));
  `);
  assert(todoAdded.ok, 'step10: 建出带项目的待办', todoAdded);
  const todoDispatch = await dispatchDirect('todo_item_dispatch', {
    todoId: todoAdded.todoId,
    prompt: '背景：秘书功能在 feat/secretary-agent 分支上开发，这个分支检出在别处',
  });
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
  const bgDispatch = await dispatchDirect('session_create', {
    projectId: setup.projectId,
    prompt: '把检查放到后台',
    title: '等后台续跑',
    goal: '先把检查丢到后台再等通知 [[tool:bash {"command":"sleep 12","background":true}]]',
  });
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
  // 还在跑的后台任务（sleep 12）不该被看门狗当成「后台进程已退出」
  assert(
    bgSettled.lastResult?.kind !== 'stalled' &&
      !(await secretarySaw(bgDispatch.secretaryId, bgId, 'stalled')),
    'step11: 等还在跑的后台任务时不报停住',
    bgSettled.lastResult
  );
  await sleep(2500);
  const bgAfter = readJson(dispatchFile).dispatched[bgId];
  assert(bgAfter.lastState !== 'error', 'step11: 等过收口窗口会话仍不是 error', bgAfter);
  assert(
    !(await secretarySaw(bgDispatch.secretaryId, bgId, 'goal-blocked')) &&
      !(await secretarySaw(bgDispatch.secretaryId, bgId, 'failed')),
    'step11: 秘书没收到该会话的 goal-blocked 或 failed',
    bgId
  );

  const blockedDispatch = await dispatchDirect('session_create', {
    projectId: setup.projectId,
    prompt: '停下来',
    title: '真受阻',
    goal: '缺决定 [[tool:goal_blocked {"reason":"缺一个只有用户知道的决定"}]]',
  });
  assert(blockedDispatch.ok, 'step11: 会调用 goal_blocked 的会话建成', blockedDispatch);
  const blockedId = blockedDispatch.conversationId;
  const blockedSeen = await waitFor(
    () => secretarySaw(blockedDispatch.secretaryId, blockedId, 'goal-blocked'),
    'secretary got goal-blocked',
    60_000,
    400
  ).catch(() => false);
  assert(blockedSeen, 'step11: 真正调用 goal_blocked 时秘书能收到', blockedId);
  await sleep(2500);
  assert(
    (await secretaryCount(blockedDispatch.secretaryId, blockedId, 'goal-blocked')) === 1,
    'step11: goal-blocked 只推一次',
    await secretaryCount(blockedDispatch.secretaryId, blockedId, 'goal-blocked')
  );

  const completeDispatch = await dispatchDirect('session_create', {
    projectId: setup.projectId,
    prompt: '写完就停',
    title: '真完成',
    goal: '收尾 [[tool:goal_complete {"summary":"step11 文件已写好"}]]',
  });
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
  await sleep(1500);
  assert(
    (await secretaryCount(completeDispatch.secretaryId, completeId, 'goal-complete')) === 1,
    'step11: goal-complete 只推一次',
    await secretaryCount(completeDispatch.secretaryId, completeId, 'goal-complete')
  );

  log('== step12 目标会话的中间轮不打扰，完成时才开口');
  const quietDispatch = await dispatchDirect('session_create', {
    projectId: setup.projectId,
    prompt: '连续检查几轮',
    title: '连续验收',
    goal: '把检查做完。先不要调用 goal_complete 或 goal_blocked',
  });
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
    const cards = [...board.running, ...board.done, ...board.needsYou].filter(
      (card) => card.kind === 'session' && card.conversationId === ${JSON.stringify(quietId)}
    );
    const quietId = ${JSON.stringify(quietId)};
    let before = null;
    let activity = 0;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await window.electronAPI.secretary.feed(
        before ? { before, limit: 40 } : { limit: 40 }
      );
      if (!page.ok) break;
      activity += page.events.filter(
        (event) => event.conversationId === quietId && event.id.startsWith('activity:')
      ).length;
      const oldest = page.events.at(-1);
      if (!page.hasMore || !oldest) break;
      before = { at: oldest.at, id: oldest.id };
    }
    return JSON.stringify({ activity, cards: cards.length, title: cards[0]?.title ?? null });
  `);
  assert(quietFeed.activity >= 1 && quietFeed.cards === 1, 'step12: 动态里能看到这几轮', quietFeed);

  const bgQuiet = await dispatchDirect('session_create', {
    projectId: setup.projectId,
    prompt: '把检查放到后台',
    title: '后台别打扰',
    goal: '先放后台再等 [[tool:bash {"command":"sleep 8","background":true}]]',
  });
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

  const doneDispatch = await dispatchDirect('session_create', {
    projectId: setup.projectId,
    prompt: '收尾',
    title: '合并后开口',
    goal: '收尾 [[tool:goal_complete {"summary":"step12 做完了"}]]',
  });
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

  log('== step11 待办能读、派发后进行中、完成后打勾');
  const todosFile = path.join(ENV, 'secretary', 'todos.json');
  const boardText = '看板验收待办';
  const boardAdded = await page(`
    return JSON.stringify(await window.electronAPI.secretary.mutateTodo({
      action: 'add',
      text: ${JSON.stringify(boardText)},
      projectId: ${JSON.stringify(setup.projectId)},
    }));
  `);
  assert(boardAdded.ok, 'step11: 建出待办', boardAdded);
  const beforeBoard = await page(`
    document.querySelector('[data-enso=secretary-panel-tab][data-tab=workbench]')?.click();
    const row = await until(
      () => [...document.querySelectorAll('[data-enso=secretary-todo]')]
        .find((node) => node.innerText.includes(${JSON.stringify(boardText)})) ?? null,
      15000
    );
    return JSON.stringify({
      phase: row?.getAttribute('data-phase') ?? null,
      text: row?.innerText ?? null,
    });
  `);
  assert(beforeBoard.phase === 'todo', 'step11: 派发前待办在待办列', beforeBoard);
  await cdp.shot(path.join(ART, '11-todo-before.png'));
  const listedOpen = await secretaryTool(
    cdp,
    setup,
    'todo_list',
    { status: 'todo', projectId: setup.projectId },
    '列出这个项目还没派的待办'
  );
  const openRows = listedTodos(listedOpen);
  const openRow = openRows.find((item) => item.id === boardAdded.todoId);
  assert(
    openRow?.status === 'todo' &&
      openRow.projectId === setup.projectId &&
      openRow.text.includes(`<untrusted-content source="todo:${boardAdded.todoId}">`) &&
      openRow.text.includes(boardText),
    'step11: todo_list 看到真实待办状态，正文是不可信内容',
    openRow ?? listedOpen.text
  );

  const activeDispatch = await dispatchDirect('todo_item_dispatch', {
    todoId: boardAdded.todoId,
    prompt: '先把这件事做起来',
    title: '看板验收会话',
  });
  assert(activeDispatch.ok, 'step11: 待办派出发了', activeDispatch);
  const shownActive = await page(`
    document.querySelector('[data-enso=secretary-panel-tab][data-tab=workbench]')?.click();
    const row = await until(() => {
      const node = document.querySelector(
        '[data-enso=secretary-todo][data-session=${JSON.stringify(activeDispatch.conversationId)}]'
      );
      return node?.getAttribute('data-phase') === 'active' ? node : null;
    }, 20000);
    return JSON.stringify({
      phase: row?.getAttribute('data-phase') ?? null,
      text: row?.innerText ?? null,
    });
  `);
  assert(
    shownActive.phase === 'active' && shownActive.text.includes('看板验收会话'),
    'step11: 派发后待办进入进行中并显示会话',
    shownActive
  );
  await cdp.shot(path.join(ART, '12-todo-active.png'));
  const listedActive = await secretaryTool(
    cdp,
    setup,
    'todo_list',
    { status: 'active' },
    '列出进行中的待办'
  );
  const activeRow = listedTodos(listedActive).find((item) => item.id === boardAdded.todoId);
  assert(
    activeRow?.status === 'active' &&
      activeRow.conversationId === activeDispatch.conversationId &&
      typeof activeRow.sessionState === 'string',
    'step11: todo_list 能看到进行中和关联会话',
    activeRow ?? listedActive.text
  );

  const goaled = await page(`
    return JSON.stringify(await window.electronAPI.secretary.goalAction({
      conversationId: ${JSON.stringify(activeDispatch.conversationId)},
      action: 'set',
      text: '收尾 [[tool:goal_complete {"summary":"看板待办做完了"}]]',
    }));
  `);
  assert(goaled.ok !== false, 'step11: 给派出会话设了完成目标', goaled);
  const autoDone = await waitFor(
    () => {
      const record = readJson(dispatchFile).dispatched[activeDispatch.conversationId];
      const todo = readJson(todosFile).find((item) => item.id === boardAdded.todoId);
      return record?.lastResult?.kind === 'goal-complete' &&
        record.lastState !== 'running' &&
        todo?.doneAt
        ? todo
        : null;
    },
    'todo auto completed',
    60_000,
    500
  ).catch(() => null);
  assert(Boolean(autoDone), 'step11: 会话 goal-complete 并结束后待办自动打勾', {
    record: readJson(dispatchFile).dispatched[activeDispatch.conversationId],
    todo: readJson(todosFile).find((item) => item.id === boardAdded.todoId),
  });
  const leftBoard = await page(`
    document.querySelector('[data-enso=secretary-panel-tab][data-tab=workbench]')?.click();
    const gone = await until(
      () => !document.querySelector(
        '[data-enso=secretary-todo][data-session=${JSON.stringify(activeDispatch.conversationId)}]'
      ),
      15000
    );
    return JSON.stringify({ gone: Boolean(gone) });
  `);
  assert(leftBoard.gone, 'step11: 完成后看板不用手动刷新就离开进行中', leftBoard);
  await cdp.shot(path.join(ART, '13-todo-done.png'));

  log('== step11b 完成后被 session_send 唤起，在跑计数加回来');
  const quiet = await page(`
    const secretary = await SEC();
    const board = secretary.getState().secretary.board;
    const running = board.running
      .filter((card) => card.kind === 'session')
      .map((card) => card.conversationId);
    return JSON.stringify({ running });
  `);
  assert(
    !quiet.running.includes(activeDispatch.conversationId),
    'step11b: 完成后不在在跑里',
    quiet
  );
  const woken = await secretaryTool(
    cdp,
    setup,
    'session_send',
    {
      conversationId: activeDispatch.conversationId,
      message: '接着做，先别结束 [[slow:8000]]',
    },
    '把做完的会话再叫起来'
  );
  assert(
    woken.text?.includes('"sent"') || woken.text?.includes('"queued"'),
    'step11b: session_send 成功',
    woken
  );
  const counted = await page(`
    document.querySelector('[data-enso=secretary-panel-tab][data-tab=workbench]')?.click();
    const secretary = await SEC();
    const back = await until(() => {
      const board = secretary.getState().secretary.board;
      const running = board.running
        .filter((card) => card.kind === 'session')
        .map((card) => card.conversationId);
      return running.includes(${JSON.stringify(activeDispatch.conversationId)}) ? running : null;
    }, 20000);
    const summary = document.querySelector('[data-enso=secretary-summary]')?.innerText ?? '';
    const stats = [...document.querySelectorAll('[data-enso=secretary-stat]')].map((node) => node.innerText);
    return JSON.stringify({ running: back, summary, stats });
  `);
  assert(Array.isArray(counted.running), 'step11b: 唤起后重新计为进行中', counted);
  const runningText = String(counted.running.length);
  assert(
    counted.summary.includes(runningText) &&
      counted.stats.some((text) => text.includes(runningText)),
    'step11b: 顶栏和看板上的进行中是同一个数',
    counted
  );

  log('== step12 同时改文字和完成，面板自己更新');
  const staleText = '旧文字待办';
  const freshText = '新文字待办';
  const stale = await page(`
    const added = await window.electronAPI.secretary.mutateTodo({
      action: 'add',
      text: ${JSON.stringify(staleText)},
      projectId: ${JSON.stringify(setup.projectId)},
    });
    document.querySelector('[data-enso=secretary-panel-tab][data-tab=workbench]')?.click();
    const row = await until(
      () => [...document.querySelectorAll('[data-enso=secretary-todo]')]
        .find((node) => node.innerText.includes(${JSON.stringify(staleText)})) ?? null,
      15000
    );
    return JSON.stringify({ ok: added.ok, todoId: added.todoId, shown: Boolean(row) });
  `);
  assert(stale.ok && stale.shown, 'step12: 旧文字先出现在看板上', stale);
  await cdp.shot(path.join(ART, '14-todo-stale.png'));
  const edited = await secretaryTool(
    cdp,
    setup,
    'todo_item_update',
    { todoId: stale.todoId, done: true, text: freshText },
    '把这条待办改掉并完成'
  );
  assert(edited.text?.includes(stale.todoId), 'step12: 同时传 done 和 text 返回成功', edited);
  const editedTodo = readJson(todosFile).find((item) => item.id === stale.todoId);
  assert(
    editedTodo?.text === freshText && typeof editedTodo.doneAt === 'number',
    'step12: 磁盘上的文字和完成状态一起生效',
    editedTodo
  );
  const refreshed = await page(`
    document.querySelector('[data-enso=secretary-panel-tab][data-tab=workbench]')?.click();
    const cleared = await until(
      () => ![...document.querySelectorAll('[data-enso=secretary-todo]')]
        .some((node) => node.innerText.includes(${JSON.stringify(staleText)})),
      15000
    );
    return JSON.stringify({ cleared: Boolean(cleared) });
  `);
  assert(refreshed.cleared, 'step12: 面板不用手动刷新就不再显示旧文字', refreshed);
  const listedDone = await secretaryTool(
    cdp,
    setup,
    'todo_list',
    { status: 'done' },
    '列出已完成的待办'
  );
  const doneRow = listedTodos(listedDone).find((item) => item.id === stale.todoId);
  assert(
    doneRow?.status === 'done' && doneRow.text.includes(freshText),
    'step12: todo_list 读到新文字和已完成',
    doneRow ?? listedDone.text
  );
  await cdp.shot(path.join(ART, '15-todo-updated.png'));

  log('== step13 看板发送带上项目和 worktree');
  const boardSendTitle = '看板发送验收';
  // 派发本来就直接执行、待办默认开 worktree：这里只把并发上限临时放宽
  const allowBoardSend = await page(`
    return JSON.stringify(await window.electronAPI.secretary.saveProfile({ maxRunningDispatches: 10 }));
  `);
  assert(allowBoardSend.ok, 'step13: 临时放宽并发上限', allowBoardSend);
  const boardSendAdded = await page(`
    return JSON.stringify(await window.electronAPI.secretary.mutateTodo({
      action: 'add',
      text: ${JSON.stringify(boardSendTitle)},
      projectId: ${JSON.stringify(setup.projectId)},
    }));
  `);
  assert(boardSendAdded.ok, 'step13: 建出只有标题的待办', boardSendAdded);
  const boardSent = await page(`
    document.querySelector('[data-enso=secretary-panel-tab][data-tab=workbench]')?.click();
    const row = await until(
      () => [...document.querySelectorAll('[data-enso=secretary-todo]')]
        .find((node) => node.innerText.includes(${JSON.stringify(boardSendTitle)}) && node.getAttribute('data-phase') === 'todo') ?? null,
      15000
    );
    row?.querySelector('[data-enso=secretary-todo-dispatch]')?.click();
    const conversationId = await until(() => {
      const node = [...document.querySelectorAll('[data-enso=secretary-todo]')]
        .find((candidate) => candidate.innerText.includes(${JSON.stringify(boardSendTitle)}) && candidate.getAttribute('data-phase') === 'active');
      return node?.getAttribute('data-session') || null;
    }, 20000);
    return JSON.stringify({ clicked: Boolean(row), conversationId });
  `);
  assert(boardSent.conversationId, 'step13: 点发送后待办进入进行中并关联会话', boardSent);
  await cdp.shot(path.join(ART, '16-todo-dispatch.png'));
  const boardPrompt = await waitFor(() => {
    const row = conversationsIn()?.[boardSent.conversationId];
    if (!row?.sessionFile) return null;
    let text = '';
    try {
      text = readFileSync(row.sessionFile, 'utf8');
    } catch {
      return null;
    }
    if (!text.includes('worktree')) return null;
    return { text, worktree: row?.worktree?.path ?? null };
  }, 'step13 prompt').catch((error) => ({ text: '', worktree: null, error: String(error) }));
  await page(`
    return JSON.stringify(await window.electronAPI.secretary.saveProfile({ maxRunningDispatches: 3 }));
  `);
  assert(
    boardPrompt.text?.includes(boardSendTitle) &&
      boardPrompt.text.includes(PROJ) &&
      boardPrompt.text.includes('worktree') &&
      boardPrompt.text.includes('不推送') &&
      boardPrompt.text !== boardSendTitle,
    'step13: 第一条消息包含项目和 worktree，不只是待办标题',
    boardPrompt
  );
  assert(
    typeof boardPrompt.worktree === 'string' && boardPrompt.worktree.length > 0,
    'step13: 会话落在独立 worktree',
    boardPrompt
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
  await verifyFeedPaging(cdp, panelHost);
  await verifyTelegramContact(cdp, setup);

  copyFileSync(auditFile, path.join(ART, 'audit.jsonl'));
  log(`  copied ${path.join(ART, 'audit.jsonl')}`);

  await verifyMemoryManualEdit(cdp, setup);
  await verifyImageViewAndCleanup(cdp, setup);
  await verifyForwardImages(cdp, setup);
  await verifyToolCards(cdp, setup);
  // 多秘书段会新建秘书、绑话题、换 token，放在全部单秘书回归之后，不污染它们的前提
  await verifyMultiSecretary(cdp, setup);
}

/**
 * 照 Telegram 的规则校验按钮：url 只认 http(s) 与 tg://（enso:// 会被整条拒掉），
 * callback_data 最多 64 字节。返回错误描述，合法时返回 null。
 */
function keyboardError(markup) {
  for (const row of markup?.inline_keyboard ?? []) {
    for (const button of row) {
      if (!button.callback_data && !button.url) return 'Bad Request: BUTTON_DATA_INVALID';
      if (button.callback_data && Buffer.byteLength(button.callback_data) > 64) {
        return 'Bad Request: BUTTON_DATA_INVALID';
      }
      if (button.url && !/^(?:https?:\/\/|tg:\/\/)/iu.test(button.url)) {
        return 'Bad Request: BUTTON_URL_INVALID';
      }
    }
  }
  return null;
}

/**
 * 假 Telegram Bot API：只实现联系方式要用的几个方法。
 * 用例通过 push() 注入「用户在手机上做了什么」，出站全部记在 sent 里。
 */
async function startFakeTelegram(port) {
  const state = {
    token: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
    /** 第二个 bot：多秘书验收用，各开各的轮询 */
    tokens: {
      '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw': {
        id: 424242,
        is_bot: true,
        username: 'enso_verify_bot',
        first_name: 'Enso Verify',
      },
      '987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw': {
        id: 424243,
        is_bot: true,
        username: 'enso_verify_bot_2',
        first_name: 'Enso Verify 2',
      },
    },
    /** 每个 token 正在挂着的 getUpdates 数：同一时刻最多一个才算「一个轮询」 */
    polling: {},
    maxPolling: {},
    me: { id: 424242, is_bot: true, username: 'enso_verify_bot', first_name: 'Enso Verify' },
    sent: [],
    edited: [],
    /** 每次 setMyCommands 连 scope 与 language_code 一起记 */
    commands: [],
    deleted: [],
    menuButtons: [],
    callbacks: [],
    /** 「正在输入…」：只记 chat 与 action */
    chatActions: [],
    /** 只换按钮不动正文的那些调用 */
    markupEdits: [],
    polls: 0,
    queue: [],
    queues: {},
    waiters: [],
  };
  /** 按 token 分开排队：两个 bot 各收各的更新 */
  const push = (update, token = state.token) => {
    const waiter = state.waiters.find((entry) => entry.token === token);
    if (waiter) {
      state.waiters = state.waiters.filter((entry) => entry !== waiter);
      waiter.fn([update]);
    } else if (token === state.token) state.queue.push(update);
    else {
      const queue = state.queues[token] ?? [];
      state.queues[token] = queue;
      queue.push(update);
    }
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
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        body = {};
      }
      const me = state.tokens[token];
      if (!me) {
        reply({ ok: false, error_code: 401, description: 'Unauthorized' });
        return;
      }
      if (state.polls <= 2 || method !== 'getUpdates') log(`  tg: ${method}`);
      if (method === 'getMe') {
        reply({ ok: true, result: me });
        return;
      }
      if (method === 'getUpdates') {
        state.polls += 1;
        state.polling[token] = (state.polling[token] ?? 0) + 1;
        state.maxPolling[token] = Math.max(state.maxPolling[token] ?? 0, state.polling[token]);
        const release = () => {
          state.polling[token] -= 1;
        };
        response.on('close', release);
        let queue = state.queue;
        if (token !== state.token) {
          queue = state.queues[token] ?? [];
          state.queues[token] = queue;
        }
        if (queue.length > 0) {
          reply({ ok: true, result: queue.splice(0) });
          return;
        }
        const waiter = { token, fn: (updates) => reply({ ok: true, result: updates }) };
        state.waiters.push(waiter);
        // 长轮询挂 2 秒回空：客户端自己再来，验收结束时不会留下挂死的请求
        const timer = setTimeout(() => {
          state.waiters = state.waiters.filter((entry) => entry !== waiter);
          reply({ ok: true, result: [] });
        }, 2000);
        // 注意听 response 的 close：request 的 close 在请求体读完就触发，
        // 会把这次长轮询的回复一起取消掉，客户端只能干等超时
        response.on('close', () => {
          clearTimeout(timer);
          state.waiters = state.waiters.filter((entry) => entry !== waiter);
        });
        return;
      }
      if (method === 'sendMessage') {
        const invalid = keyboardError(body.reply_markup);
        if (invalid) {
          reply({ ok: false, error_code: 400, description: invalid });
          return;
        }
        const messageId = state.sent.length + 1;
        state.sent.push({ ...body, message_id: messageId });
        reply({ ok: true, result: { message_id: messageId } });
        return;
      }
      if (method === 'sendChatAction') {
        state.chatActions.push({ chat_id: body.chat_id, action: body.action });
        reply({ ok: true, result: true });
        return;
      }
      if (method === 'editMessageText') {
        const invalid = keyboardError(body.reply_markup);
        if (invalid) {
          reply({ ok: false, error_code: 400, description: invalid });
          return;
        }
        state.edited.push(body);
        const target = state.sent.find((message) => message.message_id === body.message_id);
        if (target) {
          target.text = body.text;
          target.reply_markup = body.reply_markup;
        }
        reply({ ok: true, result: true });
        return;
      }
      if (method === 'editMessageReplyMarkup') {
        const invalid = keyboardError(body.reply_markup);
        if (invalid) {
          reply({ ok: false, error_code: 400, description: invalid });
          return;
        }
        state.markupEdits.push(body);
        const target = state.sent.find((message) => message.message_id === body.message_id);
        if (target) target.reply_markup = body.reply_markup;
        reply({ ok: true, result: true });
        return;
      }
      if (method === 'setMyCommands') {
        state.commands.push({
          commands: body.commands ?? [],
          scope: body.scope,
          language_code: body.language_code,
        });
        reply({ ok: true, result: true });
        return;
      }
      if (method === 'deleteMyCommands') {
        state.deleted.push({ scope: body.scope, language_code: body.language_code });
        reply({ ok: true, result: true });
        return;
      }
      if (method === 'setChatMenuButton') {
        state.menuButtons.push(body.menu_button);
        reply({ ok: true, result: true });
        return;
      }
      if (method === 'answerCallbackQuery') {
        state.callbacks.push(body);
        reply({ ok: true, result: true });
        return;
      }
      reply({ ok: false, error_code: 400, description: 'Unsupported method' });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { ...state, push, server, state };
}

/**
 * 把假 Telegram 收到的卡片消息按 Telegram 的样子画在页面上截一张图。
 * 正文与按钮都取自真实出站 payload，所以这张图就是手机上会看到的样子。
 */
async function shotTelegramCard(cdp, message, file) {
  const rect = await cdp.json(`
    document.getElementById('tg-card-preview')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'tg-card-preview';
    wrap.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
      'background:#0e1621;font-family:-apple-system,system-ui,sans-serif';
    const chat = document.createElement('div');
    chat.style.cssText = 'width:560px;padding:24px';
    const bubble = document.createElement('div');
    bubble.style.cssText =
      'background:#182533;color:#f5f5f5;border-radius:14px;padding:14px 16px;font-size:15px;' +
      'line-height:1.55;white-space:pre-wrap;word-break:break-word';
    bubble.innerHTML = ${JSON.stringify(message.text)};
    for (const code of bubble.querySelectorAll('code')) {
      code.style.cssText =
        'font-family:ui-monospace,Menlo,monospace;background:#0f1a26;border-radius:4px;' +
        'padding:1px 4px;font-size:12.5px;color:#9ad1ff';
    }
    const keyboard = document.createElement('div');
    keyboard.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:6px';
    for (const row of ${JSON.stringify(message.reply_markup?.inline_keyboard ?? [])}) {
      const line = document.createElement('div');
      line.style.cssText = 'display:flex;gap:6px';
      for (const button of row) {
        const node = document.createElement('div');
        node.textContent = button.text;
        node.style.cssText =
          'flex:1;text-align:center;background:#182533;color:#6ab3f3;border-radius:10px;' +
          'padding:11px 12px;font-size:15px;font-weight:500';
        line.appendChild(node);
      }
      keyboard.appendChild(line);
    }
    chat.append(bubble, keyboard);
    wrap.appendChild(chat);
    document.body.appendChild(wrap);
    await sleep(150);
    const box = chat.getBoundingClientRect();
    return JSON.stringify({
      x: Math.round(box.x) - 12,
      y: Math.round(box.y) - 12,
      width: Math.round(box.width) + 24,
      height: Math.round(box.height) + 24,
    });
  `);
  await cdp.shotClip(file, rect);
  await cdp.evaluate(`document.getElementById('tg-card-preview')?.remove(); 'ok'`);
}

/** 联系方式：绑定向导、里程碑出站、手机发话、按钮回答，全程打假 Telegram */
async function verifyTelegramContact(cdp, setup) {
  const page = cdp.json.bind(cdp);
  // state 是活对象（sent/polls 随轮询变），push 挂在返回的控制器上
  const tg = telegram.state;
  const push = telegram.push;
  const PANEL = `[...document.querySelectorAll('[data-enso=secretary-panel]')].find((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 300 && rect.height > 0;
  })`;

  log('== 联系方式：绑定向导第 1 步');
  const opened = await page(`
    const panelOf = () => ${PANEL};
    if (!panelOf()) {
      S().selectConversation(${JSON.stringify(setup.secretaryId)});
      await sleep(300);
      const toggles = [...document.querySelectorAll('button')].filter(
        (b) => b.getAttribute('aria-label') === '新建标签页' && b.offsetParent !== null
      );
      toggles.at(-1)?.click();
      const item = await until(() => document.querySelector('[data-enso=secretary-panel-open]'), 5000);
      item?.click();
      await sleep(800);
      [...document.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-label') === '折叠/展开右侧面板')
        ?.click();
      await sleep(1200);
    }
    const panel = panelOf();
    if (!panel) return JSON.stringify({ ok: false, error: 'no panel' });
    panel.querySelector('[data-enso=secretary-panel-tab][data-tab=contact]')?.click();
    const step1 = await until(
      () => panel.querySelector('[data-enso=secretary-contact-step1]'),
      8000
    );
    const botfather = panel.querySelector('[data-enso=secretary-contact-botfather]');
    const input = panel.querySelector('[data-enso=secretary-contact-token]');
    return JSON.stringify({
      ok: Boolean(step1 && botfather && input),
      href: botfather?.getAttribute('href') ?? null,
      tabs: [...panel.querySelectorAll('[data-enso=secretary-panel-tab]')].map((n) => n.dataset.tab),
      body: (panel.textContent ?? '').replace(/s+/g, ' ').slice(0, 240),
      active: panel.querySelector('[data-enso=secretary-panel-tab][data-active]')?.dataset.tab ?? null,
      state: await window.electronAPI.secretary.contactState('default').then((s) => ({
        enabled: s.enabled,
        status: s.telegram?.status,
        channels: (s.channels ?? []).map((c) => c.status),
        id: s.secretaryId,
        chat: s.telegram?.chat ?? null,
        routes: (s.telegram?.routes ?? []).length,
      })),
    });
  `);
  assert(opened.ok, '联系方式: 侧边栏有入口，第 1 步引导去 BotFather', opened);
  assert(
    opened.href === 'https://t.me/BotFather',
    '联系方式: 一键打开 BotFather 的链接',
    opened.href
  );
  assert(opened.tabs?.includes('contact'), '联系方式: 面板上有联系方式标签', opened.tabs);
  await cdp.shot(path.join(ART, '10-contact-step1.png'));

  log('== 联系方式：粘贴 token 校验并生成绑定码');
  const verified = await page(`
    const panel = ${PANEL};
    const input = panel.querySelector('[data-enso=secretary-contact-token]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(tg.token)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(120);
    panel.querySelector('[data-enso=secretary-contact-verify]').click();
    const code = await until(
      () => panel.querySelector('[data-enso=secretary-contact-code-value]'),
      20000
    );
    const qr = panel.querySelector('[data-enso=secretary-contact-qr]');
    const open = panel.querySelector('[data-enso=secretary-contact-open-bot]');
    return JSON.stringify({
      ok: Boolean(code),
      code: code?.textContent?.trim() ?? null,
      href: open?.getAttribute('href') ?? null,
      qr: Boolean(qr?.src?.startsWith('data:image/png')),
      verified: panel.querySelector('[data-enso=secretary-contact-verified]')?.innerText ?? null,
    });
  `);
  assert(
    verified.ok && /^\d{6}$/.test(verified.code ?? ''),
    '联系方式: 粘贴 token 后显示 6 位绑定码',
    verified
  );
  assert(
    verified.href === `https://t.me/enso_verify_bot?start=${verified.code}`,
    '联系方式: 深链带绑定码',
    verified.href
  );
  assert(verified.qr === true, '联系方式: 显示绑定二维码', verified);
  assert(
    verified.verified?.includes('@enso_verify_bot'),
    '联系方式: 显示 getMe 校验到的 bot 名字与 username',
    verified.verified
  );
  await cdp.shot(path.join(ART, '10-contact-step3.png'));

  log('== 联系方式：在 Telegram 里点 Start 完成绑定');
  push({
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: 777001, type: 'private' },
      from: { id: 777001, username: 'j3n5en', first_name: 'J' },
      text: `/start ${verified.code}`,
    },
  });
  const bound = await waitFor(
    async () => {
      const probe = await page(`
        const node = (${PANEL})?.querySelector('[data-enso=secretary-contact-bound]');
        const state = await window.electronAPI.secretary.contactState();
        return JSON.stringify({
          text: node?.innerText ?? null,
          status: state?.telegram?.status ?? null,
          poll: state?.telegram?.poll ?? null,
        });
      `);
      return probe.text?.includes('j3n5en') ? probe : null;
    },
    'telegram bound',
    20_000,
    500
  );
  assert(bound.text.includes('@j3n5en'), '联系方式: 界面立刻显示已绑定 @j3n5en', bound.text);
  await cdp.shot(path.join(ART, '10-contact-bound.png'));
  const welcome = tg.sent.find((message) => message.chat_id === 777001);
  assert(
    welcome?.text?.includes('已连上'),
    '联系方式: 绑定成功后 bot 发了一条欢迎消息',
    tg.sent.slice(-3)
  );

  log('== 联系方式：命令菜单注册');
  await waitFor(async () => tg.menuButtons.length > 0, 10_000, 200);
  const chatScoped = tg.commands.filter((call) => call.scope?.type === 'chat');
  assert(
    chatScoped.length > 0 && chatScoped.at(-1).scope.chat_id === 777001,
    '联系方式: 命令只注册到绑定的 chat（BotCommandScopeChat）',
    tg.commands.slice(-4)
  );
  const chatNames = chatScoped.at(-1)?.commands.map((entry) => entry.command) ?? [];
  assert(
    chatNames.includes('status') && chatNames.includes('board') && chatNames.includes('help'),
    '联系方式: chat scope 里是那几条只读命令',
    chatNames
  );
  assert(
    chatScoped.at(-1)?.commands.every((entry) => /[\u4e00-\u9fa5]/.test(entry.description)),
    '联系方式: 命令描述是中文',
    chatScoped.at(-1)?.commands
  );
  assert(
    tg.commands.some((call) => call.language_code === 'zh') &&
      tg.commands.some((call) => !call.scope && !call.language_code),
    '联系方式: 另注册一份 language_code=zh 与一份默认',
    tg.commands.slice(-4)
  );
  assert(
    tg.menuButtons.at(-1)?.type === 'commands',
    '联系方式: 左下角菜单按钮设成 commands',
    tg.menuButtons
  );
  assert(!chatNames.includes('memory'), '联系方式: 记忆关着时菜单里没有 /memory', chatNames);

  log('== 联系方式：里程碑出站遵循 notify');
  const dispatchDirect = directDispatcher(page, setup);
  const runDispatch = () =>
    dispatchDirect('session_create', {
      projectId: setup.projectId,
      prompt: '创建 tg.txt',
      title: '写 tg.txt',
      goal: '收尾 [[tool:goal_complete {"summary":"tg.txt 已写好"}]]',
    });
  const waitGoal = (conversationId) =>
    waitFor(
      () => {
        const record = readJson(dispatchFile).dispatched[conversationId];
        return record?.lastResult?.kind === 'goal-complete' && record.lastState === 'idle'
          ? record
          : null;
      },
      `goal-complete ${conversationId}`,
      90_000,
      500
    );

  // notify=off：做完也不发
  const quietRun = await runDispatch();
  assert(
    quietRun.ok && Boolean(quietRun.conversationId),
    '联系方式: 派出会话建成（notify=off）',
    quietRun
  );
  await waitGoal(quietRun.conversationId);
  await sleep(1500);
  assert(
    !tg.sent.some((message) => message.text?.includes('✅ 完成')),
    '联系方式: notify=off 时里程碑一条都不发',
    tg.sent.slice(-3)
  );

  // 改成 with-done：做完发一条，带会话标题与回应用的深链
  const notifySet = await page(`
    return JSON.stringify(await window.electronAPI.secretary.saveProfile({ notify: 'with-done' }));
  `);
  assert(notifySet.ok, '联系方式: 档案改成 with-done', notifySet);
  const loudRun = await runDispatch();
  assert(
    loudRun.ok && Boolean(loudRun.conversationId),
    '联系方式: 派出会话建成（notify=with-done）',
    loudRun
  );
  await waitGoal(loudRun.conversationId);
  const milestone = await waitFor(
    () => tg.sent.find((message) => message.text?.includes('✅ 完成')) ?? null,
    'telegram milestone',
    30_000,
    500
  );
  assert(milestone.parse_mode === 'HTML', '联系方式: 里程碑也带 parse_mode=HTML', milestone);
  assert(milestone.text.includes('写 tg.txt'), '联系方式: 里程碑带会话标题', milestone.text);
  assert(
    milestone.text.includes(`enso://secretary?conversation=${loudRun.conversationId}`),
    '联系方式: 里程碑带回应用的深链',
    milestone.text
  );
  assert(
    milestone.text.includes(
      `应用内链接（可复制）：<code>enso://secretary?conversation=${loudRun.conversationId}</code>`
    ),
    '联系方式: 里程碑的深链用等宽字体包起来，方便复制',
    milestone.text
  );

  log('== 联系方式：ask_user 从手机按钮回答');
  const ask = await page(`
    const secretary = await SEC();
    const id = await secretary.getState().newSecretaryConversation();
    S().selectConversation(id);
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    await S().send(
      '问一下 [[tool:ask_user {"question":"用哪个分支？","options":["main","dev"]}]]',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      id
    );
    const pending = await until(() => (S().conversations[id]?.pendingAsks ?? [])[0] ?? null, 40000);
    return JSON.stringify({
      ok: Boolean(pending),
      requestId: pending?.requestId ?? null,
      conversationId: id,
    });
  `);
  assert(ask.ok, '联系方式: 秘书的 ask_user 挂起', ask);
  const askMessage = await waitFor(
    () => tg.sent.find((message) => message.text?.includes('用哪个分支？')) ?? null,
    'telegram ask',
    20_000,
    300
  );
  const buttons = askMessage.reply_markup?.inline_keyboard?.flat() ?? [];
  assert(
    buttons.map((button) => button.text).join(',') === 'main,dev',
    '联系方式: 提问带 inline 选项按钮',
    buttons
  );
  push({ update_id: 2, callback_query: { id: 'cb-verify-1', data: buttons[1].callback_data } });
  const answered = await waitFor(
    async () => {
      const state = await page(`
        const row = S().conversations[${JSON.stringify(ask.conversationId)}];
        return JSON.stringify({
          pending: (row?.pendingAsks ?? []).length,
          // 回答落在工具结果里，不是 text 段：整条消息序列化后再找
          text: (row?.messages ?? []).map((message) => JSON.stringify(message.content ?? '')).join(' '),
        });
      `);
      return state.pending === 0 ? state : null;
    },
    'ask answered from telegram',
    30_000,
    500
  );
  assert(answered.pending === 0, '联系方式: 手机点按钮后提问收尾', answered);
  assert(answered.text.includes('dev'), '联系方式: 回答进了秘书会话', answered.text);
  assert(
    tg.callbacks.some((callback) => callback.text?.includes('已回答')),
    '联系方式: 手机收到「已回答」提示',
    tg.callbacks
  );

  log('== 联系方式：手机发话进秘书会话，回复再发回手机');
  const sentBefore = tg.sent.length;
  const actionsBefore = tg.chatActions.length;
  push({
    update_id: 3,
    message: {
      message_id: 3,
      chat: { id: 777001, type: 'private' },
      from: { id: 777001, username: 'j3n5en', first_name: 'J' },
      date: Math.floor(Date.now() / 1000),
      text: '在吗，帮我看下进度',
    },
  });
  // 投到哪个秘书会话由 Main 决定：从审计里读回目标会话，再选中它读正文
  const inboundTarget = await waitFor(
    () => {
      const entries = readFileSync(auditFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.op === 'contact_inbound');
      const last = entries.at(-1);
      return last?.ok && last.secretaryConversationId ? last.secretaryConversationId : null;
    },
    'telegram inbound delivered',
    40_000,
    500
  );
  const inbound = await waitFor(
    async () => {
      const state = await page(`
        S().selectConversation(${JSON.stringify(inboundTarget)});
        const text = texts(${JSON.stringify(inboundTarget)}).find((entry) => entry.includes('来自 Telegram'));
        return JSON.stringify({ id: ${JSON.stringify(inboundTarget)}, text: text ?? null });
      `);
      return state.text ? state : null;
    },
    'telegram inbound in secretary session',
    40_000,
    500
  );
  assert(inbound.text.includes('来自 Telegram'), '联系方式: 标注来自 Telegram', inbound.text);
  assert(
    inbound.text.includes('<untrusted-content'),
    '联系方式: 外部文本包成不可信内容',
    inbound.text
  );
  assert(
    (inbound.text.match(/<untrusted-content/gu) ?? []).length === 1,
    '联系方式: 入站只包一层',
    inbound.text
  );
  assert(
    (inbound.text.match(/来自 Telegram/gu) ?? []).length === 1,
    '联系方式: 来源标注只出现一次',
    inbound.text
  );

  // 界面上是卡片：发送者 + 时间 + 正文，包裹层不外露
  // 刚切过去的会话要等一帧才渲染完，这里等节点出现，别抢在渲染前查
  const card = await page(`
    // 上面的等待只在自己那次 page 调用里切过会话，这里再切一次，避免中间被别的回合换走
    S().selectConversation(${JSON.stringify(inboundTarget)});
    const node = await until(() => document.querySelector('[data-telegram-inbound]'), 15000);
    return JSON.stringify({
      found: Boolean(node),
      text: node?.textContent ?? '',
      markdown: Boolean(node?.querySelector('[data-markdown], .markdown, p')),
    });
  `);
  assert(card.found, '联系方式: 入站消息渲染成卡片', card);
  assert(card.text.includes('@j3n5en'), '联系方式: 卡片显示发送者', card.text);
  assert(/\d{2}:\d{2}/u.test(card.text), '联系方式: 卡片显示时间', card.text);
  assert(card.text.includes('在吗，帮我看下进度'), '联系方式: 卡片显示正文', card.text);
  assert(!card.text.includes('untrusted-content'), '联系方式: 卡片里不露包裹标签', card.text);
  assert(
    (card.text.match(/来自 Telegram/gu) ?? []).length === 1,
    '联系方式: 卡片只有一层来源标注',
    card.text
  );
  const reply = await waitFor(
    () =>
      tg.sent
        .slice(sentBefore)
        .find(
          (message) =>
            message.chat_id === 777001 &&
            !message.text?.includes('用哪个分支') &&
            !message.text?.startsWith('✅')
        ) ?? null,
    'secretary reply to phone',
    40_000,
    500
  );
  assert(reply.text === 'fake-ok', '联系方式: 秘书的回复发回手机', reply.text);
  assert(reply.parse_mode === 'HTML', '联系方式: 出站带 parse_mode=HTML', reply);
  const typing = tg.chatActions.slice(actionsBefore).filter((action) => action.chat_id === 777001);
  assert(
    typing.length > 0 && typing.every((action) => action.action === 'typing'),
    '联系方式: 处理手机消息时发 sendChatAction typing',
    tg.chatActions.slice(actionsBefore)
  );

  log('== 联系方式：出站 markdown 转 Telegram HTML');
  const sentMark = tg.sent.length;
  push({
    update_id: 5,
    message: {
      message_id: 5,
      chat: { id: 777001, type: 'private' },
      from: { id: 777001, username: 'j3n5en', first_name: 'J' },
      date: Math.floor(Date.now() / 1000),
      text: '再来一次 [[reply:**在的**\n\n- 进度 80%\n- 改了 `a.ts`\n\n```ts\nconst a = 1;\n```]]',
    },
  });
  const htmlReply = await waitFor(
    () =>
      tg.sent
        .slice(sentMark)
        .find((message) => message.chat_id === 777001 && message.text?.includes('在的')) ?? null,
    'markdown reply to phone',
    40_000,
    500
  );
  assert(htmlReply.parse_mode === 'HTML', '联系方式: markdown 回复走 HTML', htmlReply);
  assert(htmlReply.text.includes('<b>在的</b>'), '联系方式: 粗体转成 b 标签', htmlReply.text);
  assert(htmlReply.text.includes('• 进度 80%'), '联系方式: 列表转成圆点', htmlReply.text);
  assert(
    htmlReply.text.includes('<code>a.ts</code>'),
    '联系方式: 行内代码转成 code',
    htmlReply.text
  );
  assert(
    htmlReply.text.includes('<pre>const a = 1;</pre>'),
    '联系方式: 代码块转成 pre',
    htmlReply.text
  );
  assert(!htmlReply.text.includes('**'), '联系方式: 不再露出 markdown 源码', htmlReply.text);

  log('== 联系方式：只读命令与面板一致');
  // 造一个「需要你处理」的派出会话：面板与 /status 都该看到它
  const cmdDispatch = await dispatchDirect('session_create', {
    projectId: setup.projectId,
    prompt: '选方案 [[tool:ask_user {"question":"用哪个方案？","options":["A","B"]}]]',
    title: '命令验证',
  });
  assert(cmdDispatch.ok, '联系方式: 造一个等待中的派出会话', cmdDispatch);
  const cmdId = cmdDispatch.conversationId;
  const panelBoard = await waitFor(
    async () => {
      const state = await page(`
        const state = await window.electronAPI.secretary.getState();
        return JSON.stringify({
          needsYou: (state.board?.needsYou ?? []).map((card) => card.conversationId),
          running: (state.board?.running ?? []).map((card) => card.conversationId),
        });
      `);
      return state.needsYou.includes(cmdId) ? state : null;
    },
    'panel needsYou has the dispatch',
    60_000,
    500
  );
  assert(panelBoard.needsYou.includes(cmdId), '联系方式: 面板的「需要你」里有这个会话', panelBoard);

  const say = (text, updateId) =>
    push({
      update_id: updateId,
      message: {
        message_id: updateId,
        chat: { id: 777001, type: 'private' },
        from: { id: 777001, username: 'j3n5en', first_name: 'J' },
        text,
      },
    });
  const replySince = (from, match, label, timeout = 20_000) =>
    waitFor(() => tg.sent.slice(from).find(match) ?? null, label, timeout, 300);

  let mark = tg.sent.length;
  say('/status', 20);
  const statusReply = await replySince(
    mark,
    (message) => (message.text?.includes('需要你处理') ? message : null),
    'status reply'
  );
  assert(
    statusReply.text.includes('命令验证'),
    '联系方式: /status 列出面板里的会话标题',
    statusReply.text
  );
  assert(
    statusReply.text.includes('等你回答'),
    '联系方式: /status 带状态徽标文字',
    statusReply.text
  );
  assert(
    statusReply.text.includes(`enso://secretary?conversation=${cmdId}`),
    '联系方式: /status 每行带回应用的深链',
    statusReply.text
  );
  assert(statusReply.parse_mode === 'HTML', '联系方式: /status 用 HTML 格式发送', statusReply);

  mark = tg.sent.length;
  say('/board', 21);
  const boardReply = await replySince(
    mark,
    (message) => (message.text?.includes('派出') ? message : null),
    'board reply'
  );
  assert(boardReply.text.includes('完成'), '联系方式: /board 开头一行统计', boardReply.text);
  assert(boardReply.text.includes('命令验证'), '联系方式: /board 列出当天的卡片', boardReply.text);

  mark = tg.sent.length;
  say('/board 2020-01-01', 22);
  const oldBoard = await replySince(
    mark,
    (message) => (message.text?.includes('2020-01-01') ? message : null),
    'board with date'
  );
  assert(oldBoard.text.includes('这一天没有记录'), '联系方式: /board 带日期查历史', oldBoard.text);

  mark = tg.sent.length;
  say('/feed', 23);
  const feedReply = await replySince(
    mark,
    (message) => (message.text?.includes('最近动态') ? message : null),
    'feed reply'
  );
  const olderButton = feedReply.reply_markup?.inline_keyboard?.[0]?.[0];
  assert(
    olderButton?.text === '更早',
    '联系方式: /feed 底部有「更早」按钮',
    feedReply.reply_markup
  );
  push({
    update_id: 24,
    callback_query: {
      id: 'cb-feed-verify',
      data: olderButton.callback_data,
      message: { message_id: feedReply.message_id, chat: { id: 777001, type: 'private' } },
    },
  });
  // 同一时刻可能还有别的消息被原地改（卡片处理掉的收尾），只认这一条的编辑
  const olderPage = await waitFor(
    () => tg.edited.find((edit) => edit.message_id === feedReply.message_id) ?? null,
    'feed paged',
    20_000,
    300
  );
  assert(
    olderPage.message_id === feedReply.message_id && olderPage.text.includes('最近动态'),
    '联系方式: 点「更早」原地翻到更早一页',
    olderPage
  );
  assert(
    tg.callbacks.some((callback) => callback.callback_query_id === 'cb-feed-verify'),
    '联系方式: 翻页回调被应答',
    tg.callbacks.slice(-2)
  );

  mark = tg.sent.length;
  say('/memory', 25);
  const memoryClosed = await replySince(
    mark,
    (message) => (message.text?.includes('记忆') ? message : null),
    'memory closed'
  );
  assert(
    memoryClosed.text.includes('默认不在 Telegram 显示'),
    '联系方式: /memory 默认关闭只提示开关',
    memoryClosed.text
  );
  const chatMenu = () =>
    [...tg.commands].reverse().find((call) => call.scope?.type === 'chat')?.commands ?? [];
  const memoryMenu = chatMenu().map((entry) => entry.command);
  assert(!memoryMenu.includes('memory'), '联系方式: 关着时菜单里没有 /memory', memoryMenu);

  const memorySwitch = await page(`
    return JSON.stringify(
      await window.electronAPI.secretary.contactSettings({ allowMemory: true })
    );
  `);
  assert(memorySwitch.ok, '联系方式: 打开记忆开关', memorySwitch);
  mark = tg.sent.length;
  say('/memory', 26);
  const memoryOpen = await replySince(
    mark,
    (message) => (message.text?.includes('秘书记得') ? message : null),
    'memory open'
  );
  assert(
    !memoryOpen.text.includes('默认不在 Telegram 显示'),
    '联系方式: 打开后 /memory 给出标题列表',
    memoryOpen.text
  );
  assert(
    chatMenu()
      .map((entry) => entry.command)
      .includes('memory'),
    '联系方式: 打开后菜单里出现 /memory',
    chatMenu()
  );

  mark = tg.sent.length;
  push({
    update_id: 27,
    message: {
      message_id: 27,
      chat: { id: 999001, type: 'private' },
      from: { id: 999001, username: 'stranger' },
      text: '/status',
    },
  });
  await sleep(1500);
  assert(
    !tg.sent.slice(mark).some((message) => message.text?.includes('需要你处理')),
    '联系方式: 别的 chat 发命令一律不执行',
    tg.sent.slice(mark)
  );

  const commandAudit = readFileSync(auditFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.op === 'contact_command');
  assert(
    commandAudit.length >= 5 && commandAudit.every((entry) => entry.detail),
    '联系方式: 命令执行记审计',
    commandAudit
  );
  assert(
    commandAudit.every((entry) =>
      ['status', 'board', 'feed', 'memory', 'unknown'].includes(entry.detail)
    ),
    '联系方式: 审计只记命令名，不记返回内容',
    commandAudit.map((entry) => entry.detail)
  );

  log('== 联系方式：/last 回看最近一轮');
  const profileName = await page(`
    const state = await window.electronAPI.secretary.getState();
    return JSON.stringify({ name: state?.profile?.name ?? '' });
  `);
  mark = tg.sent.length;
  say('/last', 40);
  const lastReply = await replySince(
    mark,
    (message) => (message.text?.includes('你：') ? message : null),
    'last reply',
    40_000
  );
  assert(lastReply.text.includes('你：'), '联系方式: /last 用「你：」开头', lastReply.text);
  assert(
    lastReply.text.includes(`${profileName.name}：`),
    '联系方式: /last 用秘书昵称开头',
    lastReply.text
  );
  assert(lastReply.parse_mode === 'HTML', '联系方式: /last 走现有出站路径（HTML）', lastReply);

  mark = tg.sent.length;
  say('/last 99', 41);
  const lastUsage = await replySince(
    mark,
    (message) => (message.text?.includes('/last 3') ? message : null),
    'last usage'
  );
  assert(lastUsage.text.includes('最多 10 轮'), '联系方式: /last 超过十轮只回用法', lastUsage.text);

  log('== 联系方式：/sync 打开后镜像秘书会话的每一轮回复');
  mark = tg.sent.length;
  say('/sync', 42);
  const syncStatus = await replySince(
    mark,
    (message) => (message.text?.includes('同步已关闭') ? message : null),
    'sync status'
  );
  assert(syncStatus.text.includes('同步已关闭'), '联系方式: /sync 不带参数报当前状态', syncStatus);

  mark = tg.sent.length;
  say('/sync on', 43);
  const syncOn = await replySince(
    mark,
    (message) => (message.text?.includes('已打开同步') ? message : null),
    'sync on'
  );
  assert(syncOn.text.includes('已打开同步'), '联系方式: /sync on 打开同步', syncOn);
  const syncPanel = await page(`
    const panelOf = () => ${PANEL};
    if (!panelOf()) {
      S().selectConversation(${JSON.stringify(setup.secretaryId)});
      await sleep(300);
      const toggles = [...document.querySelectorAll('button')].filter(
        (b) => b.getAttribute('aria-label') === '新建标签页' && b.offsetParent !== null
      );
      toggles.at(-1)?.click();
      const item = await until(() => document.querySelector('[data-enso=secretary-panel-open]'), 5000);
      item?.click();
      await sleep(800);
      [...document.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-label') === '折叠/展开右侧面板')
        ?.click();
      await sleep(1200);
    }
    const panel = panelOf();
    panel?.querySelector('[data-enso=secretary-panel-tab][data-tab=contact]')?.click();
    await sleep(400);
    const state = await window.electronAPI.secretary.contactState();
    const node = panel?.querySelector('[data-enso=secretary-contact-sync]');
    return JSON.stringify({ on: state?.telegram?.syncMirror ?? null, panel: node?.innerText ?? null });
  `);
  assert(syncPanel.on === true, '联系方式: 状态里同步已打开', syncPanel);
  assert(
    syncPanel.panel?.includes('正在把所有对话同步到 Telegram'),
    '联系方式: 联系方式页显示醒目提示',
    syncPanel.panel
  );
  assert(
    syncPanel.panel?.includes('不是端到端加密'),
    '联系方式: 提示里说明 Telegram 不端到端加密',
    syncPanel.panel
  );

  // 用一个新的秘书会话跑同步：worker 是新的，不受前面步骤留下的状态影响
  const syncTarget = await page(`
    const secretary = await SEC();
    const id = await secretary.getState().newSecretaryConversation();
    S().selectConversation(id);
    await sleep(300);
    return JSON.stringify({ id });
  `);
  const secretaryTurn = (text) =>
    page(`
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    await S().send(
      ${JSON.stringify(text)},
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      ${JSON.stringify(syncTarget.id)}
    );
    return JSON.stringify({ ok: true });
  `);
  const assistantCount = async () => {
    const state = await page(`
      const row = S().conversations[${JSON.stringify(syncTarget.id)}];
      return JSON.stringify({ n: (row?.messages ?? []).filter((m) => m.role === 'assistant').length });
    `);
    return state.n;
  };
  const lastAssistantText = async () => {
    const state = await page(`
      const row = S().conversations[${JSON.stringify(syncTarget.id)}];
      const last = (row?.messages ?? []).filter((m) => m.role === 'assistant').at(-1);
      const content = last?.content;
      const text = Array.isArray(content)
        ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
        : typeof content === 'string'
          ? content
          : '';
      return JSON.stringify({ text });
    `);
    return state.text;
  };
  /** 应用里这一轮真的收口了：assistant 条数涨了再往下走，不然断言会空转 */
  const waitTurnSettled = async (before, label) => {
    await waitFor(
      async () => ((await assistantCount()) > before ? true : null),
      label,
      60_000,
      500
    );
    await sleep(800);
  };

  let turnBefore = await assistantCount();
  mark = tg.sent.length;
  const syncActionsBefore = tg.chatActions.length;
  await secretaryTurn('[[reply:同步验证]]');
  await waitTurnSettled(turnBefore, 'secretary turn settled');
  const appReply = await lastAssistantText();
  const expected = appReply.includes('同步验证') ? '同步验证' : 'fake-ok';
  const mirrored = await waitFor(
    () => tg.sent.slice(mark).find((message) => message.text?.includes(expected)) ?? null,
    'mirrored reply',
    30_000,
    300
  ).catch(() => null);
  assert(mirrored, '联系方式: 普通一轮的回复也发到手机', {
    expected,
    sent: tg.sent.slice(mark),
  });
  const syncTyping = tg.chatActions
    .slice(syncActionsBefore)
    .filter((action) => action.chat_id === 777001);
  assert(
    syncTyping.length > 0 && syncTyping.every((action) => action.action === 'typing'),
    '联系方式: /sync 打开时应用内回合也发 sendChatAction typing',
    tg.chatActions.slice(syncActionsBefore)
  );

  turnBefore = await assistantCount();
  mark = tg.sent.length;
  // 纯系统回传 + silence_turn：两条静默判据都写上，假 provider 走哪条都算静默
  await secretaryTurn(
    '<session-updates>\n- [goal-complete session:abc] 完成 [[tool:silence_turn]] [[reply:<secretary-silent/>]]\n</session-updates>'
  );
  await waitTurnSettled(turnBefore, 'silent turn settled');
  const silentLine = await waitFor(
    () => tg.sent.slice(mark).find((message) => message.text?.includes('静默处理')) ?? null,
    'silent summary',
    30_000,
    300
  ).catch(() => null);
  assert(silentLine, '联系方式: 静默回合只发一行摘要', tg.sent.slice(mark));

  mark = tg.sent.length;
  say('/sync off', 44);
  const syncOff = await replySince(
    mark,
    (message) => (message.text?.includes('同步已关闭') ? message : null),
    'sync off'
  );
  assert(syncOff.text.includes('同步已关闭'), '联系方式: /sync off 关掉同步', syncOff);
  mark = tg.sent.length;
  turnBefore = await assistantCount();
  await secretaryTurn('[[reply:关掉后不该发]]');
  await waitTurnSettled(turnBefore, 'turn settled after sync off');
  const offReply = await lastAssistantText();
  await sleep(1500);
  assert(
    !tg.sent
      .slice(mark)
      .some(
        (message) =>
          message.text?.includes('关掉后不该发') || message.text?.includes(offReply || 'fake-ok')
      ),
    '联系方式: 关掉后不再镜像普通回合',
    tg.sent.slice(mark)
  );

  const syncAudit = readFileSync(auditFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.op === 'contact_sync');
  assert(
    syncAudit.map((entry) => entry.detail).join(',') === 'on,off',
    '联系方式: 开关动作记审计',
    syncAudit
  );

  log('== 联系方式：确认卡带按钮，开关决定能不能在手机上确认');
  // 派发不再出卡：用技能卡验证手机确认，名字就是卡片标题里能认出的那一段
  const makeCard = (name) =>
    page(`
    const secretary = await SEC();
    const fresh = await secretary.getState().newSecretaryConversation();
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.secretaryProjectId)});
    await S().send(
      ${JSON.stringify(`沉淀成 skill [[tool:skill_propose ${JSON.stringify({ name, description: '手机确认验收', body: '# 步骤' })}]]`)},
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      fresh
    );
    const proposal = await until(() => Object.values(secretary.getState().secretary.proposals)
      .filter((p) => p.status === 'pending' && p.kind === 'skill' && p.secretaryConversationId === fresh)
      .at(-1) ?? null, 30000);
    return JSON.stringify({ ok: Boolean(proposal), proposalId: proposal?.id ?? null });
  `);
  const proposalStatus = (id) =>
    page(`
    const state = await window.electronAPI.secretary.getState();
    return JSON.stringify({ status: state.proposals[${JSON.stringify(id)}]?.status ?? null });
  `);

  // 先关掉开关：按钮照样在，但点了只提醒回应用处理
  const cardSwitchOff = await page(`
    return JSON.stringify(await window.electronAPI.secretary.contactSettings({ allowCardConfirm: false }));
  `);
  assert(cardSwitchOff.ok, '联系方式: 关掉确认卡开关', cardSwitchOff);
  const cardOff = await makeCard('tg-card-one');
  assert(cardOff.ok, '联系方式: 造一张待确认的技能卡', cardOff);
  const noticeOff = await waitFor(
    () => tg.sent.find((message) => message.text?.includes('tg-card-one')) ?? null,
    'card notice with switch off',
    30_000,
    300
  );
  const offButtons = noticeOff.reply_markup?.inline_keyboard?.flat() ?? [];
  assert(
    offButtons.length === 2 &&
      offButtons[0].text.startsWith('确认技能') &&
      offButtons[0].text.includes('tg-card-one') &&
      offButtons[1].text === '在应用里打开',
    '联系方式: 开关关着时按钮照样在（确认 + 在应用里打开）',
    offButtons
  );
  assert(
    noticeOff.text.includes('关着手机确认'),
    '联系方式: 开关关着时说明点确认只会提醒回应用处理',
    noticeOff.text
  );
  assert(
    noticeOff.text.includes('<code>enso://secretary?conversation=') &&
      noticeOff.text.includes(`proposal=${cardOff.proposalId}</code>`),
    '联系方式: 深链在正文里用等宽字体给出（Telegram 不认 enso:// 的 url 按钮）',
    noticeOff.text
  );
  assert(!offButtons.some((button) => button.url), '联系方式: enso:// 不做成 url 按钮', offButtons);
  assert(
    !noticeOff.text.includes('点下面的按钮'),
    '联系方式: 不再说「点下面的按钮」又甩一段裸链接',
    noticeOff.text
  );
  push({
    update_id: 28,
    callback_query: {
      id: 'cb-card-off-confirm',
      data: offButtons[0].callback_data,
      message: { message_id: noticeOff.message_id, chat: { id: 777001, type: 'private' } },
    },
  });
  const refused = await waitFor(
    () => tg.sent.find((message) => message.text?.includes('已在设置里关闭手机确认')) ?? null,
    'card confirm refused',
    20_000,
    300
  );
  assert(
    tg.callbacks.some((callback) => callback.text?.includes('已在设置里关闭手机确认')),
    '联系方式: 开关关着点确认只回说明',
    tg.callbacks.slice(-2)
  );
  assert(
    (refused.reply_markup?.inline_keyboard?.flat() ?? []).map((button) => button.text).join(',') ===
      '在应用里打开',
    '联系方式: 说明里附「在应用里打开」',
    refused.reply_markup
  );
  const stillPending = await proposalStatus(cardOff.proposalId);
  assert(stillPending.status === 'pending', '联系方式: 开关关着时点确认不会执行', stillPending);
  assert(
    !tg.edited.some((edit) => edit.message_id === noticeOff.message_id),
    '联系方式: 开关关着时原消息不动',
    tg.edited.filter((edit) => edit.message_id === noticeOff.message_id)
  );

  // 打开开关：手机上直接确认
  const cardSwitch = await page(`
    return JSON.stringify(await window.electronAPI.secretary.contactSettings({ allowCardConfirm: true }));
  `);
  assert(cardSwitch.ok, '联系方式: 打开确认卡开关', cardSwitch);
  const cardOn = await makeCard('tg-card-two');
  assert(cardOn.ok, '联系方式: 开关打开后再造一张技能卡', cardOn);
  const noticeOn = await waitFor(
    () => tg.sent.find((message) => message.text?.includes('tg-card-two')) ?? null,
    'card notice with switch on',
    30_000,
    300
  );
  const onRows = noticeOn.reply_markup?.inline_keyboard ?? [];
  const onButtons = onRows.flat().map((button) => button.text);
  assert(
    onButtons.length === 2 &&
      onButtons[0].startsWith('确认技能') &&
      onButtons[0].includes('tg-card-two') &&
      onButtons[1] === '在应用里打开',
    '联系方式: 开关打开后是「确认技能：标题」+「在应用里打开」',
    onRows.map((row) => row.map((button) => button.text))
  );
  assert(
    onRows[0][0].callback_data.includes(cardOn.proposalId),
    '联系方式: 确认按钮的回调数据带上卡片 id',
    onRows[0][0]
  );
  assert(
    noticeOn.text.includes('点「确认」直接处理') &&
      noticeOn.text.includes('审批永远只能在应用里处理'),
    '联系方式: 开关打开后说明可以直接确认，审批仍在应用里',
    noticeOn.text
  );
  // 假 Telegram 收到的 payload 按 Telegram 的样子画出来截一张：手机上就是这两个按钮
  await shotTelegramCard(cdp, noticeOn, path.join(ART, '10-telegram-card.png'));

  push({
    update_id: 29,
    callback_query: {
      id: 'cb-card-confirm',
      data: onRows[0][0].callback_data,
      message: { message_id: noticeOn.message_id, chat: { id: 777001, type: 'private' } },
    },
  });
  const confirmed = await waitFor(
    async () => {
      const state = await page(`
        const state = await window.electronAPI.secretary.getState();
        const proposal = state.proposals[${JSON.stringify(cardOn.proposalId)}];
        return JSON.stringify({
          status: proposal?.status ?? null,
          conversationId: proposal?.conversationId ?? null,
        });
      `);
      return state.status && state.status !== 'pending' && state.status !== 'executing'
        ? state
        : null;
    },
    'card confirmed from telegram',
    60_000,
    500
  );
  assert(
    confirmed.status === 'succeeded',
    '联系方式: 手机点按钮真的把卡确认了（技能写盘）',
    confirmed
  );
  assert(
    tg.callbacks.some((callback) => callback.text?.includes('已确认：技能')),
    '联系方式: 手机收到「已确认：技能 …」',
    tg.callbacks.slice(-2)
  );
  const settledOn = await waitFor(
    () => tg.edited.find((edit) => edit.message_id === noticeOn.message_id) ?? null,
    'card message settled',
    20_000,
    300
  );
  assert(
    settledOn.text?.startsWith('✅ 已确认：技能') && settledOn.text.includes('tg-card-two'),
    '联系方式: 原消息整条换成「✅ 已确认：…」',
    settledOn.text
  );
  assert(
    settledOn.reply_markup?.inline_keyboard?.length === 0,
    '联系方式: 确认后按钮清掉',
    settledOn.reply_markup
  );
  assert(
    !settledOn.text.includes('· 已处理'),
    '联系方式: 不再留下「· 已处理」残渣',
    settledOn.text
  );
  assert(
    tg.sent.some((message) => message.text === settledOn.text),
    '联系方式: 确认后另回一条结果',
    tg.sent.slice(-3)
  );

  // 在应用里处理掉第一张：手机那条消息也整条换成已处理
  await page(`
    return JSON.stringify(
      await window.electronAPI.secretary.resolveProposal(${JSON.stringify(cardOff.proposalId)}, 'reject')
    );
  `);
  const settledOff = await waitFor(
    () => tg.edited.find((edit) => edit.message_id === noticeOff.message_id) ?? null,
    'first card settled from the app',
    20_000,
    300
  );
  assert(
    settledOff.text?.startsWith('✅ 已处理：技能') && settledOff.text.includes('tg-card-one'),
    '联系方式: 在应用里处理掉之后正文换成「✅ 已处理：…」',
    settledOff.text
  );
  assert(
    settledOff.reply_markup?.inline_keyboard?.length === 0,
    '联系方式: 在应用里处理掉之后按钮也失效',
    settledOff.reply_markup
  );
  const cardAudit = readFileSync(auditFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.op === 'contact_card_confirm');
  assert(
    cardAudit.some((entry) => entry.ok && entry.detail?.startsWith('技能')),
    '联系方式: 从手机确认记审计（哪张卡、什么类型）',
    cardAudit
  );
  assert(
    cardAudit.some((entry) => !entry.ok && entry.detail === 'disabled'),
    '联系方式: 开关关着时的点击也记审计',
    cardAudit
  );

  log('== 联系方式：解绑后停止轮询');
  const unbound = await page(`
    const result = await window.electronAPI.secretary.contactUnbind();
    const state = await window.electronAPI.secretary.contactState();
    return JSON.stringify({ result, status: state.telegram.status, chat: state.telegram.chat ?? null });
  `);
  assert(unbound.result.ok, '联系方式: 解绑成功', unbound);
  assert(
    tg.deleted.some((call) => call.scope?.type === 'chat' && call.scope.chat_id === 777001) &&
      tg.deleted.some((call) => call.language_code === 'zh') &&
      tg.deleted.some((call) => !call.scope && !call.language_code),
    '联系方式: 解绑时删掉 chat 与默认 scope 的菜单',
    tg.deleted
  );
  assert(
    tg.menuButtons.at(-1)?.type === 'default',
    '联系方式: 解绑后菜单按钮回默认',
    tg.menuButtons
  );
  assert(
    unbound.status === 'unbound' && unbound.chat === null,
    '联系方式: 解绑后清掉 chat',
    unbound
  );
  const pollsAfterUnbind = tg.polls;
  push({
    update_id: 4,
    message: {
      message_id: 4,
      chat: { id: 777001, type: 'private' },
      from: { id: 777001, username: 'j3n5en' },
      text: '解绑后还能说话吗',
    },
  });
  await sleep(2500);
  assert(tg.polls === pollsAfterUnbind, '联系方式: 解绑后不再轮询', {
    before: pollsAfterUnbind,
    after: tg.polls,
  });
  const contactAudit = readFileSync(auditFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.op?.startsWith('contact_'));
  assert(contactAudit.length > 0, '联系方式: 出入站都记了审计', contactAudit.length);
  assert(
    contactAudit.every((entry) => !JSON.stringify(entry).includes(tg.token)),
    '联系方式: 审计里没有 token',
    contactAudit.slice(-3)
  );
  assert(
    contactAudit.every(
      (entry) =>
        !JSON.stringify(entry).includes('在吗，帮我看下进度') &&
        !JSON.stringify(entry).includes('用哪个分支')
    ),
    '联系方式: 审计里不记正文',
    contactAudit.slice(-3)
  );

  log('== 面板：技能标签列出秘书可用的 skill');
  // 直接往隔离 userData 的秘书目录写一份自有 skill：与设置页读的是同一份磁盘数据
  const skillsDir = path.join(ENV, 'secretary', 'workspace', 'skills');
  mkdirSync(path.join(skillsDir, 'verify-skill'), { recursive: true });
  writeFileSync(
    path.join(skillsDir, 'verify-skill', 'SKILL.md'),
    '---\nname: verify-skill\ndescription: 验收用的技能\n---\n\n# 步骤\n\n- 跑一遍验收\n'
  );
  const skillsTab = await page(`
    const panelOf = () => ${PANEL};
    if (!panelOf()) {
      S().selectConversation(${JSON.stringify(setup.secretaryId)});
      await sleep(300);
      const toggles = [...document.querySelectorAll('button')].filter(
        (b) => b.getAttribute('aria-label') === '新建标签页' && b.offsetParent !== null
      );
      toggles.at(-1)?.click();
      const item = await until(() => document.querySelector('[data-enso=secretary-panel-open]'), 5000);
      item?.click();
      await sleep(800);
      [...document.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-label') === '折叠/展开右侧面板')
        ?.click();
      await sleep(1200);
    }
    const panel = panelOf();
    if (!panel) return JSON.stringify({ ok: false, error: 'no panel' });
    panel.querySelector('[data-enso=secretary-panel-tab][data-tab=skills]')?.click();
    await sleep(800);
    const rows = [...panel.querySelectorAll('[data-enso=secretary-skill-row]')];
    return JSON.stringify({
      ok: rows.length > 0,
      tabs: [...panel.querySelectorAll('[data-enso=secretary-panel-tab]')].map((node) => node.dataset.tab),
      groups: [...panel.querySelectorAll('[data-enso=secretary-skill-group]')].map((node) => node.dataset.group),
      rows: rows.map((row) => ({
        source: row.dataset.source,
        enabled: row.dataset.enabled,
        text: row.innerText,
      })),
    });
  `);
  assert(skillsTab.ok, '面板: 技能标签能列出 skill', skillsTab);
  assert(
    skillsTab.tabs?.indexOf('skills') === skillsTab.tabs?.indexOf('contact') + 1,
    '面板: 技能标签排在联系方式后面',
    skillsTab.tabs
  );
  assert(
    skillsTab.groups?.join(',') === 'own,global',
    '面板: 技能分「秘书专属」与「全局共享」两组',
    skillsTab.groups
  );
  const ownRow = skillsTab.rows.find((row) => row.text.includes('verify-skill'));
  assert(
    ownRow?.source === 'own' && ownRow.text.includes('验收用的技能') && ownRow.enabled === 'true',
    '面板: 专属 skill 显示名称、说明、来源与启用状态',
    ownRow
  );
  const skillBody = await page(`
    const panel = ${PANEL};
    const row = [...panel.querySelectorAll('[data-enso=secretary-skill-row]')]
      .find((node) => node.innerText.includes('verify-skill'));
    row?.querySelector('[data-enso=secretary-skill-expand]')?.click();
    await sleep(600);
    const body = row?.querySelector('[data-enso=secretary-skill-body]');
    return JSON.stringify({
      text: body?.innerText ?? null,
      untrusted: body?.innerText?.includes('只给你看') ?? false,
      markdown: Boolean(body?.querySelector('h1, pre, code, p')),
    });
  `);
  await cdp.shot(path.join(ART, '13-panel-skills.png'));
  assert(
    skillBody.text?.includes('跑一遍验收'),
    '面板: 点开能看完整 SKILL.md 正文',
    skillBody.text
  );
  assert(skillBody.untrusted, '面板: 正文标成只给用户看，不当指令', skillBody);
  assert(skillBody.markdown, '面板: 正文按 markdown 渲染', skillBody);
  const skillToggle = await page(`
    const panel = ${PANEL};
    const row = [...panel.querySelectorAll('[data-enso=secretary-skill-row]')]
      .find((node) => node.innerText.includes('verify-skill'));
    row?.querySelector('[data-enso=secretary-skill-toggle]')?.click();
    await sleep(900);
    const after = [...panel.querySelectorAll('[data-enso=secretary-skill-row]')]
      .find((node) => node.innerText.includes('verify-skill'));
    const profile = await window.electronAPI.secretary.getProfile();
    return JSON.stringify({
      enabled: after?.dataset.enabled ?? null,
      disabled: profile.profile?.disabledSkillNames ?? [],
    });
  `);
  assert(
    skillToggle.enabled === 'false' && skillToggle.disabled?.includes('verify-skill'),
    '面板: 停用写进档案，列表跟着变',
    skillToggle
  );
  const skillDelete = await page(`
    const panel = ${PANEL};
    const row = [...panel.querySelectorAll('[data-enso=secretary-skill-row]')]
      .find((node) => node.innerText.includes('verify-skill'));
    row?.querySelector('[data-enso=secretary-skill-delete]')?.click();
    await sleep(300);
    const confirm = row?.querySelector('[data-enso=secretary-skill-confirm]');
    if (!confirm) return JSON.stringify({ ok: false, error: 'no confirm' });
    confirm.querySelector('[data-enso=secretary-skill-confirm-delete]')?.click();
    await sleep(900);
    const listed = await window.electronAPI.secretary.listSkills();
    return JSON.stringify({
      ok: !(listed.skills ?? []).some((skill) => skill.name === 'verify-skill'),
    });
  `);
  assert(skillDelete.ok, '面板: 删除要二次确认，确认后从列表消失', skillDelete);
  assert(
    !existsSync(path.join(skillsDir, 'verify-skill')),
    '面板: 删除后秘书目录里的 skill 也没了',
    path.join(skillsDir, 'verify-skill')
  );
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * 动态超过两页：首屏只有一页；滚到底加载下一页且顺序正确；
 * 停在中间时新条目不插入、滚动位置不变。
 */
async function verifyFeedPaging(cdp, panelHost) {
  const page = cdp.json.bind(cdp);
  const PAGE = 40;
  const base = Date.now() + 1_000_000;
  const tieAt = base + 10_000;
  const activityId = (conversationId, at) => `activity:${conversationId}:${at}:seen`;
  const entries = [];
  // 贴底时哨兵会连续多拉几页，种子必须远超两页，否则列表见底后「没有更多」标记
  // 会提前出现，断言 end === false 就随历史活动多少时好时坏
  const SEED = 297;
  const last = SEED - 1;
  for (let index = 0; index < SEED; index += 1) {
    entries.push({
      at: base + index,
      conversationId: `feed-${String(index).padStart(3, '0')}`,
      kind: 'seen',
      text: `feed-${String(index).padStart(3, '0')}`,
    });
  }
  for (const name of ['m', 'a', 'z']) {
    entries.push({ at: tieAt, conversationId: `tie-${name}`, kind: 'seen', text: `tie-${name}` });
  }
  const page1 = [
    activityId('tie-a', tieAt),
    activityId('tie-m', tieAt),
    activityId('tie-z', tieAt),
    ...Array.from({ length: 37 }, (_, index) => {
      const n = last - index;
      return activityId(`feed-${String(n).padStart(3, '0')}`, base + n);
    }),
  ];
  const page2 = Array.from({ length: PAGE }, (_, index) => {
    const n = last - 37 - index;
    return activityId(`feed-${String(n).padStart(3, '0')}`, base + n);
  });

  log('== 动态分页');
  const panelVisible = await page(`
    S().selectConversation(${JSON.stringify(panelHost)});
    const panel = await until(() => {
      const node = document.querySelector('[data-enso=secretary-panel]');
      return node && node.offsetParent != null && node.getBoundingClientRect().width > 0 ? true : null;
    }, 10000);
    return JSON.stringify({ ok: Boolean(panel) });
  `);
  assert(panelVisible.ok, '动态分页: 秘书面板在屏幕上', panelVisible);
  const parked = await page(`
    const panel = document.querySelector('[data-enso=secretary-panel]');
    if (!panel) return JSON.stringify({ ok: false, error: 'panel closed' });
    document.querySelector('[data-enso=secretary-panel-tab][data-tab=memory]')?.click();
    const scroller = document.querySelector('[data-enso=secretary-panel-scroll]');
    if (scroller) scroller.style.maxHeight = '420px';
    return JSON.stringify({ ok: Boolean(scroller) });
  `);
  assert(parked.ok, '动态分页: 先离开工作台，避免旧列表被整页顶上', parked);

  const file = readJson(dispatchFile);
  file.activity = [...(file.activity ?? []), ...entries].slice(-400);
  writeFileSync(dispatchFile, JSON.stringify(file));
  const published = await page(`
    return JSON.stringify(await window.electronAPI.secretary.mutateTodo({ action: 'add', text: '动态分页占位' }));
  `);
  assert(published.ok, '动态分页: 写盘后推送状态', published);

  const first = await page(`
    document.querySelector('[data-enso=secretary-panel-tab][data-tab=workbench]')?.click();
    const ids = () => [...document.querySelectorAll('[data-enso=secretary-feed-event]')].map((node) => node.dataset.id);
    const ready = await until(() => (ids().length === ${PAGE} ? ids() : null), 15000);
    await sleep(400);
    return JSON.stringify({ ids: ids(), stable: ids().length === ${PAGE}, ready: Boolean(ready) });
  `);
  assert(
    first.stable && JSON.stringify(first.ids) === JSON.stringify(page1),
    '动态分页: 首屏只有最新一页，相同时间按 id 排',
    { got: first.ids, want: page1 }
  );
  await cdp.shot(path.join(ART, 'feed-before.png'));

  const second = await page(`
    const scroller = document.querySelector('[data-enso=secretary-panel-scroll]');
    scroller.style.overflowAnchor = 'none';
    const ids = () => [...document.querySelectorAll('[data-enso=secretary-feed-event]')].map((node) => node.dataset.id);
    const nudge = () => {
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll'));
    };
    // 观察器在首屏提交后才挂上。贴底后哨兵还在视口里时会再拉一页，所以接受两页或更多，前缀必须不重不漏。
    await sleep(400);
    const before = ids().length;
    nudge();
    const enough = () => {
      const list = ids();
      return list.length >= before + ${PAGE} ? list : null;
    };
    let ready = await until(enough, 8000);
    if (!ready && ids().length === before) {
      await sleep(400);
      nudge();
      ready = await until(enough, 8000);
    }
    const sentinel = document.querySelector('[data-enso=secretary-feed-sentinel]');
    const root = scroller.getBoundingClientRect();
    const mark = sentinel?.getBoundingClientRect();
    return JSON.stringify({
      ids: ready,
      end: Boolean(document.querySelector('[data-enso=secretary-feed-end]')),
      length: ids().length,
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      sentinelTop: mark ? Math.round(mark.top - root.bottom) : null,
    });
  `);
  assert(
    Array.isArray(second.ids) &&
      second.ids.length >= page1.length + page2.length &&
      JSON.stringify(second.ids.slice(0, page1.length + page2.length)) ===
        JSON.stringify([...page1, ...page2]) &&
      new Set(second.ids).size === second.ids.length &&
      second.end === false,
    '动态分页: 滚到底加载出更早的一页，不重不漏',
    {
      got: second.ids,
      want: [...page1, ...page2],
      end: second.end,
      length: second.length,
      scrollTop: second.scrollTop,
      scrollHeight: second.scrollHeight,
      clientHeight: second.clientHeight,
      sentinelTop: second.sentinelTop,
    }
  );

  const parkedScroll = await page(`
    const scroller = document.querySelector('[data-enso=secretary-panel-scroll]');
    scroller.scrollTop = 200;
    const ids = [...document.querySelectorAll('[data-enso=secretary-feed-event]')].map(
      (node) => node.dataset.id
    );
    return JSON.stringify({ top: scroller.scrollTop, length: ids.length });
  `);
  const extraAt = tieAt + 1;
  const extraId = activityId('feed-new', extraAt);
  const again = readJson(dispatchFile);
  again.activity = [
    ...(again.activity ?? []),
    { at: extraAt, conversationId: 'feed-new', kind: 'seen', text: 'feed-new' },
  ];
  writeFileSync(dispatchFile, JSON.stringify(again));
  const nudged = await page(`
    return JSON.stringify(await window.electronAPI.secretary.mutateTodo({ action: 'add', text: '动态分页新条目' }));
  `);
  assert(nudged.ok, '动态分页: 新条目触发推送', nudged);
  const held = await page(`
    const banner = await until(() => document.querySelector('[data-enso=secretary-feed-fresh]'), 15000);
    const scroller = document.querySelector('[data-enso=secretary-panel-scroll]');
    const ids = [...document.querySelectorAll('[data-enso=secretary-feed-event]')].map((node) => node.dataset.id);
    return JSON.stringify({
      count: banner?.dataset.count ?? null,
      top: scroller.scrollTop,
      hasNew: ids.includes(${JSON.stringify(extraId)}),
      length: ids.length,
    });
  `);
  assert(
    held.count === '1' &&
      held.top === parkedScroll.top &&
      held.hasNew === false &&
      // 贴底时哨兵会多拉几页，页数不固定；只要求「新动态没插进来」，长度和离开底部时一致
      held.length === parkedScroll.length,
    '动态分页: 停在中间时新动态不插入，滚动位置不变',
    { held, parked: parkedScroll }
  );
  await cdp.shot(path.join(ART, 'feed-after.png'));
  const revealed = await page(`
    document.querySelector('[data-enso=secretary-feed-fresh]').click();
    const scroller = document.querySelector('[data-enso=secretary-panel-scroll]');
    const want = ${JSON.stringify(extraId)};
    const ready = await until(() => {
      const firstId = document.querySelector('[data-enso=secretary-feed-event]')?.dataset.id ?? null;
      const banner = Boolean(document.querySelector('[data-enso=secretary-feed-fresh]'));
      return firstId === want && !banner ? { top: scroller.scrollTop, firstId, banner } : null;
    }, 15000);
    return JSON.stringify(ready ?? {
      top: scroller.scrollTop,
      firstId: document.querySelector('[data-enso=secretary-feed-event]')?.dataset.id ?? null,
      banner: true,
    });
  `);
  assert(
    revealed.top === 0 && revealed.firstId === extraId && revealed.banner === false,
    '动态分页: 点提示回到顶部并看到新动态',
    revealed
  );
  await page(`
    const scroller = document.querySelector('[data-enso=secretary-panel-scroll]');
    if (scroller) scroller.style.maxHeight = '';
    return 'null';
  `);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** 120×80 的源图：中间一条竖条，裁成正方形后竖条仍在正中，能证明是居中裁切 */
function writeAvatarFixture(file, bar = [255, 0, 170]) {
  const width = 120;
  const height = 80;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 4;
      const inside = x >= 50 && x < 70;
      raw[at] = inside ? bar[0] : 20;
      raw[at + 1] = inside ? bar[1] : 20;
      raw[at + 2] = inside ? bar[2] : 20;
      raw[at + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  writeFileSync(
    file,
    Buffer.concat([
      PNG_SIGNATURE,
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', deflateSync(raw)),
      pngChunk('IEND', Buffer.alloc(0)),
    ])
  );
}

/**
 * 120×80、两帧循环的 GIF：中间竖条换色。LZW 每两个像素发一次 Clear，码宽恒为 3 位，
 * 不需要真正的字典压缩也是合法 GIF。
 */
function writeGifFixture(file) {
  const width = 120;
  const height = 80;
  const palette = [20, 20, 20, 255, 0, 170, 0, 170, 255, 255, 255, 255];
  const frame = (bar) => {
    let acc = 0;
    let bits = 0;
    const bytes = [];
    const put = (code) => {
      acc |= code << bits;
      bits += 3;
      while (bits >= 8) {
        bytes.push(acc & 0xff);
        acc >>= 8;
        bits -= 8;
      }
    };
    for (let i = 0; i < width * height; i += 1) {
      if (i % 2 === 0) put(4);
      const x = i % width;
      put(x >= 50 && x < 70 ? bar : 0);
    }
    put(5);
    if (bits > 0) bytes.push(acc & 0xff);
    const blocks = [];
    for (let at = 0; at < bytes.length; at += 255) {
      const chunk = bytes.slice(at, at + 255);
      blocks.push(chunk.length, ...chunk);
    }
    const size = [width & 0xff, width >> 8, height & 0xff, height >> 8];
    return [0x21, 0xf9, 4, 0, 20, 0, 0, 0, 0x2c, 0, 0, 0, 0, ...size, 0, 2, ...blocks, 0];
  };
  const loop = [0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0];
  writeFileSync(
    file,
    Buffer.from([
      ...Buffer.from('GIF89a'),
      width & 0xff,
      width >> 8,
      height & 0xff,
      height >> 8,
      0xf1,
      0,
      0,
      ...palette,
      ...loop,
      ...frame(1),
      ...frame(2),
      0x3b,
    ])
  );
}

/**
 * 头像：设置页填非预设色 → 选中自定义入口并落盘 → 上传图片、居中裁切 → 侧栏/聊天/顶栏标签都换成图片
 * → 受控接口拒绝穿越 → 移除后回到颜色加首字。全程只碰隔离 userData。
 */
async function verifyAvatar(cdp, setup) {
  const page = cdp.json.bind(cdp);
  const profileFile = path.join(ENV, 'secretary', 'profile.json');
  const avatarFile = path.join(ENV, 'secretary', 'avatar.png');
  const fixture = path.join(ART, 'avatar-source.png');
  writeAvatarFixture(fixture);

  log('== 头像：没上传图片时按名字生成');
  const generatedFace = () =>
    page(`
    const face = await until(
      () => document.querySelector('[data-enso=secretary-avatar-face][data-generated=true]') ?? null,
      15000
    );
    return JSON.stringify({
      // React useId 给 mask 的 id 每次挂载都不同，比较前抹掉
      svg: face?.querySelector('svg')?.outerHTML.replace(/_r_\\w+?_/g, '') ?? null,
      image: document.querySelector('[data-enso=secretary-avatar]')?.getAttribute('data-image'),
    });
  `);
  const defaultFace = await generatedFace();
  assert(
    typeof defaultFace.svg === 'string' && defaultFace.image === null,
    '头像: 没设头像时侧栏用 boring-avatars 生成',
    defaultFace
  );

  log('== 头像：自定义颜色');
  await page(`
    await window.electronAPI.window.openSettings({
      category: 'secretary',
      rowId: 'secretary.profile',
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

  const flat = await settingsPage.json(`
    await until(
      () => document.querySelector('[data-enso=secretary-form-avatar-hex]')?.value === '#6366f1',
      30000
    );
    const form = document.querySelector('[data-enso=secretary-profile-form]');
    form?.scrollIntoView({ block: 'start' });
    return JSON.stringify({
      steps: document.querySelectorAll('[data-enso=secretary-form-step]').length,
      fields: ['name', 'visible-mode', 'max-running', 'patrol'].filter((key) =>
        form?.querySelector('[data-enso=secretary-form-' + key + ']')
      ),
      removed: ['autonomy', 'worktree', 'dispatch-model', 'muted', 'unattended', 'patrol-interval', 'orphan'].filter((key) =>
        document.querySelector('[data-enso=secretary-form-' + key + ']')
      ),
    });
  `);
  assert(
    flat.steps === 0 && flat.fields.length === 3 && flat.removed.length === 0,
    '设置页: 档案表单一页平铺，只剩保留的设置项',
    flat
  );
  await settingsPage.shot(path.join(ART, '01a-secretary-settings.png'));

  const custom = await settingsPage.json(`
    // 档案还在加载时表单是空草案；加载完会按 updatedAt 重挂，把这时填的颜色丢掉。
    // 先等到输入框变成 setup 落盘的颜色，再改。
    await until(
      () => document.querySelector('[data-enso=secretary-form-avatar-hex]')?.value === '#6366f1',
      30000
    );
    const input = document.querySelector('[data-enso=secretary-form-avatar-hex]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '#ff00aa');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    const entry = () => document.querySelector('[data-enso=secretary-form-avatar-custom]');
    const selected = await until(() => entry()?.dataset.selected === 'true', 10000);
    const presets = [...document.querySelectorAll('[data-enso=secretary-form-avatar] > button')];
    return JSON.stringify({
      selected: Boolean(selected),
      background: entry()?.style.backgroundColor,
      presetPressed: presets.filter((b) => b.getAttribute('aria-pressed') === 'true').length,
    });
  `);
  assert(custom.selected, '头像: 非预设色选中自定义入口', custom);
  assert(custom.background === 'rgb(255, 0, 170)', '头像: 自定义入口显示当前颜色', custom);
  assert(custom.presetPressed === 0, '头像: 非预设色时没有预设色块被选中', custom);
  await settingsPage.shot(path.join(ART, '01b-avatar-custom-color.png'));

  const savedColor = await settingsPage.json(`
    // 表单一页平铺：没有分步，保存按钮就在同一页
    if (document.querySelector('[data-enso=secretary-form-step]')) return JSON.stringify({ ok: false, steps: true });
    const save = await until(
      () =>
        [...document.querySelectorAll('[data-enso=secretary-profile-form] button')].find((b) =>
          ['保存', 'Save'].includes(b.innerText.trim())
        ) ?? null,
      10000
    );
    if (!save) return JSON.stringify({ ok: false });
    save.click();
    return JSON.stringify({ ok: true });
  `);
  assert(savedColor.ok, '头像: 点到保存', savedColor);
  const colored = await waitFor(
    () => (readJson(profileFile).avatar?.color === '#ff00aa' ? readJson(profileFile) : null),
    'profile.json custom color',
    15_000,
    200
  ).catch(() => readJson(profileFile));
  assert(colored.avatar?.color === '#ff00aa', '头像: 自定义色落进 profile.json', colored.avatar);

  const sidebarColor = await waitFor(
    async () => {
      const face = await generatedFace();
      return face.svg && face.svg !== defaultFace.svg ? face : null;
    },
    'sidebar generated avatar recolored',
    15_000,
    300
  ).catch(() => generatedFace());
  assert(
    typeof sidebarColor.svg === 'string' &&
      sidebarColor.svg !== defaultFace.svg &&
      sidebarColor.image === null,
    '头像: 侧栏按自定义色重新生成 boring-avatars',
    sidebarColor
  );

  log('== 头像：上传图片并居中裁切');
  await settingsPage.setFiles('[data-enso=secretary-avatar-file]', [fixture]);
  const cropped = await settingsPage.json(`
    const confirm = () => [...document.querySelectorAll('button')]
      .find((b) => ['使用此头像', 'Use this avatar'].includes(b.innerText.trim()));
    const ready = await until(() => {
      const button = confirm();
      return button && !button.disabled ? button : null;
    }, 20000);
    if (!ready) return JSON.stringify({ ok: false });
    ready.click();
    return JSON.stringify({ ok: true });
  `);
  assert(cropped.ok, '头像: 裁切弹窗可以确认', cropped);
  const uploaded = await waitFor(
    () => (readJson(profileFile).avatar?.imageVersion ? readJson(profileFile) : null),
    'profile.json imageVersion',
    20_000,
    200
  ).catch(() => readJson(profileFile));
  assert(uploaded.avatar?.imageVersion >= 1, '头像: 上传后 imageVersion 落盘', uploaded.avatar);
  assert(existsSync(avatarFile), '头像: 图片写进秘书目录', avatarFile);
  assert(
    !JSON.stringify(uploaded).includes('base64') &&
      !JSON.stringify(uploaded).includes('avatar.png'),
    '头像: profile.json 只记版本，不塞图片或路径',
    uploaded.avatar
  );
  await settingsPage.shot(path.join(ART, '01c-avatar-uploaded.png'));

  // 连续换图：第二次必须当场生效（版本与指纹都变），不需要先失败一次
  const second = path.join(ART, 'avatar-source-2.png');
  writeAvatarFixture(second, [0, 170, 255]);
  await settingsPage.setFiles('[data-enso=secretary-avatar-file]', [second]);
  const recropped = await settingsPage.json(`
    const confirm = () => [...document.querySelectorAll('button')]
      .find((b) => ['使用此头像', 'Use this avatar'].includes(b.innerText.trim()));
    const ready = await until(() => {
      const button = confirm();
      return button && !button.disabled ? button : null;
    }, 20000);
    if (!ready) return JSON.stringify({ ok: false });
    ready.click();
    return JSON.stringify({ ok: true });
  `);
  assert(recropped.ok, '头像: 第二次换图也能确认裁切', recropped);
  const replaced = await waitFor(
    () => ((readJson(profileFile).avatar?.imageVersion ?? 0) >= 2 ? readJson(profileFile) : null),
    'profile.json imageVersion 2',
    20_000,
    200
  ).catch(() => readJson(profileFile));
  assert(replaced.avatar?.imageVersion >= 2, '头像: 连续换图第二次当场生效', replaced.avatar);
  assert(
    Boolean(replaced.avatar?.imageHash) &&
      replaced.avatar?.imageHash !== uploaded.avatar?.imageHash,
    '头像: 换图后 URL 上的图片指纹跟着变',
    replaced.avatar
  );
  const secondSrc = await settingsPage.json(`
    const img = await until(
      () => document.querySelector('[data-enso=secretary-settings-avatar] img'),
      20000
    );
    return JSON.stringify({ src: img?.getAttribute('src') ?? null });
  `);
  assert(
    typeof secondSrc.src === 'string' &&
      secondSrc.src.includes(`v=${replaced.avatar.imageVersion}`) &&
      secondSrc.src.includes(`h=${replaced.avatar.imageHash}`),
    '头像: 设置页头像地址带上新版本与新指纹',
    secondSrc
  );

  const faces = await page(`
    S().selectConversation(${JSON.stringify(setup.secretaryId)});
    const sidebar = await until(() => {
      const node = document.querySelector('[data-enso=secretary-avatar][data-image=true]');
      return node?.querySelector('img')?.src ?? null;
    }, 20000);
    const project = SET().projects.find(
      (p) => p.id === ${JSON.stringify(setup.secretaryProjectId)}
    );
    await S().send(
      '在吗',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      ${JSON.stringify(setup.secretaryId)}
    );
    const chat = await until(() => {
      const scroller = document.querySelector('[data-virtuoso-scroller]');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      const node = document.querySelector('[data-enso=secretary-chat-avatar][data-image=true]');
      if (!node) return null;
      return node.matches('img')
        ? node.getAttribute('src')
        : (node.querySelector('img')?.getAttribute('src') ?? null);
    }, 30000);
    return JSON.stringify({ sidebar, chat });
  `);
  assert(
    typeof faces.sidebar === 'string' && faces.sidebar.includes('secretary-avatar/avatar.png'),
    '头像: 侧栏换成图片',
    faces.sidebar
  );
  assert(
    typeof faces.chat === 'string' && faces.chat.includes('secretary-avatar/avatar.png'),
    '头像: 聊天回复头换成图片',
    faces.chat
  );

  const tab = await page(`
    SET().setHeaderSessionTabs(true);
    const node = await until(
      () => document.querySelector('[data-enso=secretary-tab-avatar][data-image=true]') ?? null,
      20000
    );
    return JSON.stringify({ src: node?.getAttribute('src') ?? null });
  `);
  assert(
    typeof tab.src === 'string' && tab.src.includes('secretary-avatar/avatar.png'),
    '头像: 顶栏会话标签换成图片',
    tab
  );
  await cdp.shot(path.join(ART, '01d-avatar-in-sidebar-and-chat.png'));

  log('== 头像：GIF 跳过裁切、原字节保存');
  const gifFixture = path.join(ART, 'avatar-source.gif');
  writeGifFixture(gifFixture);
  await settingsPage.setFiles('[data-enso=secretary-avatar-file]', [gifFixture]);
  const gifSaved = await waitFor(
    () =>
      (readJson(profileFile).avatar?.imageVersion ?? 0) > replaced.avatar.imageVersion
        ? readJson(profileFile)
        : null,
    'profile.json gif imageVersion',
    20_000,
    200
  ).catch(() => readJson(profileFile));
  assert(
    gifSaved.avatar?.imageVersion > replaced.avatar.imageVersion &&
      gifSaved.avatar?.imageHash !== replaced.avatar.imageHash,
    '头像: GIF 上传后版本与指纹都变',
    gifSaved.avatar
  );
  assert(
    readFileSync(avatarFile).equals(readFileSync(gifFixture)),
    '头像: GIF 原字节落盘，没有被 canvas 转成 PNG',
    readFileSync(avatarFile).subarray(0, 6).toString('latin1')
  );
  const gifCrop = await settingsPage.json(`
    const img = await until(() => {
      const node = document.querySelector('[data-enso=secretary-settings-avatar] img');
      return node?.getAttribute('src')?.includes('v=${gifSaved.avatar.imageVersion}') ? node : null;
    }, 20000);
    await until(() => img?.complete && img.naturalWidth > 0, 10000);
    img?.scrollIntoView({ block: 'center' });
    const crop = [...document.querySelectorAll('button')].some((b) =>
      ['使用此头像', 'Use this avatar'].includes(b.innerText.trim())
    );
    return JSON.stringify({ src: img?.getAttribute('src') ?? null, crop });
  `);
  assert(gifCrop.src && !gifCrop.crop, '头像: GIF 不弹裁切框，设置页换成新地址', gifCrop);
  const gifFaces = await page(`
    const want = 'v=${gifSaved.avatar.imageVersion}';
    const loaded = (img) => (img?.src.includes(want) && img.complete && img.naturalWidth > 0 ? img : null);
    const sidebar = await until(
      () => loaded(document.querySelector('[data-enso=secretary-avatar][data-image=true] img')),
      20000
    );
    const chat = await until(() => {
      const node = document.querySelector('[data-enso=secretary-chat-avatar][data-image=true]');
      return loaded(node?.matches('img') ? node : node?.querySelector('img'));
    }, 20000);
    const response = await fetch(sidebar?.src ?? '');
    const box = sidebar?.getBoundingClientRect();
    return JSON.stringify({
      type: response.headers.get('content-type'),
      natural: sidebar ? [sidebar.naturalWidth, sidebar.naturalHeight] : null,
      box: box ? [Math.round(box.width), Math.round(box.height)] : null,
      fit: sidebar ? getComputedStyle(sidebar).objectFit : null,
      position: sidebar ? getComputedStyle(sidebar).objectPosition : null,
      chat: Boolean(chat),
    });
  `);
  assert(gifFaces.type === 'image/gif', '头像: 受控接口按内容返回 image/gif', gifFaces);
  assert(
    gifFaces.natural?.[0] === 120 &&
      gifFaces.natural?.[1] === 80 &&
      gifFaces.box?.[0] === gifFaces.box?.[1] &&
      gifFaces.fit === 'cover' &&
      gifFaces.position === '50% 50%' &&
      gifFaces.chat,
    '头像: GIF 在侧栏与聊天里按正方形 cover 居中显示',
    gifFaces
  );
  await cdp.shot(path.join(ART, '01d2-avatar-gif-in-sidebar-and-chat.png'));
  await settingsPage.shot(path.join(ART, '01d3-avatar-gif-settings.png'));

  const guarded = await page(`
    const ok = await fetch('local-image://secretary-avatar/avatar.png?v=1').then((r) => r.status);
    const traversal = await fetch('local-image://secretary-avatar/../profile.json').then((r) => r.status);
    const encoded = await fetch('local-image://secretary-avatar/%2e%2e%2fprofile.json').then((r) => r.status);
    return JSON.stringify({ ok, traversal, encoded });
  `);
  assert(guarded.ok === 200, '头像: 受控接口能读到图片', guarded);
  assert(
    guarded.traversal === 403 && guarded.encoded === 403,
    '头像: 受控接口拒绝路径穿越',
    guarded
  );

  const draftGuard = await page(`
    const before = ${JSON.stringify(gifSaved.avatar.imageVersion)};
    const saved = await window.electronAPI.secretary.saveProfile({
      avatar: { color: '#ff00aa', imageVersion: 99 },
    });
    return JSON.stringify({ ok: saved.ok, version: saved.profile?.avatar?.imageVersion, before });
  `);
  assert(
    draftGuard.ok && draftGuard.version === draftGuard.before,
    '头像: 档案草案改不了图片版本',
    draftGuard
  );

  log('== 头像：移除图片');
  await settingsPage.json(`
    const remove = await until(
      () => document.querySelector('[data-enso=secretary-avatar-remove]'),
      15000
    );
    remove?.click();
    return JSON.stringify({ ok: true });
  `);
  const removed = await waitFor(
    () => (readJson(profileFile).avatar?.imageVersion === undefined ? readJson(profileFile) : null),
    'profile.json without imageVersion',
    20_000,
    200
  ).catch(() => readJson(profileFile));
  assert(removed.avatar?.imageVersion === undefined, '头像: 移除后不再记图片版本', removed.avatar);
  assert(!existsSync(avatarFile), '头像: 移除后删掉图片文件', avatarFile);

  const restored = await page(`
    const node = await until(() => {
      const avatar = document.querySelector('[data-enso=secretary-avatar]');
      return avatar && avatar.getAttribute('data-image') !== 'true' ? avatar : null;
    }, 20000);
    const face = node?.querySelector('[data-enso=secretary-avatar-face][data-generated=true]');
    return JSON.stringify({
      // React useId 给 mask 的 id 每次挂载都不同，比较前抹掉
      svg: face?.querySelector('svg')?.outerHTML.replace(/_r_\\w+?_/g, '') ?? null,
      image: node?.getAttribute('data-image'),
    });
  `);
  assert(
    restored.svg === sidebarColor.svg && restored.image === null,
    '头像: 移除后回到按名字和颜色生成的头像',
    restored
  );
  await cdp.shot(path.join(ART, '01e-avatar-removed.png'));

  const audits = readFileSync(auditFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.op === 'profile_avatar')
    .map((entry) => entry.detail);
  assert(
    audits.includes('uploaded') && audits.includes('removed'),
    '头像: 上传与移除都记审计',
    audits
  );

  await closeSettingsWindow(settingsPage);
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
    { title: 'Lint rule', content: 'lint rule bans quokka imports' },
    { title: 'Backup policy', content: 'backup policy keeps axolotl snapshots' },
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
  const panelTarget = seeded.find((item) => item.title === 'Lint rule');
  const panelDoomed = seeded.find((item) => item.title === 'Backup policy');
  assert(target && doomed && panelTarget && panelDoomed, '记忆: 四条都落在秘书私有空间', seeded);

  await verifyPanelMemoryActions(cdp, panelTarget, panelDoomed);

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

    log('== 悬停操作：设置页记忆列表');
    await settingsCdp.json(`
      document.querySelector('[data-memory-id=${JSON.stringify(target.id)}]')?.setAttribute('data-hover-probe', 'settings');
      return 'null';
    `);
    const settingsHover = await hoverList(settingsCdp, {
      shot: '48-settings-memory',
      areaSel: 'ul:has(> li[data-memory-id])',
      rowSel: '[data-hover-probe=settings]',
      contentSel: 'button.flex-1',
      actionSel: '[data-memory-action="row-edit"]',
      focusFrom: 'button.flex-1',
      afterClick: `
        const dialog = await until(() => document.querySelector('[data-memory-edit]'), 5000);
        if (!dialog) {
          return JSON.stringify({
            ok: false,
            dialogs: document.querySelectorAll('[data-slot=dialog-popup]').length,
            probe: Boolean(document.querySelector('[data-hover-probe=settings] [data-memory-action="row-edit"]')),
          });
        }
        const r = dialog.closest('[data-slot=dialog-popup]').querySelector('[aria-label=Close]').getBoundingClientRect();
        return JSON.stringify({ ok: true, closeAt: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, gone: '[data-memory-edit]' });
      `,
    });
    assertHover('设置页记忆', settingsHover);

    log('== 记忆：设置页编辑一条');
    const edited = await ui(`
      ${UI}
      q('[data-memory-id=${JSON.stringify(target.id)}] button:not([role=checkbox])').click();
      const editButton = await until(() => q('[data-memory-action="edit"]'), 10000);
      if (!editButton) return JSON.stringify({ ok: false, error: 'no edit button' });
      editButton.click();
      // 编辑在独立弹窗里，字段限定在 data-memory-edit 下，别碰到正在关闭的详情框
      const title = await until(() => q('[data-memory-edit] [data-memory-field="title"]'), 5000);
      typeInto(title, 'Release window');
      typeInto(q('[data-memory-edit] [data-memory-field="content"]'), 'release window is friday narwhal');
      typeInto(q('[data-memory-edit] [data-memory-field="importance"]'), '0.85');
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

    log('== 记忆：设置页从列表行直接删除一条（二次确认）');
    const asked = await ui(`
      ${UI}
      // 编辑完回到的详情框里「永久删除」应是危险色；关掉它，改从列表行尾直接删，不经过详情
      const popup = q('[data-memory-detail]')?.closest('[data-slot=dialog-popup]');
      const detailDelete = popup?.querySelector('[data-memory-action="delete"]');
      // 计算色可能是 oklch，画到 1px canvas 上取回 rgb
      const toRgb = (color) => {
        const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d');
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      const detailDeleteColor = detailDelete ? toRgb(getComputedStyle(detailDelete).color) : [];
      popup?.querySelector('[aria-label=Close]')?.click();
      await until(() => !q('[data-memory-detail]'), 5000);
      const deleteButton = q('[data-memory-id=${JSON.stringify(doomed.id)}] [data-memory-action="row-delete"]');
      if (!deleteButton) return JSON.stringify({ ok: false, error: 'row delete missing' });
      deleteButton.click();
      const confirm = await until(() => {
        const button = q('[data-memory-action="confirm-delete"]');
        return button && !button.disabled ? button : null;
      }, 10000);
      return JSON.stringify({
        ok: Boolean(confirm),
        detailDeleteColor,
        detailOpened: Boolean(q('[data-memory-detail]')),
        impact: q('[data-memory-delete-impact]')?.innerText ?? '',
        stillThereBeforeConfirm: Boolean(await window.electronAPI.memory.detail(${JSON.stringify(doomed.id)})),
      });
    `);
    // 按实际渲染的文字颜色判：红色通道明显高于绿、蓝（Tailwind 类名子串不可靠）
    const [r = 0, g = 0, b = 0] = asked.detailDeleteColor;
    assert(r > g + 60 && r > b + 60, '记忆: 详情里的「永久删除」是危险色', asked.detailDeleteColor);
    assert(
      asked.ok && !asked.detailOpened,
      '记忆: 列表行尾直接点删除就弹确认，不用先开详情',
      asked
    );
    await settingsCdp.shot(path.join(ART, '41-settings-row-delete-confirm.png'));
    const deleted = await ui(`
      ${UI}
      q('[data-memory-action="confirm-delete"]').click();
      const gone = await until(() => !rowIds().includes(${JSON.stringify(doomed.id)}), 15000);
      return JSON.stringify({ ok: Boolean(gone) });
    `);
    Object.assign(deleted, asked, { ok: deleted.ok });
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
    await settingsCdp.shot(path.join(ART, '42-settings-deleted.png'));
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openSecretaryTab(cdp, tab) {
  const tabSel = `[data-enso=secretary-panel-tab][data-tab=${tab}]`;
  const visible = () =>
    cdp.json(`
      const el = visiblePanel()?.querySelector(${JSON.stringify(tabSel)});
      if (!el) return 'false';
      const r = el.getBoundingClientRect();
      if (!r.width || r.left >= innerWidth || r.right <= 0) return 'false';
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return JSON.stringify(Boolean(hit && el.contains(hit)));
    `);
  for (let attempt = 0; attempt < 3 && !(await visible()); attempt++) {
    // 侧栏里的「新建标签页」菜单才有秘书面板入口；别的菜单打开了再点一次收起
    await cdp.json(`
      const buttons = [...document.querySelectorAll('button')]
        .filter((b) => b.getAttribute('aria-label') === '新建标签页' && b.getClientRects().length)
        .reverse();
      for (const b of buttons) {
        b.click();
        await sleep(400);
        const item = document.querySelector('[data-enso=secretary-panel-open]');
        if (item) {
          item.click();
          await sleep(800);
          return 'true';
        }
        b.click();
        await sleep(200);
      }
      return 'false';
    `);
    if (await visible()) break;
    await cdp.json(`
      [...document.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-label') === '折叠/展开右侧面板')
        ?.click();
      await sleep(1200);
      return 'null';
    `);
  }
  return cdp.json(`
    const el = visiblePanel()?.querySelector(${JSON.stringify(tabSel)});
    if (!el) return JSON.stringify({ ok: false, error: 'tab missing', panels: document.querySelectorAll('[data-enso=secretary-panel]').length, visible: Boolean(visiblePanel()) });
    el.click();
    await sleep(300);
    return JSON.stringify({ ok: el.getAttribute('aria-selected') !== 'false' });
  `);
}

const HOVER_DOM = `
  const effectiveOpacity = (el) => {
    let o = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return Math.round(o * 100) / 100;
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  };
  const measure = (row, contentSel, actionSel) => {
    const content = row.querySelector(contentSel);
    const action = row.querySelector(actionSel);
    if (!content || !action) return { error: 'content or action missing' };
    const rr = row.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(row).paddingRight) || 0;
    const ar = action.getBoundingClientRect();
    const hit = document.elementFromPoint(ar.left + ar.width / 2, ar.top + ar.height / 2);
    const layer = action.closest('[data-slot=hover-actions]');
    return {
      row: box(row),
      action: box(action),
      // 文字区右边到行内边距的距离：给按钮占位时这里会空出一截
      gap: Math.round((rr.right - pad - content.getBoundingClientRect().right) * 10) / 10,
      opacity: effectiveOpacity(action),
      clickable: Boolean(hit && (hit === action || action.contains(hit))),
      mask: layer ? getComputedStyle(layer).backgroundImage.includes('gradient') : false,
      focusInActions: Boolean(document.activeElement?.closest('[data-slot=hover-actions]')),
      rowHovered: row.matches(':hover'),
      pointerEvents: layer ? getComputedStyle(layer).pointerEvents : null,
      active: document.activeElement
        ? {
            tag: document.activeElement.tagName,
            enso: document.activeElement.getAttribute?.('data-enso') ?? null,
            inRow: row.contains(document.activeElement),
          }
        : null,
    };
  };
`;

/**
 * 一个列表的悬停操作：平时按钮不可见、文字占满整行；鼠标悬停时按钮浮在右侧渐变蒙版上、能点；
 * 移开后消失；键盘 Tab 聚焦到行内操作时也显示。每种状态都截面板图。
 */
async function hoverList(cdp, spec) {
  const at = (body) =>
    cdp.json(`
      ${HOVER_DOM}
      const row = document.querySelector(${JSON.stringify(spec.rowSel)});
      if (!row) return JSON.stringify({ error: 'row missing' });
      ${body}
    `);
  const measureRow = `return JSON.stringify(measure(row, ${JSON.stringify(spec.contentSel)}, ${JSON.stringify(spec.actionSel)}));`;
  await at(`row.scrollIntoView({ block: 'center' }); await sleep(200); return 'null';`);
  const panel = await cdp.json(`
        const area = ${spec.areaSel ? `document.querySelector(${JSON.stringify(spec.areaSel)})` : 'visiblePanel()'};
    if (!area) return JSON.stringify({ x: 0, y: 0, width: 0, height: 0 });
    const r = area.getBoundingClientRect();
    return JSON.stringify({ x: r.left, y: r.top, width: r.width, height: r.height });
  `);
  if (!(panel.width > 0 && panel.height > 0)) return { error: 'no visible area', panel };
  // 鼠标停到区域左上角外侧（标题处），离开所有行
  const away = () => cdp.mouse('mouseMoved', panel.x + 12, Math.max(4, panel.y - 12));
  await away();
  await sleep(300);
  const rest = await at(measureRow);
  if (rest.error) return { rest };
  const clip = {
    x: panel.x,
    y: Math.max(panel.y, rest.row.y - 160),
    width: panel.width,
    height: Math.min(320, panel.y + panel.height - Math.max(panel.y, rest.row.y - 160)),
  };
  if (!(clip.height >= rest.row.height)) return { rest, error: 'row outside area', panel, clip };
  await cdp.shotClip(path.join(ART, `${spec.shot}-rest.png`), clip);

  // 刚切过标签时第一下 mouseMoved 偶尔没让行进入 :hover；在行内挪几下再量，按钮仍不出现才算失败
  let hover;
  for (let i = 0; i < 5; i++) {
    await cdp.mouse('mouseMoved', rest.row.x + 24 + i * 6, rest.row.y + rest.row.height / 2);
    await sleep(300);
    hover = await at(measureRow);
    if (hover.opacity >= 0.95) break;
  }
  await cdp.shotClip(path.join(ART, `${spec.shot}-hover.png`), clip);

  const cx = hover.action.x + hover.action.width / 2;
  const cy = hover.action.y + hover.action.height / 2;
  // 设置页是后开的窗口，第一下点击可能只把窗口带到前台。每次重取按钮中心再点。
  let clicked;
  for (let attempt = 0; attempt < 3 && !clicked?.ok; attempt += 1) {
    const point = await at(`
      const action = row.querySelector(${JSON.stringify(spec.actionSel)});
      if (!action) return JSON.stringify(null);
      action.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = action.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    `);
    const x = point?.x ?? cx;
    const y = point?.y ?? cy;
    await cdp.mouse('mouseMoved', x, y);
    await sleep(80);
    await cdp.mouse('mousePressed', x, y);
    await cdp.mouse('mouseReleased', x, y);
    clicked = await cdp.json(spec.afterClick);
  }
  // 弹窗要像用户一样用鼠标关；脚本 .click() 没有指针事件，base-ui 会当成键盘关而把焦点还回行内
  if (clicked?.ok && clicked.closeAt) {
    const { x, y } = clicked.closeAt;
    await cdp.mouse('mouseMoved', x, y);
    await cdp.mouse('mousePressed', x, y);
    await cdp.mouse('mouseReleased', x, y);
    clicked.ok = await cdp.json(
      `return JSON.stringify(Boolean(await until(() => !document.querySelector(${JSON.stringify(clicked.gone)}), 5000)));`
    );
  }

  // 不替用户 blur：关弹窗的动画与焦点还原都结束后，只把鼠标移开再量
  await sleep(500);
  let left;
  for (let i = 0; i < 8; i += 1) {
    await away();
    await sleep(200);
    left = await at(measureRow);
    if (left && !left.error && left.opacity <= 0.05 && left.rowHovered === false) break;
  }

  await at(`row.querySelector(${JSON.stringify(spec.focusFrom)}).focus(); return 'null';`);
  await cdp.key('Tab', 'Tab', 9);
  await sleep(300);
  const keyboard = await at(measureRow);
  await cdp.json(`document.activeElement?.blur(); return 'null';`);
  return { rest, hover, clicked, left, keyboard };
}

function assertHover(name, result) {
  const { rest, hover, clicked, left, keyboard } = result;
  assert(
    !result.error && rest && !rest.error && rest.opacity <= 0.05 && rest.gap <= 1,
    `悬停操作(${name}): 平时看不到按钮，行内不给按钮留空白`,
    result.error ? result : rest
  );
  assert(
    hover && hover.opacity >= 0.95 && hover.clickable && hover.mask,
    `悬停操作(${name}): 悬停后按钮浮在右侧渐变蒙版上，点得到`,
    hover
  );
  assert(clicked?.ok, `悬停操作(${name}): 悬停时点按钮生效`, clicked);
  assert(left && left.opacity <= 0.05, `悬停操作(${name}): 鼠标移开后按钮与蒙版一起消失`, left);
  assert(
    keyboard?.focusInActions && keyboard.opacity >= 0.95,
    `悬停操作(${name}): 键盘 Tab 聚焦到行内操作时按钮显示`,
    keyboard
  );
}

/** 待办与记忆两个列表的悬停操作；先把两边都量完、截完图再断言，改动前跑一遍也能拿到对照图 */
async function verifyRowHoverActions(cdp) {
  log('== 悬停操作：待办列表');
  const todoText = '整理下周的发布说明，确认上线窗口后同步给 J 哥，再把回滚预案补进文档';
  const seeded = await cdp.json(`
    const added = await window.electronAPI.secretary.mutateTodo({ action: 'add', text: ${JSON.stringify(todoText)} });
    return JSON.stringify(added);
  `);
  const workbench = await openSecretaryTab(cdp, 'workbench');
  const rowReady = await cdp.json(`
        for (const n of document.querySelectorAll('[data-hover-probe]')) n.removeAttribute('data-hover-probe');
    const row = await until(() => [...(visiblePanel()?.querySelectorAll('[data-enso=secretary-todo]') ?? [])]
      .find((r) => r.innerText.includes(${JSON.stringify(todoText)})), 10000);
    if (!row) return 'false';
    row.setAttribute('data-hover-probe', 'todo');
    return 'true';
  `);
  const todo = rowReady
    ? await hoverList(cdp, {
        shot: '46-todo',
        rowSel: '[data-hover-probe=todo]',
        contentSel: '.flex-1',
        actionSel: 'button[title="编辑"], button[title="Edit"]',
        focusFrom: '[data-enso=secretary-todo-done]',
        // 点「编辑」：这一行变成输入框，Esc 退回
        afterClick: `
          const input = await until(() => {
            const el = document.activeElement;
            return el?.tagName === 'INPUT' && el.value === ${JSON.stringify(todoText)} ? el : null;
          }, 5000);
          if (!input) return JSON.stringify({ ok: false, active: document.activeElement?.outerHTML?.slice(0, 200) });
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                    const back = await until(() => {
            const row = [...(visiblePanel()?.querySelectorAll('[data-enso=secretary-todo]') ?? [])]
              .find((r) => r.innerText.includes(${JSON.stringify(todoText)}));
            row?.setAttribute('data-hover-probe', 'todo');
            return row;
          }, 5000);
          return JSON.stringify({ ok: Boolean(back) });
        `,
      })
    : null;

  log('== 悬停操作：记忆列表');
  const memoryTab = await openSecretaryTab(cdp, 'memory');
  await cdp.json(`
        for (const n of document.querySelectorAll('[data-hover-probe]')) n.removeAttribute('data-hover-probe');
    const row = await until(() => visiblePanel()?.querySelector('[data-enso=secretary-memory-row] > div'), 10000);
    row?.setAttribute('data-hover-probe', 'memory');
    return 'null';
  `);
  const memory = await hoverList(cdp, {
    shot: '47-memory',
    rowSel: '[data-hover-probe=memory]',
    contentSel: '[data-enso=secretary-memory-open]',
    actionSel: '[data-memory-action="row-edit"]',
    focusFrom: '[data-enso=secretary-memory-open]',
    // 点「编辑」：弹出编辑框，再用真鼠标点右上角关掉
    afterClick: `
      const dialog = await until(() => document.querySelector('[data-memory-edit]'), 5000);
      if (!dialog) return JSON.stringify({ ok: false });
      const r = dialog.closest('[data-slot=dialog-popup]').querySelector('[aria-label=Close]').getBoundingClientRect();
      return JSON.stringify({ ok: true, closeAt: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, gone: '[data-memory-edit]' });
    `,
  });

  assert(seeded?.ok && workbench.ok && rowReady, '悬停操作: 造一条长待办并打开工作台', {
    seeded,
    workbench,
  });
  assertHover('待办', todo ?? {});
  assert(memoryTab.ok, '悬停操作: 切到记忆标签', memoryTab);
  assertHover('记忆', memory);
}

/**
 * 右侧秘书面板「记忆」标签：每行常驻编辑 / 删除。编辑走同一个编辑弹窗，删除先预览影响再确认，
 * 结果与设置页同源：新词搜得到、旧词搜不到、删除后搜不到，审计都落 memory/audit.jsonl。
 */
async function verifyPanelMemoryActions(cdp, target, doomed) {
  const page = cdp.json.bind(cdp);
  const DOM = `
    const q = (s) => document.querySelector(s);
    const typeInto = (el, value) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const row = (id) => q('[data-enso="secretary-memory-row"][data-memory-id="' + id + '"]');
    const shownOnScreen = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.left >= innerWidth || r.right <= 0) return false;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return Boolean(hit && (el === hit || el.contains(hit)));
    };
  `;
  log('== 记忆：秘书面板「记忆」标签每行带编辑与删除');
  const panel = await openSecretaryTab(cdp, 'memory');
  assert(panel.ok, '面板记忆: 打开秘书面板的「记忆」标签', panel);
  const opened = await page(`
    ${DOM}
    const ready = await until(() => row(${JSON.stringify(target.id)}) && row(${JSON.stringify(doomed.id)}), 15000);
    if (!ready) return JSON.stringify({ ok: false, error: 'rows missing', text: q('[data-enso=secretary-memory]')?.innerText });
    const actions = (id) => ({
      edit: Boolean(row(id).querySelector('[data-memory-action="row-edit"]')),
      remove: Boolean(row(id).querySelector('[data-memory-action="row-delete"]')),
    });
    return JSON.stringify({
      ok: true,
      target: actions(${JSON.stringify(target.id)}),
      doomed: actions(${JSON.stringify(doomed.id)}),
      detailOpen: Boolean(q('[data-enso="secretary-memory-detail"]')),
    });
  `);
  assert(
    opened.ok &&
      opened.target.edit &&
      opened.target.remove &&
      opened.doomed.edit &&
      opened.doomed.remove &&
      !opened.detailOpen,
    '面板记忆: 没点开任何一条时，每行就有编辑与删除（悬停浮出，见下一段）',
    opened
  );
  await cdp.shot(path.join(ART, '43-panel-memory-actions.png'));
  await verifyRowHoverActions(cdp);

  log('== 记忆：秘书面板编辑一条');
  const edited = await page(`
    ${DOM}
    row(${JSON.stringify(target.id)}).querySelector('[data-memory-action="row-edit"]').click();
    const title = await until(
      () => q('[data-memory-edit=${JSON.stringify(target.id)}] [data-memory-field="title"]'),
      10000
    );
    if (!title) return JSON.stringify({ ok: false, error: 'edit dialog missing' });
    typeInto(title, 'Lint policy');
    typeInto(q('[data-memory-edit] [data-memory-field="content"]'), 'lint policy bans pangolin imports');
    await sleep(200);
    q('[data-memory-action="save"]').click();
    const saved = await until(
      () => !q('[data-memory-edit]') && row(${JSON.stringify(target.id)})?.innerText.includes('Lint policy'),
      15000
    );
    return JSON.stringify({
      ok: Boolean(saved),
      rowText: row(${JSON.stringify(target.id)})?.innerText ?? null,
      error: q('[data-memory-edit] .text-destructive')?.textContent ?? null,
    });
  `);
  assert(edited.ok, '面板记忆: 编辑弹窗保存后行内显示新标题', edited);
  const afterEdit = await page(`
    const find = async (query, mode) =>
      (await window.electronAPI.memory.list({ query, mode, limit: 20, offset: 0 })).items.map((i) => i.id);
    return JSON.stringify({
      newExact: await find('pangolin', 'exact'),
      newFast: await find('pangolin', 'fast'),
      oldExact: await find('quokka', 'exact'),
      oldFast: await find('quokka', 'fast'),
    });
  `);
  assert(
    afterEdit.newExact.includes(target.id) &&
      afterEdit.newFast.includes(target.id) &&
      !afterEdit.oldExact.includes(target.id) &&
      !afterEdit.oldFast.includes(target.id),
    '面板记忆: 编辑后新内容搜得到、旧内容搜不到（精确与检索模式）',
    afterEdit
  );

  log('== 记忆：秘书面板删除一条（先预览影响再确认）');
  const asked = await page(`
    ${DOM}
    row(${JSON.stringify(doomed.id)}).querySelector('[data-memory-action="row-delete"]').click();
    const confirm = await until(() => {
      const button = q('[data-memory-action="confirm-delete"]');
      return button && !button.disabled ? button : null;
    }, 10000);
    return JSON.stringify({
      ok: Boolean(confirm),
      impact: q('[data-memory-delete-impact]')?.innerText ?? '',
      stillThere: Boolean(await window.electronAPI.memory.detail(${JSON.stringify(doomed.id)})),
    });
  `);
  assert(
    asked.ok &&
      asked.stillThere &&
      (asked.impact.includes('不影响其他记忆') ||
        asked.impact.includes('No other memories are affected')),
    '面板记忆: 点删除先弹确认并说明影响，确认前不删',
    asked
  );
  await cdp.shot(path.join(ART, '44-panel-delete-confirm.png'));
  const deleted = await page(`
    ${DOM}
    q('[data-memory-action="confirm-delete"]').click();
    const gone = await until(() => !row(${JSON.stringify(doomed.id)}), 15000);
    const exact = await window.electronAPI.memory.list({ query: 'axolotl', limit: 20, offset: 0 });
    const fast = await window.electronAPI.memory.list({ query: 'axolotl', mode: 'fast', limit: 20, offset: 0 });
    return JSON.stringify({
      ok: Boolean(gone),
      detail: await window.electronAPI.memory.detail(${JSON.stringify(doomed.id)}),
      exact: exact.items.map((i) => i.id),
      fast: fast.items.map((i) => i.id),
    });
  `);
  assert(
    deleted.ok &&
      deleted.detail === null &&
      deleted.exact.length === 0 &&
      deleted.fast.length === 0,
    '面板记忆: 确认后行消失，精确与检索模式都搜不到',
    deleted
  );
  await cdp.shot(path.join(ART, '45-panel-after.png'));

  const audit = readFileSync(memoryAuditFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const editAudit = audit.filter((e) => e.action === 'memory.edit' && e.memoryId === target.id);
  const deleteAudit = audit.filter(
    (e) => e.action === 'memory.delete' && e.requested.includes(doomed.id)
  );
  assert(
    editAudit.length === 1 &&
      editAudit[0].changes.title?.to === 'Lint policy' &&
      !JSON.stringify(editAudit[0]).includes('quokka'),
    '面板记忆: 编辑记了审计，正文只留 hash',
    editAudit
  );
  assert(
    deleteAudit.length === 1 && deleteAudit[0].impact.deleted[0]?.id === doomed.id,
    '面板记忆: 删除记了审计',
    deleteAudit
  );
}

/** 新开一个秘书会话，让 fake provider 调一次秘书工具，取回工具结果原文 */
async function secretaryTool(cdp, setup, toolName, args, ask) {
  const prompt = `${ask} [[tool:${toolName} ${JSON.stringify(args)}]]`;
  return cdp.json(`
    const secretary = await SEC();
    const id = await secretary.getState().newSecretaryConversation({ secretaryId: 'default' });
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

/** 工具结果经 MemoryInvoker 解开一层，正文是 `{ todos }`，不是 `{ result: { todos } }` */
function listedTodos(payload) {
  let parsed = null;
  try {
    parsed = JSON.parse(payload?.text ?? 'null');
  } catch {
    return [];
  }
  const todos = parsed?.todos ?? parsed?.result?.todos;
  return Array.isArray(todos) ? todos : [];
}

const auditLines = () =>
  readFileSync(auditFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

/** 工具结果可能是「单行 JSON + <source_reference> 行」：只解析第一行 */
function parseToolJson(text) {
  try {
    return JSON.parse(String(text ?? '').split('\n', 1)[0]);
  } catch {
    return null;
  }
}

/** 纯色 PNG：秘书看图那一步用，宽高写进 IHDR，验收断言读得出来 */
function writePngFixture(file, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 4;
      raw[at] = 40;
      raw[at + 1] = 120;
      raw[at + 2] = 220;
      raw[at + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  writeFileSync(
    file,
    Buffer.concat([
      PNG_SIGNATURE,
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', deflateSync(raw)),
      pngChunk('IEND', Buffer.alloc(0)),
    ])
  );
}

/**
 * 看图与收尾清理：/tmp 下的图片读得到、越界路径被拒、cleanup_list 列出分支、
 * cleanup_apply 只落确认卡，确认后真的删掉已合入的分支。
 */
async function verifyImageViewAndCleanup(cdp, setup) {
  const page = cdp.json.bind(cdp);
  log('== 看图与收尾清理');

  const imageFile = path.join('/tmp', `sec-verify-${process.pid}-${Date.now()}.png`);
  writePngFixture(imageFile, 64, 48);
  const viewed = await secretaryTool(cdp, setup, 'image_view', { path: imageFile }, '看看这张截图');
  // 带 path 参数的工具结果后面会追加一行 <source_reference>，只取第一行
  const viewedMeta = parseToolJson(viewed.text);
  assert(
    // 返回的是解析过符号链接的真实路径：/tmp 在 macOS 上是 /private/tmp
    path.basename(viewedMeta?.path ?? '') === path.basename(imageFile) &&
      viewedMeta?.width === 64 &&
      viewedMeta?.height === 48 &&
      typeof viewedMeta?.size === 'number',
    'image: /tmp 下的图片读得到，尺寸与文件大小一起回来',
    viewedMeta ?? viewed.text
  );
  const thumb = await page(`
    // 工具卡片是异步渲染的：先等卡片出现再展开，否则点击落空、缩略图永远不出来
    const card = await until(
      () => document.querySelector('[data-enso=tool-card][data-tool=image_view]'),
      15000
    );
    card?.querySelector('[data-enso=tool-card-expand]')?.click();
    // #300 起缩略图在 tool-card-image 里的 <img>：结果带图片字节时直接用 data URL
    const image = await until(
      () => document.querySelector('[data-enso=tool-card][data-tool=image_view] [data-enso=tool-card-image] img'),
      15000
    );
    return JSON.stringify({
      src: image?.getAttribute('src') ?? null,
      alt: image?.getAttribute('alt') ?? null,
      text: image?.closest('[data-enso=tool-card-body]')?.innerText ?? null,
    });
  `);
  assert(
    typeof thumb.src === 'string' &&
      (thumb.src.startsWith('data:image/png') || thumb.src.startsWith('local-image://')),
    'image: 工具卡片用缩略图显示图片',
    thumb
  );
  assert((thumb.text ?? '').includes('64 × 48'), 'image: 卡片上写着尺寸', thumb);
  await cdp.shot(path.join(ART, '20-image-view.png'));

  const outOfScope = path.join(process.env.HOME ?? '/root', '.ssh', 'id_rsa');
  const denied = await secretaryTool(cdp, setup, 'image_view', { path: outOfScope }, '再看看这个');
  assert(
    typeof denied.text === 'string' && denied.text.includes('out of scope'),
    'image: 白名单外的路径被拒绝并说明原因',
    denied.text
  );

  // 造两条分支：一条与基线同点（等于已合入），一条多一个提交（未合入）
  const gitIn = (args) => spawnSync('git', args, { cwd: PROJ, encoding: 'utf8' });
  const current = (gitIn(['rev-parse', '--abbrev-ref', 'HEAD']).stdout ?? '').trim();
  if (current !== 'feat/secretary-agent') gitIn(['branch', '-f', 'feat/secretary-agent']);
  gitIn(['branch', '-f', 'feat/verify-cleanup']);
  gitIn(['checkout', '-q', '-B', 'feat/verify-open']);
  writeFileSync(path.join(PROJ, 'open.txt'), 'not merged yet\n');
  gitIn(['add', '-A']);
  gitIn(['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'open']);
  gitIn(['checkout', '-q', current]);

  // 默认是精简摘要：数量 + 每类前几条，正文两千字以内，秘书自己就能读完，不用 read/grep
  const listed = await secretaryTool(
    cdp,
    setup,
    'cleanup_list',
    { kind: 'branch' },
    '看看有什么可以清理的'
  );
  const summary = parseToolJson(listed.text);
  const summaryItems = Array.isArray(summary?.items) ? summary.items : [];
  assert(
    summary?.mode === 'summary' &&
      summary.total >= 2 &&
      summary.counts?.branch === summary.total &&
      summaryItems.length === summary.total &&
      summaryItems.length <= 5 &&
      JSON.stringify(summary).length <= 2000 &&
      typeof summary.hint === 'string' &&
      summary.hint.includes('detail: true'),
    'cleanup: 默认返回精简摘要，正文两千字以内',
    summary ?? listed.text
  );
  const summaryMerged = summaryItems.find((item) => item.name === 'feat/verify-cleanup');
  assert(
    Boolean(summaryMerged?.id) &&
      summaryMerged.path === undefined &&
      summaryMerged.repoPath === undefined &&
      summaryMerged.mergedInto === undefined,
    'cleanup: 摘要每条只有 id、名字与大小',
    summaryMerged ?? summaryItems
  );

  const detailed = await secretaryTool(
    cdp,
    setup,
    'cleanup_list',
    { detail: true, kind: 'branch' },
    '要完整清单'
  );
  const detail = parseToolJson(detailed.text);
  const items = Array.isArray(detail?.items) ? detail.items : [];
  assert(
    detail?.mode === 'detail' &&
      detail.page === 1 &&
      detail.pageSize <= 20 &&
      detail.hasMore === false &&
      detail.total === items.length &&
      JSON.stringify(detail).length <= 4000,
    'cleanup: detail 给分页字段，正文四千字以内',
    detail ?? detailed.text
  );
  const merged = items.find(
    (item) => item.kind === 'branch' && item.name === 'feat/verify-cleanup'
  );
  const open = items.find((item) => item.kind === 'branch' && item.name === 'feat/verify-open');
  assert(
    merged && !merged.blocked && (merged.mergedInto ?? []).includes('feat/secretary-agent'),
    'cleanup: 已合入的分支列出来且可清理',
    merged ?? items
  );
  assert(
    summaryMerged?.id === merged?.id,
    'cleanup: 摘要里的 id 与完整清单一致，能直接传给 cleanup_apply',
    { summary: summaryMerged?.id, detail: merged?.id }
  );
  assert(
    open && open.blocked === 'not-merged',
    'cleanup: 未合入的分支带上 not-merged',
    open ?? items
  );
  assert(
    !items.some((item) => item.name === 'feat/secretary-agent' || item.name === 'main'),
    'cleanup: 基线分支不进清单',
    items.map((item) => item.name)
  );

  const applied = await secretaryTool(
    cdp,
    setup,
    'cleanup_apply',
    // 直接用精简模式给的 id：秘书拿到的就是这一份
    { ids: [summaryMerged.id] },
    '把这条已合入的分支清掉'
  );
  const appliedMeta = parseToolJson(applied.text);
  assert(
    appliedMeta?.status === 'awaiting_confirmation' && typeof appliedMeta?.proposalId === 'string',
    'cleanup: 先返回待确认，不直接删',
    appliedMeta ?? applied.text
  );
  assert(
    (gitIn(['branch', '--list', 'feat/verify-cleanup']).stdout ?? '').includes(
      'feat/verify-cleanup'
    ),
    'cleanup: 确认前分支还在',
    null
  );

  const card = await page(`
    const node = await until(
      () => document.querySelector('[data-enso=secretary-proposal][data-kind=cleanup]'),
      20000
    );
    if (!node) return JSON.stringify({ ok: false });
    node.scrollIntoView({ block: 'center' });
    return JSON.stringify({
      ok: true,
      text: node.innerText,
      items: node.querySelectorAll('[data-enso=secretary-cleanup-kind]').length,
    });
  `);
  assert(
    card.ok &&
      (card.text ?? '').includes('feat/verify-cleanup') &&
      card.items >= 1 &&
      card.items <= 5,
    'cleanup: 确认卡上列出会删的分支，最多五行',
    card
  );
  await cdp.shot(path.join(ART, '21-cleanup-card.png'));

  const confirmed = await page(`
    document.querySelector('[data-enso=secretary-cleanup-confirm]')?.click();
    const secretary = await SEC();
    const done = await until(() => {
      const p = secretary.getState().secretary.proposals[${JSON.stringify(appliedMeta.proposalId)}];
      return p && p.status !== 'pending' && p.status !== 'executing' ? p : null;
    }, 30000);
    return JSON.stringify({ status: done?.status, report: done?.report ?? null });
  `).catch((error) => ({ status: 'error', report: String(error?.message ?? error) }));
  assert(
    confirmed.status === 'succeeded' && (confirmed.report ?? '').includes('deleted 1'),
    'cleanup: 确认后执行并回报删了什么',
    confirmed
  );
  assert(
    !(gitIn(['branch', '--list', 'feat/verify-cleanup']).stdout ?? '').includes(
      'feat/verify-cleanup'
    ),
    'cleanup: 确认后分支真的删掉了',
    null
  );
  const cleanupAudit = auditLines().filter((line) => line.op === 'cleanup_branch');
  assert(
    cleanupAudit.length === 1 && cleanupAudit[0].ok === true,
    'cleanup: 每个动作都记审计',
    cleanupAudit
  );
  rmSync(imageFile, { force: true });
}

/**
 * 转发图片：编码会话自己能用 image_view 看图，秘书能把截图路径通过
 * session_send attachments 交过去，目标会话时间线上出现图片引用。
 */
async function verifyForwardImages(cdp, setup) {
  const page = cdp.json.bind(cdp);
  log('== 转发图片：编码会话看图 + session_send attachments');

  const imageFile = path.join('/tmp', `sec-verify-fwd-${process.pid}-${Date.now()}.png`);
  writePngFixture(imageFile, 32, 24);
  const realImage = realpathSync(imageFile);

  // 接管范围放到 all：这一节要往一个普通会话里发消息，范围权限是最轻的一条路
  const scoped = await page(`
    const saved = await window.electronAPI.secretary.saveProfile({ takeoverScope: { mode: 'all' } });
    return JSON.stringify({ ok: saved.ok === true, error: saved.error ?? null });
  `);
  assert(scoped.ok, '转发图片: 接管范围改成 all', scoped);

  const plain = await page(`
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.projectId)});
    const id = await S().newConversation(project.id);
    S().selectConversation(id);
    const textOf = (message) =>
      (Array.isArray(message.content) ? message.content : [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
    await S().send(
      '看看这张截图 [[tool:image_view {"path": ${JSON.stringify(imageFile)}}]]',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      id
    );
    const viewed = await until(
      () => (S().conversations[id]?.messages ?? []).find((m) => m.toolName === 'image_view') ?? null,
      40000
    );
    return JSON.stringify({
      id,
      text: viewed ? textOf(viewed) : null,
      isError: viewed?.isError === true,
    });
  `);
  const meta = parseToolJson(plain.text);
  assert(
    plain.isError === false &&
      meta?.width === 32 &&
      meta?.height === 24 &&
      typeof meta?.size === 'number',
    '编码会话: image_view 看得到 /tmp 下的截图，尺寸与大小一起回来',
    plain
  );

  const denied = await page(`
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.projectId)});
    // 假 provider 只要看到历史里有工具结果就不再发工具调用，所以越界这一条另开一个会话
    const id = await S().newConversation(project.id);
    S().selectConversation(id);
    const textOf = (message) =>
      (Array.isArray(message.content) ? message.content : [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
    await S().send(
      '再看看这个 [[tool:image_view {"path": "/etc/hosts"}]]',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      id
    );
    const last = await until(
      () => (S().conversations[id]?.messages ?? []).find((m) => m.toolName === 'image_view') ?? null,
      40000
    );
    return JSON.stringify({
      id,
      text: last ? textOf(last) : null,
      isError: last?.isError === true,
    });
  `);
  assert(
    denied.isError === true && String(denied.text).includes('out of scope'),
    '编码会话: 白名单外的路径被拒绝并说明原因',
    denied
  );

  const forwarded = await secretaryTool(
    cdp,
    setup,
    'session_send',
    { conversationId: plain.id, message: '按这张图改', attachments: [imageFile] },
    '把这张截图转给会话'
  );
  assert(
    parseToolJson(forwarded.text)?.status === 'sent',
    '转发图片: 秘书把截图路径发进目标会话',
    forwarded.text
  );
  const received = await page(`
    const id = ${JSON.stringify(plain.id)};
    S().selectConversation(id);
    const found = await until(
      () =>
        (S().conversations[id]?.messages ?? []).find(
          (m) =>
            m.role === 'user' &&
            JSON.stringify(m.content ?? '').includes(${JSON.stringify(`[图片 1] ${realImage}`)})
        ) ?? null,
      40000
    );
    const text = found
      ? (Array.isArray(found.content) ? found.content : [])
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('')
      : '';
    return JSON.stringify({ text });
  `);
  assert(
    String(received.text).includes(`[图片 1] ${realImage}`) &&
      String(received.text).includes('用 image_view 查看这些图片。'),
    '转发图片: 目标会话收到带图片引用的消息',
    received
  );
  const sendAudit = auditLines().filter(
    (line) => line.op === 'session_send' && line.ok === true && line.detail?.includes('images:')
  );
  assert(
    sendAudit.some((line) => line.detail.includes(realImage)),
    '转发图片: 审计里记下转发了哪张图',
    sendAudit.at(-1) ?? null
  );

  const refused = await secretaryTool(
    cdp,
    setup,
    'session_send',
    { conversationId: plain.id, message: '按图改', attachments: ['/etc/hosts'] },
    '把越界路径转过去'
  );
  assert(
    String(refused.text).includes('attachments[1] /etc/hosts') &&
      String(refused.text).includes('out of scope'),
    '转发图片: 越界路径被拒绝，并指出是哪一张',
    refused.text
  );

  rmSync(imageFile, { force: true });
}

async function verifyToolCards(cdp, setup) {
  const page = cdp.json.bind(cdp);
  log('== 工具卡片：可读摘要，默认不露原始 JSON');
  const prep = await page(`
    SET().setLanguage('zh');
    const project = SET().projects.find((item) => item.id === ${JSON.stringify(setup.projectId)});
    const target = await S().newConversation(project.id);
    S().renameConversation(target, '写发布说明');
    await S().send('先打个招呼', {
      providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path,
    }, undefined, target);
    const greeted = await until(
      () => (S().conversations[target]?.messages ?? []).some((message) => message.role === 'assistant'),
      30000
    );
    const secretary = await SEC();
    const secretaryId = await secretary.getState().newSecretaryConversation();
    const named = await window.electronAPI.secretary.referenceConversations(secretaryId, [target]);
    const todos = [];
    for (const text of ['补工具卡片单测', '改秘书渲染', '补验收脚本']) {
      todos.push(await window.electronAPI.secretary.mutateTodo({ action: 'add', text }));
    }
    return JSON.stringify({
      ok: named.ok && greeted && todos.every((row) => row.ok),
      target,
      secretaryProjectId: secretary.getState().secretary.projectId,
      todos,
    });
  `);
  assert(prep.ok, '工具卡片: 准备会话和三条待办', prep);
  const message = '请看一下发布说明，确认没问题就提交。';
  const calls = [
    `[[tool:session_send ${JSON.stringify({ conversationId: prep.target, message })}]]`,
    ...prep.todos.map(
      (row) => `[[tool:todo_item_update ${JSON.stringify({ todoId: row.todoId, done: true })}]]`
    ),
    `[[tool:schedule_add ${JSON.stringify({ name: '巡检', prompt: '看一眼构建', cron: '*/10 * * * *' })}]]`,
  ].join('\n');
  const turn = await page(`
    const project = SET().projects.find((item) => item.id === ${JSON.stringify(prep.secretaryProjectId)});
    const id = await (await SEC()).getState().newSecretaryConversation();
    S().selectConversation(id);
    await S().send(${JSON.stringify(calls)}, {
      providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path,
    }, undefined, id);
    const ready = await until(() => {
      if (S().activeId !== id) S().selectConversation(id);
      const main = document.querySelector('[data-enso=main]');
      if (main && getComputedStyle(main).visibility === 'hidden') {
        const exit = [...document.querySelectorAll('button')].find((button) =>
          /fullscreen|全屏/.test(button.getAttribute('aria-label') ?? '')
        );
        exit?.click();
      }
      const scroller = document.querySelector('[data-virtuoso-scroller]');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      const cards = [...document.querySelectorAll('[data-enso=tool-card]')];
      const names = cards.map((card) => card.dataset.tool);
      return names.includes('session_send') && names.includes('todo_item_update') && names.includes('schedule_add')
        ? id
        : null;
    }, 40000);
    const names = [...document.querySelectorAll('[data-enso=tool-card]')].map((card) => card.dataset.tool);
    const tools = (S().conversations[id]?.messages ?? [])
      .filter((message) => message.role === 'tool' || message.toolName)
      .map((message) => message.toolName ?? message.name ?? message.role);
    const outline = (S().conversations[id]?.messages ?? []).map((message) => ({
      role: message.role,
      tool: message.toolName ?? null,
      types: Array.isArray(message.content)
        ? message.content.map((part) => part.type + (part.name ? ':' + part.name : ''))
        : typeof message.content,
    }));
    const timeline = document.querySelector('[data-enso=timeline]');
    const box = timeline?.getBoundingClientRect();
    const main = document.querySelector('[data-enso=main]');
    return JSON.stringify({
      id,
      active: S().activeId,
      tab: S().conversations[id]?.activeTabId ?? null,
      ready: Boolean(ready),
      names,
      tools,
      outline,
      text: (timeline?.innerText ?? '').slice(0, 400),
      timeline: box ? { w: Math.round(box.width), h: Math.round(box.height) } : null,
      visibility: timeline ? getComputedStyle(timeline).visibility : null,
      mainVisibility: main ? getComputedStyle(main).visibility : null,
      children: timeline?.childElementCount ?? null,
      virtuosoItems: document.querySelectorAll('[data-index]').length,
    });
  `);
  assert(turn.ready, '工具卡片: 三个工具都渲染成卡片', turn);

  const shotCard = async (tool, file) => {
    await page(`
      const card = document.querySelector('[data-enso=tool-card][data-tool=${JSON.stringify(tool)}]');
      card?.scrollIntoView({ block: 'center' });
      return JSON.stringify({ ok: Boolean(card) });
    `);
    await sleep(300);
    await cdp.shot(path.join(ART, file));
  };

  const visible = await page(`
    const cardOf = (tool) =>
      document.querySelector('[data-enso=tool-card][data-tool="' + tool + '"]');
    const textOf = (tool) => cardOf(tool)?.innerText ?? '';
    // 卡片和普通工具行一样默认收成一行，正文在折叠里；分组卡里每一条还要再展开一层
    const openAll = () => {
      for (const tool of ['session_send', 'todo_item_update', 'schedule_add']) {
        const card = cardOf(tool);
        if (!card) continue;
        for (const node of card.querySelectorAll('[data-enso=tool-card-expand][aria-expanded=false]')) {
          node.click();
        }
      }
    };
    const ready = await until(() => {
      openAll();
      const send = textOf('session_send');
      const todos = textOf('todo_item_update');
      const schedule = textOf('schedule_add');
      return send.includes(${JSON.stringify(message)}) &&
        todos.includes('补工具卡片单测') &&
        todos.includes('标记为完成') &&
        schedule.includes('每 10 分钟')
        ? { send, todos, schedule }
        : null;
    }, 15000);
    const send = ready?.send ?? textOf('session_send');
    const todos = ready?.todos ?? textOf('todo_item_update');
    const schedule = ready?.schedule ?? textOf('schedule_add');
    const raw = document.querySelector('[data-enso=tool-card-raw][aria-expanded=true]');
    return JSON.stringify({
      send,
      todos,
      schedule,
      rawOpen: Boolean(raw),
    });
  `);
  assert(
    visible.send.includes(message) &&
      (visible.send.includes('已送达') || visible.send.includes('已排队')) &&
      !visible.send.includes('{"'),
    '工具卡片: session_send 能看到正文和发送状态，默认没有原始 JSON',
    visible.send
  );
  assert(
    visible.todos?.includes('更新了 3 条待办') &&
      visible.todos.includes('补验收脚本') &&
      visible.todos.includes('标记为完成') &&
      !visible.todos.includes('{"'),
    '工具卡片: 连续更新合并成一组，展开后能看到待办文字',
    visible.todos
  );
  assert(
    visible.schedule.includes('每 10 分钟') &&
      visible.schedule.includes('巡检') &&
      !visible.schedule.includes('{"'),
    '工具卡片: schedule_add 显示每 N 分钟，默认没有原始 JSON',
    visible.schedule
  );
  assert(visible.rawOpen === false, '工具卡片: 原始数据默认折叠', visible);
  await shotCard('session_send', 'after-session-send.png');
  await shotCard('todo_item_update', 'after-todo-updates.png');
  await shotCard('schedule_add', 'after-schedule-add.png');
}

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

  // 会话顶栏的逐个授权按钮与对应 IPC 都已删除，逐个授权只剩确认卡这一条路
  log('== 接管：秘书提出 → 用户确认 → 撤销');
  const proposedGrant = await secretaryTool(
    cdp,
    setup,
    'session_takeover_propose',
    { conversationId: ownId, reason: '帮你盯着这个会话' },
    '把用户的会话交给我接管'
  );
  assert(
    proposedGrant.text?.includes('awaiting_confirmation'),
    '接管: 秘书提出接管只得到待确认',
    proposedGrant
  );
  assert(!readJson(dispatchFile).dispatched[ownId], '接管: 确认前没有授权');
  const confirmedGrant = await page(`
    const secretaryId = ${JSON.stringify(proposedGrant.secretaryId)};
    if (secretaryId) S().selectConversation(secretaryId);
    const card = await until(
      () => shown('[data-enso=secretary-proposal][data-kind=takeover]'),
      30000
    );
    if (!card) return JSON.stringify({ ok: false, error: 'no takeover card' });
    const secretary = await SEC();
    const proposal = Object.values(secretary.getState().secretary.proposals)
      .filter((p) => p.kind === 'takeover')
      .at(-1);
    card.querySelector('button').click();
    const done = await until(() => {
      const p = secretary.getState().secretary.proposals[proposal.id];
      return p && p.status !== 'pending' && p.status !== 'executing' ? p : null;
    }, 30000);
    return JSON.stringify({ ok: true, status: done?.status, error: done?.error });
  `);
  assert(
    confirmedGrant.ok && confirmedGrant.status === 'succeeded',
    '接管: 用户确认后接管生效',
    confirmedGrant
  );
  const grantedByCard = readJson(dispatchFile).dispatched[ownId];
  assert(grantedByCard?.takeover?.via === 'proposal', '接管: 确认卡授权落盘', grantedByCard);
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
    '接管: 取消接管仍然可用',
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
    const secretaryId = ${JSON.stringify(proposedTakeover.secretaryId)};
    if (secretaryId) S().selectConversation(secretaryId);
    const card = await until(
      () => shown('[data-enso=secretary-proposal][data-kind=takeover]'),
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
    return JSON.stringify(await window.electronAPI.secretary.revokeTakeover(id));
  `);
  assert(revoked.ok, '接管: 确认卡授权也能撤销', revoked);
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
    // 逐个授权的 IPC 已删除：授权只从确认卡来，不再有 via=user 的记录
    count('takeover_grant', true, 'user') === 0 &&
      count('takeover_grant', true, 'proposal') === 2 &&
      count('takeover_revoke', true) === 2 &&
      count('session_takeover_propose', true) >= 1 &&
      count('session_send', true) === 1 &&
      count('session_send', false, 'not-operable') === 1 &&
      count('session_stop', false, 'not-operable') === 1,
    '接管: 授权、撤销与秘书发的每条消息都有审计',
    audit
  );

  // 回归：秘书卡片分支曾把普通会话里的 MCP 工具也画成秘书卡片，验收没发现
  log('== 普通会话：mcp 与 bash 都是普通工具行，归在同一组');
  const plainTurn = await page(`
    const project = SET().projects.find((p) => p.id === ${JSON.stringify(setup.projectId)});
    const id = await S().newConversation(project.id);
    S().selectConversation(id);
    await S().send(
      '跑两个工具 [[tool:mcp__fake__echo {"text":"mcp-echo-hi"}]] [[tool:bash {"command":"printf bash-row"}]]',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      id
    );
    // 两个工具都要审批：轮询把弹出来的审批卡都放行
    const approved = [];
    for (let i = 0; i < 80; i += 1) {
      const conversation = S().conversations[id] ?? {};
      const pending = (conversation.pendingApprovals ?? [])[0];
      if (pending) {
        const reply = await window.electronAPI.agent.respondApproval(id, pending.requestId, 'allow');
        approved.push({ tool: pending.tool, ok: reply?.ok ?? null });
      }
      const tools = (conversation.messages ?? []).filter((message) => message.toolName);
      if (tools.length >= 2 && conversation.status !== 'running') break;
      await sleep(500);
    }
    const tools = (S().conversations[id]?.messages ?? [])
      .filter((message) => message.toolName)
      .map((message) => ({ name: message.toolName, isError: message.isError === true }));
    return JSON.stringify({ id, approved, tools });
  `);
  assert(
    plainTurn.tools?.length === 2 &&
      plainTurn.tools.some((tool) => tool.name === 'mcp__fake__echo') &&
      plainTurn.tools.some((tool) => tool.name === 'bash'),
    '普通会话: 假模型真的触发了 mcp 与 bash 两个工具',
    plainTurn
  );
  assert(
    plainTurn.tools.every((tool) => tool.isError === false),
    '普通会话: 两个工具都执行成功',
    plainTurn
  );
  const plainRows = await page(`
    const id = ${JSON.stringify(plainTurn.id)};
    S().selectConversation(id);
    // 缓存的其它会话也留着 tool-row，只认当前看得见的
    const rows = () =>
      visible('[data-enso=tool-row]').map((node) => node.innerText);
    const group = await until(
      () => visible('[data-enso=tool-row]').find((node) => /已工作|Worked for/.test(node.innerText)) ?? null,
      20000
    );
    if (!group)
      return JSON.stringify({
        ok: false,
        error: 'no tool group',
        // 失败时留下现场：当前会话、看得见的工具行和时间线末尾
        seen: {
          active: S().activeConversationId ?? S().selectedConversationId ?? null,
          visibleRows: rows(),
          allRows: document.querySelectorAll('[data-enso=tool-row]').length,
          visibleText: (visible('[data-virtuoso-scroller]')[0]?.innerText ?? '').slice(-1500),
        },
      });
    const groupText = group.innerText;
    // 完成后的过程组默认收起，点开才看得到组内原始行
    if (!rows().some((text) => text.includes('mcp-echo-hi'))) group.click();
    const expanded = await until(() => {
      const texts = rows();
      return texts.some((text) => text.includes('mcp-echo-hi')) &&
        texts.some((text) => text.includes('bash-row'))
        ? texts
        : null;
    }, 15000);
    return JSON.stringify({
      ok: Boolean(expanded),
      groupText,
      rows: expanded ?? rows(),
      cards: document.querySelectorAll('[data-enso=tool-card]').length,
    });
  `);
  assert(plainRows.ok, '普通会话: 过程组点开后两个工具行都在', plainRows);
  assert(
    plainRows.rows.some((text) => text.includes('mcp-echo-hi')) &&
      plainRows.rows.some((text) => text.includes('bash-row')),
    '普通会话: mcp 与 bash 都渲染成 tool-row',
    plainRows
  );
  assert(plainRows.cards === 0, '普通会话: 一个秘书卡片都没有（tool-card 为 0）', plainRows);
  assert(
    /已工作|Worked for/.test(plainRows.groupText) && plainRows.groupText.includes('2 个工具调用'),
    '普通会话: 两个工具归在同一个「已工作 Ns 2 个工具调用」分组里',
    plainRows
  );
  await cdp.shot(path.join(ART, '09-plain-tool-rows.png'));
}

/**
 * 多秘书：两个秘书结果各回各的、接管对方会话被拒、转交、侧栏整块折叠刷新后保持、
 * 总看板筛选、假 Telegram 下两个话题各进各的秘书、同一 bot + chat + 话题重复绑定被拒、
 * 未绑定的完全不响应、一个 token 只有一个轮询、两个 token 各一个轮询、
 * 删除秘书的提醒与二次确认、秘书间消息第 5 跳被拦、范围取交集。
 * 全部走界面与 IPC，不直接改磁盘。
 */
async function verifyMultiSecretary(cdp, setup) {
  let page = cdp.json.bind(cdp);
  const root = path.join(ENV, 'secretary');
  const memberDir = (id) => path.join(root, 'members', id);

  log('== 多秘书：新建第二个秘书');
  const created = await page(`
    const result = await window.electronAPI.secretary.create();
    if (!result.ok) return JSON.stringify(result);
    const saved = await window.electronAPI.secretary.saveProfile(
      {
        name: '阿财',
        avatar: { color: '#22c55e' },
        visibleProjectIds: 'all',
        maxRunningDispatches: 3,
        patrolEnabled: true,
        replyLanguage: 'ui',
        style: 'concise',
        notify: 'off',
        addressAs: null,
        dailyBriefAt: null,
      },
      result.secretaryId
    );
    const secretary = await SEC();
    const conversationId = await secretary
      .getState()
      .newSecretaryConversation({ secretaryId: result.secretaryId });
    return JSON.stringify({
      ok: saved.ok && Boolean(conversationId),
      secretaryId: result.secretaryId,
      conversationId,
      error: saved.ok ? null : saved.error,
    });
  `);
  assert(created.ok, '多秘书: 第二个秘书建出来并有自己的会话', created);
  const second = created.secretaryId;

  log('== 多秘书：顶栏与侧栏各用自己秘书的头像');
  const tabPng = path.join(ART, 'tab-avatar-default.png');
  const tabGif = path.join(ART, 'tab-avatar-second.gif');
  writeAvatarFixture(tabPng, [255, 200, 0]);
  writeGifFixture(tabGif);
  const tabs = await page(`
    const api = window.electronAPI.secretary;
    const bytes = (base64) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const ids = { default: 'default', second: ${JSON.stringify(second)} };
    const set = [
      await api.setAvatar(bytes(${JSON.stringify(readFileSync(tabPng).toString('base64'))}), ids.default),
      await api.setAvatar(bytes(${JSON.stringify(readFileSync(tabGif).toString('base64'))}), ids.second),
    ];
    if (!set.every((result) => result.ok)) return JSON.stringify({ ok: false, set });
    SET().setHeaderSessionTabs(true);
    const secretary = await SEC();
    // 秘书项目不进侧栏分组，顶栏只强制留下当前会话，所以两个 tab 要分别选中才出现
    const mine = await secretary.getState().newSecretaryConversation({ secretaryId: ids.default });
    const otherId = ${JSON.stringify(created.conversationId)};
    const tabLoaded = (conversationId, secretaryId) => {
      const img = document.querySelector(
        '[data-session-tab="' + conversationId + '"] img[data-enso=secretary-tab-avatar]'
      );
      return img?.src.includes('s=' + secretaryId) && img.complete && img.naturalWidth > 0 ? img : null;
    };
    const sideLoaded = (secretaryId) => {
      const img = document.querySelector(
        '[data-secretary-id="' + secretaryId + '"] img[data-enso=secretary-avatar-face]'
      );
      return img?.src.includes('s=' + secretaryId) && img.complete && img.naturalWidth > 0 ? img : null;
    };
    const probe = async (img) => {
      if (!img) return null;
      const response = await fetch(img.src);
      return { src: img.getAttribute('src'), status: response.status, type: response.headers.get('content-type') };
    };
    S().selectConversation(mine);
    const first = await until(() => tabLoaded(mine, ids.default), 20000);
    const sideDefault = await until(() => sideLoaded(ids.default), 20000);
    const sideSecond = await until(() => sideLoaded(ids.second), 20000);
    S().selectConversation(otherId);
    const other = await until(() => tabLoaded(otherId, ids.second), 20000);
    return JSON.stringify({
      ok: true,
      mine,
      focused: secretary.getState().focusedId,
      first: await probe(first),
      other: await probe(other),
      sideDefault: await probe(sideDefault),
      sideSecond: await probe(sideSecond),
    });
  `);
  assert(
    tabs.ok &&
      tabs.first?.status === 200 &&
      tabs.first.type === 'image/png' &&
      tabs.sideDefault?.type === 'image/png' &&
      tabs.sideSecond?.type === 'image/gif',
    '多秘书: 选中小安时 tab 用小安的 PNG；侧栏两行同时各带自己的 s=',
    tabs
  );
  assert(
    tabs.other?.status === 200 && tabs.other.type === 'image/gif' && tabs.focused === second,
    '多秘书: 选中阿财时 tab 用阿财的 GIF 头像',
    tabs
  );
  await cdp.shot(path.join(ART, '13a-multi-secretary-tabs.png'));
  const cleared = await page(`
    const api = window.electronAPI.secretary;
    await api.setAvatar(null, 'default');
    await api.setAvatar(null, ${JSON.stringify(second)});
    const mine = ${JSON.stringify(tabs.mine ?? '')};
    const otherId = ${JSON.stringify(created.conversationId)};
    const generated = (conversationId) =>
      document.querySelector(
        '[data-session-tab="' + conversationId + '"] [data-enso=secretary-tab-avatar][data-generated=true]'
      );
    S().selectConversation(mine);
    const first = await until(() => generated(mine), 20000);
    S().selectConversation(otherId);
    const other = await until(() => generated(otherId), 20000);
    const sides = await until(
      () =>
        document.querySelector('[data-secretary-id="default"] [data-enso=secretary-avatar-face][data-generated=true]') &&
        document.querySelector('[data-secretary-id="${second}"] [data-enso=secretary-avatar-face][data-generated=true]')
          ? true
          : null,
      20000
    );
    return JSON.stringify({ ok: Boolean(first && other && sides) });
  `);
  assert(cleared.ok, '多秘书: 移除图片后两个 tab 都回到生成头像', cleared);

  log('== 多秘书：结果各回各的');
  const routed = await page(`
    const api = window.electronAPI.secretary;
    const secretary = await SEC();
    const directive = (title) =>
      '派个活 [[tool:session_create ' +
      JSON.stringify({ projectId: ${JSON.stringify(setup.projectId)}, prompt: '写一行', title }) +
      ']]';
    const make = async (secretaryId, title) => {
      const conversationId = await secretary.getState().newSecretaryConversation({ secretaryId });
      const project = SET().projects.find(
        (entry) => entry.id === secretary.getState().states[secretaryId].projectId
      );
      await S().send(
        directive(title),
        { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
        undefined,
        conversationId
      );
      const card = await until(() => {
        const board = secretary.getState().states[secretaryId]?.board;
        return [...(board?.needsYou ?? []), ...(board?.running ?? []), ...(board?.done ?? [])].find(
          (entry) => entry.kind === 'session' && entry.title === title
        ) ?? null;
      }, 30000);
      return card?.conversationId ?? null;
    };
    const first = await make('default', '小安的活');
    const other = await make(${JSON.stringify(second)}, '阿财的活');
    const boards = () => secretary.getState().states;
    const titles = (id) => {
      const board = boards()[id]?.board ?? { needsYou: [], running: [], done: [] };
      return [...board.needsYou, ...board.running, ...board.done]
        .filter((card) => card.kind === 'session')
        .map((card) => card.title);
    };
    return JSON.stringify({
      ok: Boolean(first) && Boolean(other),
      first,
      other,
      defaultTitles: titles('default'),
      secondTitles: titles(${JSON.stringify(second)}),
    });
  `);
  assert(routed.ok, '多秘书: 两个秘书各派一个活', routed);
  assert(
    routed.defaultTitles.includes('小安的活') && !routed.defaultTitles.includes('阿财的活'),
    '多秘书: 小安的看板只有小安的活',
    routed
  );
  assert(
    routed.secondTitles.includes('阿财的活') && !routed.secondTitles.includes('小安的活'),
    '多秘书: 阿财的看板只有阿财的活',
    routed
  );
  // 重启后归属不变：两份派发文件各记各的
  const defaultDispatch = readJson(path.join(root, 'dispatch.json'));
  const secondDispatch = readJson(path.join(memberDir(second), 'dispatch.json'));
  assert(
    Object.hasOwn(defaultDispatch.dispatched, routed.first) &&
      !Object.hasOwn(defaultDispatch.dispatched, routed.other) &&
      Object.hasOwn(secondDispatch.dispatched, routed.other) &&
      !Object.hasOwn(secondDispatch.dispatched, routed.first),
    '多秘书: 派发记录按秘书分文件，重启后归属不变',
    { first: routed.first, other: routed.other }
  );

  log('== 多秘书：接管对方的会话被拒');
  const refused = await secretaryTool(
    cdp,
    setup,
    'session_takeover_propose',
    { conversationId: routed.other },
    '把阿财派出的那个会话接管过来'
  );
  assert(
    refused.text?.includes('managed-by-other'),
    '多秘书: 接管另一个秘书派出的会话被拒，原因是 managed-by-other',
    refused
  );

  log('== 多秘书：转交');
  const transferred = await page(`
    // 走会话顶栏的转交入口：打开会话 → 点转交 → 选接收的秘书
    const press = (el) => {
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
        el.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, button: 0, pointerType: 'mouse' }));
      }
      el.click();
    };
    S().selectConversation(${JSON.stringify(routed.first)});
    const trigger = await until(() => document.querySelector('[data-enso=secretary-transfer]'), 15000);
    if (!trigger) return JSON.stringify({ ok: false, error: 'no transfer control' });
    press(trigger);
    const item = await until(
      () => document.querySelector('[data-enso=secretary-transfer-target][data-secretary=${JSON.stringify(second).slice(1, -1)}]'),
      8000
    );
    if (!item) return JSON.stringify({ ok: false, error: 'no transfer target' });
    const targets = [...document.querySelectorAll('[data-enso=secretary-transfer-target]')].map((n) => n.dataset.secretary);
    press(item);
    const secretary = await SEC();
    const seen = await until(() => {
      const board = secretary.getState().states[${JSON.stringify(second)}]?.board;
      return [...(board?.needsYou ?? []), ...(board?.running ?? []), ...(board?.done ?? [])].some(
        (card) => card.conversationId === ${JSON.stringify(routed.first)}
      )
        ? true
        : null;
    }, 15000);
    return JSON.stringify({ ok: seen === true, targets });
  `);
  assert(transferred.ok, '多秘书: 从会话顶栏把会话转交给阿财，阿财的看板上出现它', transferred);
  assert(
    !transferred.targets?.includes('default'),
    '多秘书: 转交入口只列出别的秘书，不列当前管理它的',
    transferred
  );
  const after = readJson(path.join(memberDir(second), 'dispatch.json'));
  const before = readJson(path.join(root, 'dispatch.json'));
  assert(
    Object.hasOwn(after.dispatched, routed.first) &&
      !Object.hasOwn(before.dispatched, routed.first),
    '多秘书: 转交后记录只在接收方的文件里'
  );

  log('== 多秘书：侧栏整块折叠，刷新后保持');
  const folded = await page(`
    const header = document.querySelector('[data-enso=secretary-group]');
    if (!header) return JSON.stringify({ ok: false, error: 'no group header' });
    header.querySelector('[data-enso=secretary-group-fold]').click();
    await sleep(300);
    return JSON.stringify({
      ok: header.getAttribute('data-expanded') === null &&
        localStorage.getItem('enso-collapsed-secretary-group') === '1',
    });
  `);
  assert(folded.ok, '多秘书: 侧栏整块折叠写入 localStorage', folded);
  // 刷新后折叠保持：reload 会毁掉当前执行上下文，所以重新连一次
  await cdp.evaluate('location.reload()');
  await sleep(1500);
  const reloaded = await waitForStableRenderer();
  const kept = await reloaded.json(`
    const header = await until(() => document.querySelector('[data-enso=secretary-group]'), 30000);
    return JSON.stringify({
      ok: Boolean(header) &&
        header.getAttribute('data-expanded') === null &&
        document.querySelectorAll('[data-enso=secretary-section]').length === 0,
    });
  `);
  assert(kept.ok, '多秘书: 刷新后整块折叠保持，秘书行都不渲染', kept);
  await reloaded.json(`
    document.querySelector('[data-enso=secretary-group-fold]')?.click();
    await sleep(300);
    return JSON.stringify({ ok: true });
  `);
  log('== 多秘书：折叠后头像还在，行内箭头只在悬停时出现，整块标题箭头常显');
  const foldedRow = await reloaded.json(`
    const row = document.querySelector('[data-enso=secretary-section] [data-enso=secretary-row]');
    if (!row) return JSON.stringify({ ok: false, error: 'no row' });
    if (row.getAttribute('data-expanded') !== null) {
      row.querySelector('[data-enso=secretary-fold]')?.click();
    }
    document.activeElement?.blur?.();
    await sleep(200);
    row.scrollIntoView({ block: 'center' });
    const painted = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return style.display !== 'none' && Number(style.opacity) > 0.5 && box.width > 0 && box.height > 0;
    };
    const box = row.getBoundingClientRect();
    const chevron = document.querySelector('[data-enso=secretary-group-chevron]');
    return JSON.stringify({
      avatar: painted(row.querySelector('[data-enso=secretary-avatar]')),
      icon: painted(row.querySelector('[data-enso=secretary-fold-icon]')),
      headerIcon: painted(chevron),
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    });
  `);
  assert(
    foldedRow.avatar && !foldedRow.icon && foldedRow.headerIcon,
    '多秘书: 折叠后头像仍在，行内箭头默认不可见，整块标题箭头常显',
    foldedRow
  );
  let hovered = { icon: false };
  for (let i = 0; i < 5 && !hovered.icon; i += 1) {
    await reloaded.mouse(
      'mouseMoved',
      foldedRow.x + 24 + i * 6,
      foldedRow.y + foldedRow.height / 2
    );
    await sleep(200);
    hovered = await reloaded.json(`
      const row = document.querySelector('[data-enso=secretary-section] [data-enso=secretary-row]');
      const icon = row?.querySelector('[data-enso=secretary-fold-icon]');
      const avatar = row?.querySelector('[data-enso=secretary-avatar]');
      const painted = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return style.display !== 'none' && Number(style.opacity) > 0.5 && box.width > 0;
      };
      const iconBox = icon?.getBoundingClientRect();
      const avatarBox = avatar?.getBoundingClientRect();
      return JSON.stringify({
        hovered: Boolean(row?.matches(':hover')),
        icon: painted(icon),
        avatar: painted(avatar),
        overlay: Boolean(iconBox && avatarBox && Math.abs(iconBox.x - avatarBox.x) < 2),
      });
    `);
  }
  assert(
    hovered.hovered && hovered.icon && hovered.avatar && hovered.overlay,
    '多秘书: 悬停后箭头叠在头像上，头像仍在',
    hovered
  );
  await reloaded.mouse('mouseMoved', 2, 2);
  await reloaded.json(`
    const row = document.querySelector('[data-enso=secretary-section] [data-enso=secretary-row]');
    if (row && row.getAttribute('data-expanded') === null) {
      row.querySelector('[data-enso=secretary-fold]')?.click();
    }
    return JSON.stringify({ ok: true });
  `);
  page = reloaded.json.bind(reloaded);

  log('== 多秘书：总看板筛选');
  const overview = await page(`
    const secretary = await SEC();
    secretary.getState().focus(${JSON.stringify(second)});
    S().selectConversation(${JSON.stringify(created.conversationId)});
    await sleep(400);
    // 这个会话还没开过秘书面板：从「新建标签页」里打开
    const toggles = [...document.querySelectorAll('button')].filter(
      (button) => button.getAttribute('aria-label') === '新建标签页' && button.offsetParent !== null
    );
    toggles.at(-1)?.click();
    const item = await until(() => document.querySelector('[data-enso=secretary-panel-open]'), 5000);
    item?.click();
    await sleep(800);
    const panel = visiblePanel();
    const option = (scope) =>
      panel?.querySelector('[data-enso=secretary-board-scope-option][data-scope="' + scope + '"]');
    if (!option('all')) return JSON.stringify({ ok: false, error: 'no scope switch' });
    const titles = (boards) =>
      boards.flatMap((entry) =>
        [...entry.board.needsYou, ...entry.board.running, ...entry.board.done]
          .filter((card) => card.kind === 'session')
          .map((card) => card.title)
      );
    const all = await window.electronAPI.secretary.overview();
    const of = (id) =>
      all.ok ? titles(all.boards.filter((entry) => entry.secretaryId === id)) : [];
    option('all').click();
    await sleep(400);
    const select = panel.querySelector('[data-enso=secretary-board-filter]');
    const textAll = panel.innerText;
    if (select) {
      select.value = ${JSON.stringify(second)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await sleep(400);
    const textFiltered = panel.innerText;
    option('own').click();
    return JSON.stringify({
      ok:
        all.ok &&
        all.boards.length === 2 &&
        of('default').includes('小安的活') === false &&
        of(${JSON.stringify(second)}).includes('阿财的活') &&
        of('default').length > 0 &&
        textFiltered !== textAll &&
        panel.querySelector('[data-enso=secretary-board-filter]')?.value === ${JSON.stringify(second)},
      hasFilter: Boolean(select),
      perSecretary: all.ok ? all.boards.map((entry) => ({ id: entry.secretaryId, n: titles([entry]).length })) : all.error,
    });
  `);
  assert(overview.ok, '多秘书: 总看板含两个秘书的卡片，按秘书筛选后只剩一个', overview);

  log('== 多秘书：同一个 bot，两个话题各进各的秘书');
  const token = telegram.state.token;
  const bound = await page(`
    const api = window.electronAPI.secretary;
    const bind = async (secretaryId) => {
      const result = await api.contactBind(${JSON.stringify(token)}, secretaryId);
      if (!result.ok) return null;
      const state = await api.contactState(secretaryId);
      return state.telegram.bind?.code ?? null;
    };
    const first = await bind('default');
    const other = await bind(${JSON.stringify(second)});
    return JSON.stringify({ ok: Boolean(first) && Boolean(other), first, other });
  `);
  assert(bound.ok, '多秘书: 两个秘书都生成了绑定码', bound);
  // 一条一条绑并等它落盘：两条挤在同一次 getUpdates 里时，轮询重启可能把后一条的确认冲掉
  const bindTopic = async (updateId, topicId, code, secretaryId) => {
    telegram.push({
      update_id: updateId,
      message: {
        message_id: updateId,
        chat: { id: -100, type: 'supergroup', title: '工作群', is_forum: true },
        from: { id: 777001, username: 'j3n5en', first_name: 'J' },
        message_thread_id: topicId,
        is_topic_message: true,
        text: `/bind@enso_verify_bot ${code}`,
      },
    });
    return page(`
      const ready = await until(async () => {
        const state = await window.electronAPI.secretary.contactState(${JSON.stringify(secretaryId)});
        return (state.telegram.routes ?? []).some((route) => route.topicId === '${topicId}')
          ? state.telegram.routes
          : null;
      }, 20000);
      return JSON.stringify(ready ?? []);
    `);
  };
  const routes = {
    a: await bindTopic(9001, 7, bound.first, 'default'),
    b: await bindTopic(9002, 9, bound.other, second),
  };
  assert(
    routes.a?.some((route) => route.topicId === '7') &&
      routes.b?.some((route) => route.topicId === '9'),
    '多秘书: 话题 7 绑小安，话题 9 绑阿财',
    routes
  );

  log('== 多秘书：同一 bot + chat + 话题重复绑定被拒');
  const conflicted = await page(`
    const result = await window.electronAPI.secretary.contactBind(
      undefined,
      ${JSON.stringify(second)}
    );
    if (!result.ok) return JSON.stringify(result);
    const state = await window.electronAPI.secretary.contactState(${JSON.stringify(second)});
    return JSON.stringify({ ok: true, code: state.telegram.bind?.code ?? null });
  `);
  assert(conflicted.ok && conflicted.code, '多秘书: 阿财拿到新的绑定码', conflicted);
  const sentBefore = telegram.state.sent.length;
  telegram.push({
    update_id: 9003,
    message: {
      message_id: 3,
      chat: { id: -100, type: 'supergroup', title: '工作群', is_forum: true },
      from: { id: 777001, username: 'j3n5en', first_name: 'J' },
      message_thread_id: 7,
      is_topic_message: true,
      text: `/bind@enso_verify_bot ${conflicted.code}`,
    },
  });
  await sleep(1500);
  const secondRoutes = readJson(path.join(memberDir(second), 'contact.json')).telegramRoutes ?? [];
  assert(
    !secondRoutes.some((route) => route.topicId === '7'),
    '多秘书: 话题 7 再绑给阿财被拒，路由没写进去',
    secondRoutes
  );
  assert(telegram.state.sent.length === sentBefore, '多秘书: 冲突时不在群里回话', {
    sent: telegram.state.sent.length - sentBefore,
  });

  log('== 多秘书：未绑定的话题完全不响应');
  telegram.push({
    update_id: 9004,
    message: {
      message_id: 4,
      chat: { id: -100, type: 'supergroup', title: '工作群', is_forum: true },
      from: { id: 777001, username: 'j3n5en', first_name: 'J' },
      message_thread_id: 11,
      is_topic_message: true,
      text: '有人吗',
    },
  });
  await sleep(1500);
  assert(telegram.state.sent.length === sentBefore, '多秘书: 未绑定的话题不响应、不提示');

  log('== 多秘书：两个 token 各一个轮询');
  const otherToken = '987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
  const secondBot = await page(`
    const api = window.electronAPI.secretary;
    const forgotten = await api.contactForgetBot(${JSON.stringify(second)});
    if (!forgotten.ok) return JSON.stringify(forgotten);
    const bound2 = await api.contactBind(${JSON.stringify(otherToken)}, ${JSON.stringify(second)});
    if (!bound2.ok) return JSON.stringify(bound2);
    const state = await api.contactState(${JSON.stringify(second)});
    return JSON.stringify({ ok: true, code: state.telegram.bind?.code ?? null });
  `);
  assert(secondBot.ok && secondBot.code, '多秘书: 阿财换了自己的 bot 并拿到绑定码', secondBot);
  // 只看这一段窗口里同时挂着的 getUpdates 数
  telegram.state.maxPolling = { ...telegram.state.polling };
  telegram.push(
    {
      update_id: 9010,
      message: {
        message_id: 10,
        chat: { id: 555001, type: 'private' },
        from: { id: 555001, username: 'j3n5en', first_name: 'J' },
        text: `/start ${secondBot.code}`,
      },
    },
    otherToken
  );
  await sleep(2500);
  const concurrent = telegram.state.maxPolling;
  assert(
    (concurrent[token] ?? 0) === 1 && (concurrent[otherToken] ?? 0) === 1,
    '多秘书: 一个 token 同一时刻只有一个 getUpdates，两个 token 各一个',
    concurrent
  );

  log('== 多秘书：删除秘书的提醒与二次确认');
  const deletion = await page(`
    const api = window.electronAPI.secretary;
    const preview = await api.deletePreview(${JSON.stringify(second)});
    const refused = await api.deleteSecretary(${JSON.stringify(second)}, false);
    return JSON.stringify({
      ok: preview.ok,
      sessions: preview.ok ? preview.preview.sessions.length : 0,
      contacts: preview.ok ? preview.preview.contacts : [],
      refused: refused.ok ? null : refused.error,
    });
  `);
  assert(
    deletion.ok && deletion.sessions > 0 && deletion.refused === 'confirmation-required',
    '多秘书: 删除前列出它在管的会话，不带二次确认就拒绝',
    deletion
  );
  const removed = await page(`
    const result = await window.electronAPI.secretary.deleteSecretary(${JSON.stringify(second)}, true);
    const list = await window.electronAPI.secretary.list();
    return JSON.stringify({ ok: result.ok, left: list.map((entry) => entry.id), error: result.error ?? null });
  `);
  assert(
    removed.ok && removed.left.length === 1 && removed.left[0] === 'default',
    '多秘书: 二次确认后删除，只剩原来的秘书',
    removed
  );
  assert(!existsSync(memberDir(second)), '多秘书: 删除后它的目录与绑定路由一起释放');

  // 前面的段落直接用 IPC 写档案（带秘书 id），绕过了欢迎页；这里按用户的路子走一遍：
  // 新建 → 侧栏点它 → 欢迎页「全部用默认，直接开始」→ 发第一条消息
  log('== 多秘书：新建的秘书走欢迎页「全部用默认」');
  const welcomed = await page(`
    const api = window.electronAPI.secretary;
    const created = await api.create();
    if (!created.ok) return JSON.stringify(created);
    const id = created.secretaryId;
    const open = await until(
      () =>
        document.querySelector(
          '[data-enso=secretary-section][data-secretary-id="' + id + '"] [data-enso=secretary-open]'
        ),
      15000
    );
    if (!open) return JSON.stringify({ ok: false, error: 'no sidebar row', id });
    open.click();
    const defaults = await until(
      () => document.querySelector('[data-enso=secretary-welcome] [data-enso=secretary-welcome-defaults]'),
      15000
    );
    if (!defaults) return JSON.stringify({ ok: false, error: 'no welcome', id });
    defaults.click();
    const settled = await until(() => {
      const welcome = document.querySelector('[data-enso=secretary-welcome]');
      if (!welcome) return { closed: true, error: null };
      const error = welcome.querySelector('.text-destructive')?.textContent ?? null;
      return error ? { closed: false, error } : null;
    }, 20000);
    const profile = await api.getProfile(id);
    const secretary = await SEC();
    const projectId = secretary.getState().secretaries.find((entry) => entry.id === id)?.projectId;
    const conversationId = S().activeId;
    const conversation = S().conversations[conversationId];
    let replied = false;
    if (conversation?.projectId === projectId) {
      const project = SET().projects.find((entry) => entry.id === projectId);
      await S().send(
        '你好',
        { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
        undefined,
        conversationId
      );
      replied = Boolean(
        await until(
          () => (S().conversations[conversationId]?.messages ?? []).some((m) => m.role === 'assistant'),
          40000
        )
      );
    }
    return JSON.stringify({
      ok: true,
      id,
      closed: settled?.closed ?? false,
      error: settled?.error ?? null,
      configured: Boolean(profile.ok && profile.profile),
      name: profile.ok ? (profile.profile?.name ?? null) : null,
      inOwnProject: conversation?.projectId === projectId,
      replied,
    });
  `);
  assert(
    welcomed.ok && welcomed.closed && welcomed.error === null && welcomed.configured,
    '多秘书: 新秘书点「全部用默认」不报错，设置完成、欢迎页让位',
    welcomed
  );
  assert(
    welcomed.inOwnProject && welcomed.replied,
    '多秘书: 新秘书的第一条消息发在它自己的会话里并收到回复',
    welcomed
  );
  const welcomedGone = await page(`
    const result = await window.electronAPI.secretary.deleteSecretary(${JSON.stringify(welcomed.id)}, true);
    const list = await window.electronAPI.secretary.list();
    return JSON.stringify({ ok: result.ok, left: list.map((entry) => entry.id) });
  `);
  assert(
    welcomedGone.ok && welcomedGone.left.length === 1,
    '多秘书: 删掉欢迎页建的秘书，回到单秘书',
    welcomedGone
  );

  log('== 多秘书：秘书间消息第 5 跳被拦，范围取交集');
  const third = await page(`
    const api = window.electronAPI.secretary;
    const created3 = await api.create();
    if (!created3.ok) return JSON.stringify(created3);
    await api.saveProfile(
      {
        name: '阿财',
        avatar: { color: '#22c55e' },
        visibleProjectIds: 'all',
        maxRunningDispatches: 3,
        patrolEnabled: false,
        replyLanguage: 'ui',
        style: 'concise',
        notify: 'off',
      },
      created3.secretaryId
    );
    const secretary = await SEC();
    const conversationId = await secretary
      .getState()
      .newSecretaryConversation({ secretaryId: created3.secretaryId });
    return JSON.stringify({ ok: Boolean(conversationId), secretaryId: created3.secretaryId, conversationId });
  `);
  assert(third.ok, '多秘书: 第三个秘书只看得见一个项目', third);
  // 链路由 Main 判定：往阿财的在途批次里放一条第 4 跳的同事消息，紧接着让阿财回一句。
  // 这一回合由同事消息触发，回过去就是第 5 跳，应被 chain-limit 拦住。
  const fourth = {
    key: 'peer:verify-chain:4:default:1',
    at: Date.now(),
    text: '请回我一句',
    kind: 'peer-message',
    fromSecretaryId: 'default',
    fromName: '秘书',
    chain: 'verify-chain',
    hop: 4,
    origins: ['default'],
    secretaryConversationId: third.conversationId,
  };
  const memberDispatch = path.join(memberDir(third.secretaryId), 'dispatch.json');
  const current = existsSync(memberDispatch)
    ? readJson(memberDispatch)
    : { version: 1, dispatched: {}, proposals: {}, outbox: [] };
  current.outbox = [...(current.outbox ?? []).filter((entry) => entry.key !== fourth.key), fourth];
  current.inflight = {
    deliveryId: 'verify-inflight',
    secretaryConversationId: third.conversationId,
    keys: [fourth.key],
    attempt: 1,
    nextAttemptAt: Date.now() + 600000,
  };
  writeFileSync(memberDispatch, JSON.stringify(current));
  const bounced = await page(`
    const secretary = await SEC();
    const project = SET().projects.find(
      (entry) => entry.id === secretary.getState().states[${JSON.stringify(third.secretaryId)}].projectId
    );
    const id = ${JSON.stringify(third.conversationId)};
    await S().send(
      '回小安一句 [[tool:secretary_message {"to":"秘书","text":"收到"}]]',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path },
      undefined,
      id
    );
    const result = await until(
      () => (S().conversations[id]?.messages ?? []).find(
        (message) => message.toolName === 'secretary_message'
      ) ?? null,
      40000
    );
    const text = result
      ? (Array.isArray(result.content) ? result.content : [])
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('')
      : '';
    return JSON.stringify({ ok: text.includes('chain-limit'), text });
  `);
  assert(bounced.ok, '多秘书: 第 5 跳被 chain-limit 拦住', bounced);

  // 小安只看得见这一个项目：阿财本来看得见全部，降权回合里取交集后只能看到这一个
  await page(`
    const saved = await window.electronAPI.secretary.saveProfile(
      { visibleProjectIds: [${JSON.stringify(setup.projectId)}] },
      'default'
    );
    return JSON.stringify({ ok: saved.ok });
  `);
  mkdirSync(`${PROJ}-extra`, { recursive: true });
  const extra = await page(`
    const project = await SET().addProject(${JSON.stringify(`${PROJ}-extra`)});
    return JSON.stringify({ id: project.id });
  `);
  const narrowed = await page(`
    const secretary = await SEC();
    const id = await secretary.getState().newSecretaryConversation({ secretaryId: ${JSON.stringify(third.secretaryId)} });
    const project = SET().projects.find(
      (entry) => entry.id === secretary.getState().states[${JSON.stringify(third.secretaryId)}].projectId
    );
    return JSON.stringify({ id, cwd: project.path });
  `);
  // 这一回合由小安发来的消息触发：小安只看得见一个项目，阿财看得见全部，取交集后只剩那一个
  const trigger = {
    key: 'peer:verify-scope:1:default:1',
    at: Date.now(),
    text: '看看你有哪些项目',
    kind: 'peer-message',
    fromSecretaryId: 'default',
    fromName: '秘书',
    chain: 'verify-scope',
    hop: 1,
    origins: ['default'],
    secretaryConversationId: narrowed.id,
  };
  const scopeDispatch = readJson(memberDispatch);
  scopeDispatch.outbox = [...(scopeDispatch.outbox ?? []), trigger];
  scopeDispatch.inflight = {
    deliveryId: 'verify-scope',
    secretaryConversationId: narrowed.id,
    keys: [trigger.key],
    attempt: 1,
    nextAttemptAt: Date.now() + 600000,
  };
  writeFileSync(memberDispatch, JSON.stringify(scopeDispatch));
  const narrowedResult = await page(`
    await S().send(
      '看看全部项目 [[tool:project_list {}]]',
      { providerId: 'pv-A', modelId: 'fake-model-1', cwd: ${JSON.stringify(narrowed.cwd)} },
      undefined,
      ${JSON.stringify(narrowed.id)}
    );
    const result = await until(() => {
      const messages = S().conversations[${JSON.stringify(narrowed.id)}]?.messages ?? [];
      const message = messages.filter((entry) => entry.toolName === 'project_list').at(-1);
      const text = message
        ? (Array.isArray(message.content) ? message.content : [])
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('')
        : '';
      return text ? text : null;
    }, 40000);
    return JSON.stringify({ text: result ?? '' });
  `);
  assert(
    narrowedResult.text.includes(setup.projectId) && !narrowedResult.text.includes(extra.id),
    '多秘书: 降权回合按可见范围取交集，发起方看不见的项目不出现',
    { extra: extra.id, text: narrowedResult.text.slice(0, 300) }
  );

  // 还原成单秘书：后面的段落按升级前的方式调用，不带秘书 id
  const restored = await page(`
    const api = window.electronAPI.secretary;
    const saved = await api.saveProfile({ visibleProjectIds: 'all' }, 'default');
    const result = await api.deleteSecretary(${JSON.stringify(third.secretaryId)}, true);
    const list = await api.list();
    return JSON.stringify({ ok: saved.ok && result.ok, left: list.map((entry) => entry.id) });
  `);
  assert(
    restored.ok && restored.left.length === 1 && restored.left[0] === 'default',
    '多秘书: 收尾删掉第三个秘书，回到单秘书',
    restored
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
