#!/usr/bin/env node
// 设置页滚动基准：隔离实例（ENSO_VERIFY=1、临时 userData、生产构建 out/）+ 18 个服务商、两千多个模型、
// 37 个模型选择器的假数据，经 CDP 滚轮滚动各设置分区。每个分区量两段：
//   open   点进分区后立刻滚（用户的真实动作）：滚轮回执、主进程 IPC 往返、画面停滞，
//          以及滚完之后主进程还要多久才空闲（mainBusyAfterMs）
//   steady 等主进程空闲后再滚：帧间隔、长任务、滚动期间的 React 提交
// 用法：pnpm build && node scripts/bench-settings-scroll.mjs [--rounds 3] [--categories providers,tools]
//   [--json out.json] [--trace-dir dir] [--streaming N（工作区先开 N 个持续流式的会话）] [--hold]
// 断言：steady 段滚动不触发 React 提交；open 段滚完后主进程 2s 内空闲。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uiElementElectron } from './verify-electron.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const ROUNDS = Number(option('--rounds', 3));
const CATEGORIES = option('--categories', 'providers,tools,general').split(',');
const WHEEL_STEPS = Number(option('--steps', 120));
const STREAMING = Number(option('--streaming', 0));
const TRACE_DIR = option('--trace-dir');
const FRAME_MS = 1000 / 60;
const MAIN_BUSY_LIMIT_MS = 2000;
const LABELS = {
  providers: 'Model Providers',
  general: 'General',
  appearance: 'Appearance',
  tools: 'Built-in tools',
  conversation: 'Conversation display',
};

const VENDORS = [
  ['OpenRouter', 'https://openrouter.ai/api/v1', 420],
  ['Devin', 'https://api.devin.example/v1', 300],
  ['Cursor', 'https://api.cursor.example/v1', 260],
  ['OpenAI', 'https://api.openai.com/v1', 120],
  ['Anthropic', 'https://api.anthropic.com', 40],
  ['DeepSeek', 'https://api.deepseek.com/v1', 12],
  ['Moonshot', 'https://api.moonshot.cn/v1', 30],
  ['Zhipu', 'https://open.bigmodel.cn/api/paas/v4', 40],
  ['SiliconFlow', 'https://api.siliconflow.cn/v1', 180],
  ['Groq', 'https://api.groq.com/openai/v1', 30],
  ['xAI', 'https://api.x.ai/v1', 20],
  ['Together', 'https://api.together.xyz/v1', 150],
  ['Fireworks', 'https://api.fireworks.ai/inference/v1', 90],
  ['Mistral', 'https://api.mistral.ai/v1', 45],
  ['Ollama', 'http://127.0.0.1:1/v1', 25],
  ['Relay A', 'https://relay-a.example/v1', 200],
  ['Relay B', 'https://relay-b.example/v1', 200],
  ['Relay C', 'https://relay-c.example/v1', 80],
];

