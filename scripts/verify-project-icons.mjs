import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { uiElementElectron } from './verify-electron.mjs';
import { mergeOwnedPids, ownedProcessGroups } from './verify-secretary-isolation.mjs';

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const ROOT = path.resolve(flag('--root') ?? path.resolve(import.meta.dirname, '..'));
const PREFIX = flag('--out-prefix') ?? '/tmp/project-icons-';

const children = [];
const trackedPids = [];
let artDir = null;

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
    } catch {}
  }
  for (const pid of owned) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

async function waitFor(fn, { timeout = 30_000, interval = 200, label = 'condition' } = {}) {
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

async function reserveCdpPort() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = await freePort();
    if (port !== 9222) return port;
  }
  throw new Error('挑不到 CDP 端口（拒绝 9222）');
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

function writeFakeSettings(userData) {
  mkdirSync(userData, { recursive: true });
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
    theme: 'system',
    language: 'zh-CN',
  };
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({ 'enso-settings': { state, version: 18 } })
  );
}

const ALPHA_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#e83e8c"/><text x="32" y="42" font-size="32" text-anchor="middle" fill="#fff" font-family="sans-serif" font-weight="bold">A</text></svg>`;
const BETA_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#20c997"/><text x="32" y="42" font-size="30" text-anchor="middle" fill="#fff" font-family="sans-serif" font-weight="bold">B</text></svg>`;

function writeDemoProjects(base) {
  const alpha = path.join(base, 'alpha-project');
  const beta = path.join(base, 'beta-project');
  const gamma = path.join(base, 'gamma-project');
  mkdirSync(path.join(alpha, 'public'), { recursive: true });
  writeFileSync(path.join(alpha, 'public', 'logo.svg'), ALPHA_SVG);
  writeFileSync(path.join(alpha, 'package.json'), '{}');
  mkdirSync(beta, { recursive: true });
  writeFileSync(path.join(beta, 'favicon.svg'), BETA_SVG);
  writeFileSync(path.join(beta, 'package.json'), '{}');
  mkdirSync(gamma, { recursive: true });
  writeFileSync(path.join(gamma, 'package.json'), '{}');
  const fallbacks = [];
  for (const name of ['delta-notes', 'epsilon-api', 'zeta-cli', 'eta-docs']) {
    const dir = path.join(base, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), '{}');
    fallbacks.push(dir);
  }
  return { alpha, beta, gamma, fallbacks };
}