function fakeSettings(streamPort) {
  const providers = VENDORS.map(([name, baseUrl, count], index) => ({
    id: `bench-${index}`,
    name,
    api: name === 'Anthropic' ? 'anthropic-messages' : 'openai-completions',
    apiKey: `sk-bench-${index}`,
    baseUrl,
    enabled: true,
    models: Array.from({ length: count }, (_, i) => ({
      id: `${name.toLowerCase().replace(/\s+/g, '-')}/model-${String(i).padStart(3, '0')}-${i % 3 ? 'chat' : 'reasoning-preview'}`,
    })),
  }));
  const ref = (p, m) => ({ providerId: providers[p].id, modelId: providers[p].models[m].id });
  const version = Number(
    /export const SETTINGS_VERSION = (\d+)/.exec(
      readFileSync(path.join(ROOT, 'src/renderer/stores/settings/migrate.ts'), 'utf8')
    )?.[1]
  );
  const stream = {
    id: 'bench-stream',
    name: 'Stream',
    api: 'anthropic-messages',
    apiKey: 'sk-bench-stream',
    baseUrl: `http://127.0.0.1:${streamPort}`,
    enabled: true,
    models: [{ id: 'stream-model' }],
  };
  const state = {
    providers: streamPort ? [stream, ...providers] : providers,
    defaultModel: streamPort ? { providerId: stream.id, modelId: 'stream-model' } : ref(0, 1),
    titleSummaryEnabled: true,
    titleSummaryModel: ref(5, 0),
    gitCommitModel: ref(3, 2),
    approvalReviewer: ref(4, 1),
    subagentModelsEnabled: true,
    subagentModels: Array.from({ length: 10 }, (_, i) => ({
      id: `sub-${i}`,
      ...ref(i, i),
      description: `Subagent model ${i}`,
    })),
    virtualModels: Array.from({ length: 6 }, (_, i) => ({
      id: `virtual-${i}`,
      name: `Auto ${i}`,
      enabled: true,
      primary: ref(i, 0),
      fast: ref(i + 1, 1),
      fallbacks: [ref(i + 2, 2), ref(i + 3, 3)],
    })),
    onboarded: true,
    theme: 'light',
    language: 'en',
  };
  return { 'enso-settings': { state, version } };
}

/** anthropic-messages 兼容的假 provider：每 33ms 吐一段文字，直到客户端断开 */
function startFakeProvider() {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      send({
        type: 'message_start',
        message: {
          id: `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          model: 'stream-model',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      });
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      let n = 0;
      const timer = setInterval(() => {
        n++;
        const text = n % 40 === 0 ? '\n\n' : `word${n} `;
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      }, 33);
      res.on('close', () => clearInterval(timer));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function listener(port) {
  return spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
  }).stdout.trim();
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(JSON.stringify(data.error)));
      else resolve(data.result);
    } else for (const fn of listeners) fn(data);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () =>
      resolve({
        send,
        evaluate,
        on: (fn) => listeners.add(fn),
        off: (fn) => listeners.delete(fn),
        close: () => ws.close(),
      });
    ws.onerror = reject;
  });
}

// 生产构建没有 DevTools：装一个最小 hook，只数 commit
const COMMIT_HOOK = `(() => {
  window.__benchCommits = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(),
    inject(renderer) { this.renderers.set(1, renderer); return 1; },
    onCommitFiberRoot() { window.__benchCommits++; },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {},
  };
})()`;

// 主进程（浏览器 UI 线程）被同步任务占住时，系统滚轮/触控板事件也排在后面：用一个几乎不做事的 IPC 量往返
const PAGE_HELPERS = `(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ping = async () => {
    const start = performance.now();
    await window.electronAPI.providers.modelMeta({ modelIds: [] });
    return performance.now() - start;
  };
  const nav = async (label) => {
    if (!document.querySelector('[data-enso=settings-nav]')) document.querySelector('[data-enso=settings-button]').click();
    for (let i = 0; i < 50 && !document.querySelector('[data-enso=settings-nav]'); i++) await sleep(100);
    const button = [...document.querySelectorAll('[data-enso=settings-nav] button')].find((b) => b.textContent.trim() === label);
    if (!button) throw new Error('no nav button ' + label);
    button.click();
  };
  const quiet = async () => {
    const since = performance.now();
    let calm = 0;
    while (calm < 3) { calm = (await ping()) < 50 ? calm + 1 : 0; await sleep(100); }
    return Math.round(performance.now() - since);
  };
  const start = () => {
    const el = document.querySelector('[data-enso=settings-scroll]');
    const s = window.__bench = { frames: [], tops: [], pings: [], commits0: window.__benchCommits, running: true };
    const tick = (t) => { s.frames.push(t); s.tops.push(el.scrollTop); if (s.running) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    (async () => { while (s.running) { s.pings.push(await ping()); await sleep(100); } })();
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, scrollHeight: el.scrollHeight, nodes: el.querySelectorAll('*').length };
  };
  const stop = () => {
    const s = window.__bench; s.running = false;
    const el = document.querySelector('[data-enso=settings-scroll]');
    // 滚轮持续输入、又没顶到两端时 scrollTop 停住多久
    const max = el.scrollHeight - el.clientHeight;
    let stall = 0, since = null;
    for (let i = 1; i < s.tops.length; i++) {
      const still = s.tops[i] === s.tops[i - 1] && s.tops[i] > 0 && s.tops[i] < max;
      if (still) { since ??= s.frames[i - 1]; stall = Math.max(stall, s.frames[i] - since); } else since = null;
    }
    return { frames: s.frames, pings: s.pings, commits: window.__benchCommits - s.commits0, stallMs: Math.round(stall) };
  };
  window.__benchPage = { nav, quiet, start, stop };
})()`;

/** 建项目后在工作区里开 count 个会话，每个都发一句让假 provider 一直流 */
async function startStreamingSessions(cdp, projectDir, count) {
  const created = await cdp.evaluate(`window.electronAPI.sourceAuthority.createProject({
    requestId: crypto.randomUUID(), path: ${JSON.stringify(projectDir)} })`);
  assert.ok(created?.accepted, `建项目失败 ${JSON.stringify(created)}`);
  for (let i = 0; i < count; i++) {
    await waitFor(
      () =>
        cdp.evaluate(`(async () => {
          const row = document.querySelector('[data-enso=project-row]');
          if (!row) return false;
          if (${i} === 0) row.click();
          await new Promise((r) => setTimeout(r, 500));
          document.querySelector('[data-enso=new-session]').click();
          return true;
        })()`),
      20_000,
      'project row'
    );
    await waitFor(
      () =>
        cdp.evaluate(`(() => {
          const editor = document.querySelector('[data-enso="composer"] [contenteditable="true"]');
          editor?.focus();
          return !!editor && document.activeElement === editor;
        })()`),
      20_000,
      'composer'
    );
    await cdp.send('Input.insertText', { text: `stream ${i}` });
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        ...(type === 'keyDown' ? { text: '\r' } : {}),
      });
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};
const round = (n) => Math.round(n * 10) / 10;

function frameStats(timestamps) {
  const intervals = timestamps.slice(1).map((t, i) => t - timestamps[i]);
  const expected = Math.round((timestamps.at(-1) - timestamps[0]) / FRAME_MS);
  return {
    meanFrameMs: round(intervals.reduce((a, b) => a + b, 0) / intervals.length),
    p95FrameMs: round(percentile(intervals, 0.95)),
    droppedPct: round(Math.max(0, 1 - intervals.length / expected) * 100),
  };
}

/** 渲染进程主线程：顶层任务总时长与超过 50ms 的长任务 */
function rendererMain(events) {
  const started = events.find((e) => e.name === 'TracingStartedInBrowser');
  const pid = started?.args?.data?.frames?.find((f) => /index\.html/.test(f.url ?? ''))?.processId;
  const tid = events.find(
    (e) => e.pid === pid && e.name === 'thread_name' && e.args?.name === 'CrRendererMain'
  )?.tid;
  const tasks = events
    .filter((e) => e.pid === pid && e.tid === tid && e.ph === 'X' && e.name === 'RunTask')
    .map((e) => e.dur / 1000);
  return {
    rendererBusyMs: Math.round(tasks.reduce((a, b) => a + b, 0)),
    longTasks: tasks.filter((d) => d > 50).length,
    maxTaskMs: round(Math.max(0, ...tasks)),
  };
}

async function traced(cdp, file, body) {
  const events = [];
  const collect = (data) => {
    if (data.method === 'Tracing.dataCollected') events.push(...data.params.value);
  };
  cdp.on(collect);
  const done = new Promise((resolve) => {
    const end = (data) => {
      if (data.method !== 'Tracing.tracingComplete') return;
      cdp.off(end);
      resolve();
    };
    cdp.on(end);
  });
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline',
    transferMode: 'ReportEvents',
  });
  const result = await body();
  await cdp.send('Tracing.end');
  await done;
  cdp.off(collect);
  if (file) writeFileSync(file, JSON.stringify(events));
  return { ...result, ...rendererMain(events) };
}

/** 往下滚再往回滚，模拟连续拨滚轮（每帧一格）；回执要等浏览器主进程把事件交给渲染进程 */
async function wheel(cdp, target) {
  const acks = [];
  for (let i = 0; i < WHEEL_STEPS; i++) {
    const sent = performance.now();
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: target.x,
      y: target.y,
      deltaX: 0,
      deltaY: i < WHEEL_STEPS / 2 ? 120 : -120,
    });
    acks.push(performance.now() - sent);
    await new Promise((r) => setTimeout(r, FRAME_MS));
  }
  await new Promise((r) => setTimeout(r, 300));
  return acks;
}

function summarize(sampled, acks) {
  return {
    ...frameStats(sampled.frames),
    stallMs: sampled.stallMs,
    wheelAckP95Ms: round(percentile(acks, 0.95)),
    wheelAckMaxMs: round(Math.max(...acks)),
    ipcP95Ms: round(percentile(sampled.pings, 0.95)),
    ipcMaxMs: round(Math.max(0, ...sampled.pings)),
    commits: sampled.commits,
  };
}

async function measure(cdp, category, round) {
  const label = LABELS[category] ?? category;
  const traceFile = (phase) =>
    TRACE_DIR && path.join(TRACE_DIR, `${category}-${round}-${phase}.json`);
  // 先停在别的分区、等主进程空闲，保证每轮都是一次全新的「点进来」
  const elsewhere = category === 'general' ? LABELS.appearance : LABELS.general;
  await cdp.evaluate(`window.__benchPage.nav(${JSON.stringify(elsewhere)})`);
  await cdp.evaluate('window.__benchPage.quiet()');
  await new Promise((r) => setTimeout(r, 500));
  let page;
  const open = await traced(cdp, traceFile('open'), async () => {
    page = await cdp.evaluate(`(async () => {
      await window.__benchPage.nav(${JSON.stringify(label)});
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      document.querySelector('[data-enso=settings-scroll]').scrollTop = 0;
      return window.__benchPage.start();
    })()`);
    const acks = await wheel(cdp, page);
    return summarize(await cdp.evaluate('window.__benchPage.stop()'), acks);
  });
  const mainBusyAfterMs = await cdp.evaluate('window.__benchPage.quiet()');
  await cdp.evaluate(`document.querySelector('[data-enso=settings-scroll]').scrollTop = 0`);
  await new Promise((r) => setTimeout(r, 300));
  const steady = await traced(cdp, traceFile('steady'), async () => {
    const target = await cdp.evaluate('window.__benchPage.start()');
    const acks = await wheel(cdp, target);
    return summarize(await cdp.evaluate('window.__benchPage.stop()'), acks);
  });
  return { nodes: page.nodes, scrollHeight: page.scrollHeight, mainBusyAfterMs, open, steady };
}

function summarizeRuns(results) {
  const median = (runs, pick) => percentile(runs.map(pick), 0.5);
  return Object.fromEntries(
    Object.entries(results).map(([category, runs]) => {
      const phase = (name) =>
        Object.fromEntries(
          Object.keys(runs[0][name]).map((key) => [
            key,
            key === 'commits'
              ? Math.max(...runs.map((r) => r[name][key]))
              : median(runs, (r) => r[name][key]),
          ])
        );
      return [
        category,
        {
          runs: runs.length,
          nodes: runs[0].nodes,
          mainBusyAfterMs: median(runs, (r) => r.mainBusyAfterMs),
          open: phase('open'),
          steady: phase('steady'),
        },
      ];
    })
  );
}

async function main() {
  assert.ok(
    existsSync(path.join(ROOT, 'out/renderer/index.html')),
    '先 pnpm build（基准跑生产构建）'
  );
  if (TRACE_DIR) mkdirSync(TRACE_DIR, { recursive: true });
  const userData = mkdtempSync(path.join(os.tmpdir(), 'enso-bench-scroll-'));
  const streamServer = STREAMING > 0 ? await startFakeProvider() : null;
  let streamed = 0;
  streamServer?.on('request', (req) => {
    if (req.method === 'POST') streamed++;
  });
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify(fakeSettings(streamServer?.address().port))
  );
  const port = Number(option('--port', 9400 + Math.floor(Math.random() * 400)));
  assert.equal(listener(port), '', `端口 ${port} 已被占用`);
  const electron = uiElementElectron(createRequire(import.meta.url)('electron'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(ENSO_|ELECTRON_)/.test(key))
  );
  const inspectMain = option('--inspect-main');
  const child = spawn(electron, [...(inspectMain ? [`--inspect=${inspectMain}`] : []), ROOT], {
    env: { ...env, ENSO_VERIFY: '1', ENSO_USER_DATA_DIR: userData, ENSO_CDP_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-4000);
  });
  let cdp;
  try {
    const pageUrl = await waitFor(
      async () => {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        return list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
          ?.webSocketDebuggerUrl;
      },
      30_000,
      'main window'
    );
    assert.equal(listener(port), String(child.pid), 'CDP 端口不属于本次拉起的隔离实例');
    cdp = await connect(pageUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: COMMIT_HOOK });
    await cdp.send('Page.reload');
    await waitFor(
      () => cdp.evaluate(`!!document.querySelector('[data-enso=settings-button]')`),
      30_000,
      'workspace ready'
    );
    // models.dev 目录落盘后模型元数据查询才是用户机器上的真实开销
    await waitFor(
      () => existsSync(path.join(userData, 'models-dev-cache.json')),
      60_000,
      'models.dev 目录缓存'
    );
    await new Promise((r) => setTimeout(r, 2000));
    if (STREAMING > 0) {
      const projectDir = path.join(userData, 'project');
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(path.join(projectDir, 'README.md'), 'bench project\n');
      await startStreamingSessions(cdp, projectDir, STREAMING);
      await waitFor(() => streamed >= STREAMING, 30_000, `${STREAMING} 个会话开始流式`);
    }
    await cdp.evaluate(PAGE_HELPERS);
    if (flag('--hold')) {
      // 排查用：实例留着给 cdp.mjs 手动连（ENSO_CDP_PORT=<port>），收到 SIGTERM/SIGINT 再清理
      console.error(`holding: ENSO_CDP_PORT=${port} userData=${userData}`);
      await new Promise((resolve) => {
        process.once('SIGTERM', resolve);
        process.once('SIGINT', resolve);
      });
      return;
    }
    const results = {};
    for (let round = 0; round < ROUNDS; round++) {
      for (const category of CATEGORIES) {
        const run = await measure(cdp, category, round);
        results[category] = [...(results[category] ?? []), run];
        console.error(`[${round}] ${category} ${JSON.stringify(run)}`);
      }
    }
    const json = option('--json');
    if (json) writeFileSync(json, JSON.stringify(results, null, 2));
    const summary = summarizeRuns(results);
    console.log(JSON.stringify(summary, null, 2));
    for (const [category, row] of Object.entries(summary)) {
      // 每格滚轮都重渲染会是上百次提交；偶发的一两次来自与滚动无关的定时更新
      assert.ok(
        row.steady.commits <= 2,
        `${category}: 滚动期间 ${row.steady.commits} 次 React 提交`
      );
      assert.ok(
        row.mainBusyAfterMs < MAIN_BUSY_LIMIT_MS,
        `${category}: 滚完后主进程又忙了 ${row.mainBusyAfterMs}ms`
      );
    }
  } catch (error) {
    console.error(stderr);
    throw error;
  } finally {
    cdp?.close();
    process.kill(-child.pid, 'SIGTERM');
    const timer = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
    streamServer?.closeAllConnections();
    streamServer?.close();
    if (!flag('--keep')) rmSync(userData, { recursive: true, force: true });
  }
}

await main();