function pngSize(file) {
  const buf = readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
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
          window.electronAPI &&
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

async function injectProjects(cdp, projects) {
  const payload = JSON.stringify(projects);
  const raw = await cdp.eval(`(async () => {
    const spec = ${payload};
    const settings = window.__stores.settings;
    settings.setState({ onboarded: true, language: 'zh-CN' });
    const out = {};
    for (const key of ['alpha', 'beta', 'gamma']) {
      const project = await settings.getState().addProject(spec[key]);
      const info = await window.electronAPI.projects.getIcon(project.id);
      out[key] = { id: project.id, info };
    }
    out.extra = [];
    for (const dir of spec.fallbacks) {
      const project = await settings.getState().addProject(dir);
      out.extra.push({ id: project.id, name: project.name });
    }
    return JSON.stringify(out);
  })()`);
  return JSON.parse(raw);
}

const MEASURE = `(() => {
  const rows = [...document.querySelectorAll('[data-enso="project-row"]')];
  return rows.map((row) => {
    const icon = row.querySelector('[data-enso="project-icon"]');
    const name = row.querySelector('span[title]')?.textContent ?? '';
    if (!icon) return { name, kind: 'missing' };
    const style = getComputedStyle(icon);
    return {
      name,
      chevron: !!row.querySelector('[data-enso="tree-chevron"]'),
      kind: icon.dataset.kind,
      tag: icon.tagName.toLowerCase(),
      borderRadius: style.borderRadius,
      background: style.backgroundColor,
      src: icon.tagName === 'IMG' ? icon.getAttribute('src') : null,
      complete: icon.tagName === 'IMG' ? icon.complete && icon.naturalWidth > 0 : null,
      text: icon.textContent,
    };
  });
})()`;

async function shoot(cdp, file, width, height) {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  writeFileSync(file, Buffer.from(data, 'base64'));
  return pngSize(file);
}

function startDev(userData, cdpPort) {
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
      ENSO_VERIFY: '1',
      ELECTRON_EXEC_PATH: electron,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logPath = path.join(artDir, 'dev.log');
  const chunks = [];
  const collect = (buf) => {
    chunks.push(buf);
    if (chunks.length > 200) chunks.shift();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('exit', () => {
    try {
      writeFileSync(logPath, Buffer.concat(chunks));
    } catch {}
  });
  children.push(child);
  return child;
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

async function main() {
  if (!path.isAbsolute(PREFIX)) throw new Error('--out-prefix 必须是绝对路径');
  if (!existsSync(path.join(ROOT, 'package.json'))) throw new Error(`找不到仓库 ${ROOT}`);
  if (!existsSync(path.join(ROOT, 'node_modules/.bin/electron-vite'))) {
    throw new Error(`缺少 ${path.join(ROOT, 'node_modules/.bin/electron-vite')}`);
  }
  mkdirSync(path.dirname(PREFIX), { recursive: true });
  artDir = mkdtempSync('/tmp/enso-project-icons-');
  const userData = path.join(artDir, 'user-data');
  const demoBase = path.join(artDir, 'demo');
  mkdirSync(demoBase, { recursive: true });
  const projects = writeDemoProjects(demoBase);
  writeFakeSettings(userData);

  const cdpPort = await reserveCdpPort();
  log(`root ${ROOT}`);
  log(`userData ${userData}`);
  log(`cdp ${cdpPort}`);
  startDev(userData, cdpPort);

  await waitFor(
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
  );

  const cdp = await waitForStablePage(cdpPort);
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1100,
      height: 750,
      deviceScaleFactor: 2,
      mobile: false,
    });
    const ids = await injectProjects(cdp, projects);
    log(`alpha=${ids.alpha.info.kind} beta=${ids.beta.info.kind} gamma=${ids.gamma.info.kind}`);

    assert.equal(ids.alpha.info.kind, 'scanned', 'alpha 应扫描命中');
    assert.equal(ids.beta.info.kind, 'scanned', 'beta 应扫描命中');
    assert.equal(ids.gamma.info.kind, 'none', 'gamma 应无图标');
    assert.notEqual(ids.alpha.info.revision, 'none', 'alpha revision 应为哈希');
    assert.notEqual(ids.alpha.info.revision, ids.beta.info.revision, '两个项目图标哈希不同');

    await waitFor(
      async () => {
        const rows = await cdp.eval(MEASURE);
        const alpha = rows.find((row) => row.name?.includes('alpha-project'));
        const gamma = rows.find((row) => row.name?.includes('gamma-project'));
        return alpha && gamma && alpha.kind !== 'missing' ? rows : null;
      },
      { timeout: 15_000, label: '侧栏项目图标渲染' }
    );
    await sleep(600);

    const rows = await cdp.eval(MEASURE);
    console.table(rows);
    const alpha = rows.find((row) => row.name?.includes('alpha-project'));
    const beta = rows.find((row) => row.name?.includes('beta-project'));
    const gamma = rows.find((row) => row.name?.includes('gamma-project'));

    assert.equal(alpha?.tag, 'img', 'alpha 应渲染 img');
    assert.equal(alpha?.complete, true, 'alpha 图标应加载成功');
    assert.equal(alpha?.borderRadius, '0px', '扫描 logo 不裁圆角');
    assert.match(
      alpha?.src ?? '',
      /^local-image:\/\/project-icon\//,
      'alpha src 应是 project-icon 协议'
    );
    assert.equal(gamma?.tag, 'span', 'gamma 应渲染 fallback 色块');
    assert.notEqual(gamma?.borderRadius, '0px', 'fallback 裁圆角');
    assert.equal(gamma?.text, 'G', 'gamma fallback 首字母');
    assert.match(gamma?.background ?? '', /^rgb/, 'fallback 有背景色');
    assert.equal(beta?.tag, 'img', 'beta 应渲染 img');
    assert.equal(alpha?.chevron, false, 'alpha 有图标不应渲染 chevron');
    assert.equal(beta?.chevron, false, 'beta 有图标不应渲染 chevron');
    assert.equal(gamma?.chevron, true, 'gamma fallback 应保留 chevron');

    const file1 = `${PREFIX}sidebar.png`;
    await shoot(cdp, file1, 1100, 750);
    log(file1);

    const rowsAll = await cdp.eval(MEASURE);
    const fallbackColors = new Set(
      rowsAll.filter((row) => row.kind === 'fallback').map((row) => row.background)
    );
    log(`fallback 颜色数=${fallbackColors.size}: ${[...fallbackColors].join(' ')}`);
    assert.ok(fallbackColors.size >= 2, '多个无图标项目的 fallback 应呈现不同颜色');
    const fileColors = `${PREFIX}fallback-colors.png`;
    await shoot(cdp, fileColors, 1100, 750);
    log(fileColors);

    await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('[data-enso="project-row"]')];
      const row = rows.find((r) => r.textContent.includes('gamma-project'));
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    })()`);
    await sleep(400);
    const opened = await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('[role="menuitem"], [data-enso] button, [class*="menu"] [class*="item"]')];
      const target = items.find((el) => (el.textContent || '').includes('项目设置') || (el.textContent || '').includes('Project settings'));
      if (!target) return false;
      target.click();
      return true;
    })()`);
    if (opened) {
      await waitFor(
        () =>
          cdp.eval(
            `(() => Boolean([...document.querySelectorAll('*')].some((el) => el.textContent === '自定义图标' || el.textContent === 'Custom icon')))()`
          ),
        { timeout: 8_000, label: '设置弹窗自定义图标区块' }
      );
      await sleep(400);
      const fileDialog = `${PREFIX}settings-dialog.png`;
      await shoot(cdp, fileDialog, 1100, 750);
      log(fileDialog);
      await cdp.eval(
        `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`
      );
      await sleep(300);
    } else {
      log('WARN: 右键菜单未找到项目设置项，跳过弹窗截图');
    }

    const upload = await cdp.eval(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#2255cc';
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 32px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('U', 32, 43);
      const dataUrl = canvas.toDataURL('image/png');
      const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0));
      const result = await window.electronAPI.projects.setIcon(${JSON.stringify(ids.gamma.id)}, bytes);
      return JSON.stringify(result);
    })()`);
    const uploadResult = JSON.parse(upload);
    assert.equal(uploadResult.ok, true, `上传应成功: ${uploadResult.error ?? ''}`);
    assert.equal(uploadResult.info?.kind, 'custom', '上传后 kind 应为 custom');
    log(`gamma 上传后 revision=${uploadResult.info.revision}`);

    await cdp.send('Page.reload');
    await sleep(100);
    const cdp2 = await waitForStablePage(cdpPort);
    try {
      await cdp2.send('Emulation.setDeviceMetricsOverride', {
        width: 1100,
        height: 750,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await waitFor(
        async () => {
          const rows2 = await cdp2.eval(MEASURE);
          const gamma2 = rows2.find((row) => row.name?.includes('gamma-project'));
          return gamma2?.tag === 'img' && gamma2.complete ? rows2 : null;
        },
        { timeout: 15_000, label: '上传后 gamma 渲染自定义图标' }
      );
      await sleep(400);
      const rows2 = await cdp2.eval(MEASURE);
      console.table(rows2);
      const gamma2 = rows2.find((row) => row.name?.includes('gamma-project'));
      assert.equal(gamma2?.tag, 'img', '上传后 gamma 应渲染 img');
      assert.equal(gamma2?.borderRadius, '0px', '自定义图标不裁圆角');
      const file2 = `${PREFIX}custom.png`;
      await shoot(cdp2, file2, 1100, 750);
      log(file2);
    } finally {
      cdp2.close();
    }
    log('PASS');
  } finally {
    cdp.close();
  }
}

let finishing = null;
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

process.on('SIGINT', () => void finish(130));
process.on('SIGTERM', () => void finish(143));
process.on('uncaughtException', (error) => {
  console.error(error);
  void finish(1);
});

main()
  .then(() => finish(0))
  .catch((error) => {
    console.error(error);
    return finish(1);
  });
