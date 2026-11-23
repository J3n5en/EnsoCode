#!/usr/bin/env node
// 会话自定提醒真机验证：隔离 dev 实例（ENSO_VERIFY=1、临时 userData、假模型服务）。
// 1. 会话 A 用 remind_me 定 60s 提醒后结束本轮 → 到点被唤醒开新一轮；
// 2. 会话 B 定 40s 提醒后应用优雅退出 → 错过到点 → 同一 userData 重启 → 启动后补发一次；
// 3. 再重启一次 → 不再重复补发。
//   node scripts/verify-session-reminder.mjs [--keep]
// 退出码：全部通过 0，否则 1。不碰真实 userData，不抢焦点。

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uiElementElectron } from './verify-electron.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');
const OUT = mkdtempSync('/tmp/enso-session-reminder-');
const ENV = path.join(OUT, 'user-data');
const PROJ = path.join(OUT, 'project');
const REMINDERS = path.join(ENV, 'agent', 'sessions', 'reminders.json');
const START = Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clock = () => new Date().toISOString().slice(11, 19);
const stamp = () => `+${((Date.now() - START) / 1000).toFixed(1)}s ${clock()}`;
const timeline = [];
const note = (line) => {
  timeline.push(`${stamp()} ${line}`);
  console.log(`${stamp()} ${line}`);
};
const results = [];
const check = (ok, label, detail) => {
  results.push({ ok: Boolean(ok), label });
  const line = `${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? ` —— ${JSON.stringify(detail)}` : ''}`;
  timeline.push(`${stamp()} ${line}`);
  console.log(line);
};

async function waitFor(fn, label, timeout = 60_000, interval = 300) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await sleep(interval);
  }
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

// ---------- 假模型服务 ----------
const requests = [];
const textOf = (message) =>
  typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? [])
        .map((part) =>
          part?.type === 'text'
            ? part.text
            : part?.type === 'tool_result'
              ? JSON.stringify(part.content)
              : ''
        )
        .join('\n');
const isToolResult = (message) =>
  Array.isArray(message?.content) && message.content.some((c) => c?.type === 'tool_result');

function sse(res, blocks, stop) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const events = [
    {
      type: 'message_start',
      message: {
        id: `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: 'fake-model-1',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  ];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      });
    } else {
      events.push({
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: `toolu_${Date.now()}_${index}`,
          name: block.name,
          input: {},
        },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 5 } });
  events.push({ type: 'message_stop' });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

const SCENARIOS = {
  'REMIND-ONE': { who: 'A', in: '60s', ping: 'PING-ONE', label: 'ci-one' },
  'REMIND-TWO': { who: 'B', in: '40s', ping: 'PING-TWO', label: 'ci-two' },
};

function script(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const first = textOf(messages[0]);
  const last = messages.at(-1);
  const lastText = textOf(last);
  const tools = (body?.tools ?? []).map((tool) => tool.name);
  const key = Object.keys(SCENARIOS).find((name) => first.includes(name));
  if (!key)
    return {
      who: 'aux',
      action: 'text ok',
      blocks: [{ type: 'text', text: 'ok' }],
      stop: 'end_turn',
    };
  const scenario = SCENARIOS[key];
  if (!isToolResult(last) && lastText.includes(scenario.ping))
    return {
      who: scenario.who,
      action: 'woke',
      blocks: [{ type: 'text', text: `WOKE-${scenario.who}` }],
      stop: 'end_turn',
    };
  if (isToolResult(last))
    return {
      who: scenario.who,
      action: 'set',
      blocks: [{ type: 'text', text: `SET-${scenario.who}` }],
      stop: 'end_turn',
    };
  return {
    who: scenario.who,
    action: `tool remind_me (tools has remind_me: ${tools.includes('remind_me')})`,
    blocks: [
      {
        type: 'tool_use',
        name: 'remind_me',
        input: { in: scenario.in, prompt: `${scenario.ping}: check CI now`, label: scenario.label },
      },
    ],
    stop: 'tool_use',
  };
}

async function startProvider() {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if ((req.url ?? '').includes('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'fake-model-1' }] }));
        return;
      }
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {}
      const reply = script(body);
      const lastText = textOf(body?.messages?.at(-1)).replace(/\s+/g, ' ').slice(0, 600);
      requests.push({ at: Date.now(), ...reply, lastText });
      if (reply.who !== 'aux')
        note(`model ← ${reply.who}: ${reply.action}  (last: ${lastText.slice(0, 160)})`);
      sse(res, reply.blocks, reply.stop);
    });
  });
  const port = await freePort();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, port };
}

// ---------- 隔离实例 ----------
async function cdpPage(cdpPort, rendererPort) {
  const target = await waitFor(
    async () => {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      return list.find(
        (t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${rendererPort}/`)
      );
    },
    'renderer page',
    120_000
  );
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const next = ++id;
      pending.set(next, resolve);
      ws.send(JSON.stringify({ id: next, method, params }));
    });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (reply.result?.exceptionDetails)
      throw new Error(reply.result.exceptionDetails.exception?.description ?? 'eval failed');
    return reply.result?.result?.value;
  };
  await waitFor(
    () =>
      evaluate(
        'Boolean(window.__stores?.sessions?.getState && window.__stores?.settings?.getState)'
      ),
    'renderer stores'
  );
  return { evaluate, close: () => ws.close() };
}

async function launch(name) {
  const cdpPort = await freePort();
  const rendererPort = await freePort();
  const electron = uiElementElectron(createRequire(path.join(ROOT, 'package.json'))('electron'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(ENSO_|ELECTRON_)/.test(key))
  );
  const log = openSync(path.join(OUT, `${name}.log`), 'a');
  const child = spawn('pnpm', ['dev'], {
    cwd: ROOT,
    env: {
      ...env,
      ENSO_USER_DATA_DIR: ENV,
      ENSO_CDP_PORT: String(cdpPort),
      ENSO_RENDERER_PORT: String(rendererPort),
      ENSO_VERIFY: '1',
      ELECTRON_EXEC_PATH: electron,
    },
    detached: true,
    stdio: ['ignore', log, log],
  });
  note(`launch ${name} (pnpm dev pid=${child.pid})`);
  const page = await cdpPage(cdpPort, rendererPort);
  const main = electronMain(child.pid);
  note(`${name} renderer ready (electron main pid=${main})`);
  return { child, main, page };
}

function electronMain(rootPid) {
  const rows = spawnSync('ps', ['-ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .stdout.split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
  const mine = new Set([rootPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows)
      if (mine.has(row.ppid) && !mine.has(row.pid)) {
        mine.add(row.pid);
        grew = true;
      }
  }
  return rows.find(
    (row) => mine.has(row.pid) && /Electron/.test(row.command) && !/--type=/.test(row.command)
  )?.pid;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function quit(instance, timeout = 90_000) {
  instance.page.close();
  process.kill(instance.main, 'SIGTERM');
  await waitFor(() => !alive(instance.main), 'electron exit', timeout, 200);
  try {
    process.kill(-instance.child.pid, 'SIGTERM');
  } catch {}
}

const reminders = () =>
  existsSync(REMINDERS) ? (JSON.parse(readFileSync(REMINDERS, 'utf8')).reminders ?? []) : [];
const of = (who, action) => requests.filter((r) => r.who === who && r.action.startsWith(action));
const logLines = (name, pattern) =>
  existsSync(path.join(OUT, `${name}.log`))
    ? readFileSync(path.join(OUT, `${name}.log`), 'utf8')
        .split('\n')
        .filter((line) => pattern.test(line))
    : [];

async function startConversation(page, text) {
  return page.evaluate(`(async () => {
    const S = () => window.__stores.sessions.getState();
    const SET = () => window.__stores.settings.getState();
    const project = SET().projects?.find((p) => p.path === ${JSON.stringify(PROJ)}) ?? (await SET().addProject(${JSON.stringify(PROJ)}));
    const id = await S().newConversation(project.id);
    S().selectConversation(id);
    S().setApprovalMode(id, 'full');
    const error = await S().send(${JSON.stringify(text)}, { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path }, undefined, id);
    return error ? 'error: ' + error : id;
  })()`);
}

async function main() {
  mkdirSync(ENV, { recursive: true });
  mkdirSync(PROJ, { recursive: true });
  writeFileSync(path.join(PROJ, 'README.md'), 'isolated project\n');
  const provider = await startProvider();
  writeFileSync(
    path.join(ENV, 'settings.json'),
    JSON.stringify({
      'enso-settings': {
        state: {
          providers: [
            {
              id: 'pv-A',
              name: 'Provider A',
              api: 'anthropic-messages',
              apiKey: 'sk-fake-A',
              baseUrl: `http://127.0.0.1:${provider.port}`,
              enabled: true,
              models: [{ id: 'fake-model-1' }],
            },
          ],
          defaultModel: { providerId: 'pv-A', modelId: 'fake-model-1' },
          onboarded: true,
          theme: 'light',
          language: 'en',
        },
        version: 2,
      },
    })
  );
  console.log(`out: ${OUT}`);

  // 1. 会话 A：定 60s 提醒，结束本轮，到点被唤醒
  const run1 = await launch('run1');
  const a = await startConversation(run1.page, 'REMIND-ONE');
  check(a && !String(a).startsWith('error'), '会话 A 建好并发出消息', a);
  await waitFor(() => of('A', 'set').length > 0, '会话 A 定好提醒并结束本轮');
  const setA = of('A', 'set')[0].at;
  const savedA = reminders().find((r) => r.label === 'ci-one');
  note(`reminders.json A: ${JSON.stringify(savedA)}`);
  check(savedA && savedA.dueAt - setA > 55_000, '提醒落盘，到点时间约在 60s 后', savedA);
  const wokeA = await waitFor(() => of('A', 'woke')[0], '会话 A 被提醒唤醒', 120_000, 500);
  const delayA = (wokeA.at - setA) / 1000;
  note(`A woke ${delayA.toFixed(1)}s after setting the reminder`);
  check(delayA >= 58 && delayA <= 75, `会话 A 在约 60s 后被唤醒（实际 ${delayA.toFixed(1)}s）`);
  check(
    /remind_me/.test(wokeA.lastText) && wokeA.lastText.includes('PING-ONE'),
    '注入文本标明是自己定的提醒并带原 prompt',
    wokeA.lastText
  );
  check(!reminders().some((r) => r.label === 'ci-one'), '触发后提醒从存储删除');

  // 2. 会话 B：定 40s 提醒后立刻优雅退出，错过到点
  const b = await startConversation(run1.page, 'REMIND-TWO');
  check(b && !String(b).startsWith('error'), '会话 B 建好并发出消息', b);
  await waitFor(() => of('B', 'set').length > 0, '会话 B 定好提醒并结束本轮');
  const savedB = reminders().find((r) => r.label === 'ci-two');
  note(`reminders.json B: ${JSON.stringify(savedB)}`);
  check(savedB, '会话 B 的提醒已落盘', reminders());
  note('SIGTERM run1 (graceful quit before B is due)');
  await quit(run1);
  note('run1 exited');
  const wait = Math.max(0, savedB.dueAt - Date.now() + 5_000);
  note(`app is down; waiting ${(wait / 1000).toFixed(0)}s so B's reminder is missed`);
  await sleep(wait);
  check(
    Date.now() > savedB.dueAt && of('B', 'woke').length === 0,
    '应用关闭期间错过到点，没有唤醒'
  );

  // 3. 重启：启动后补发一次
  const run2 = await launch('run2');
  const wokeB = await waitFor(() => of('B', 'woke')[0], '重启后会话 B 被补发唤醒', 120_000, 500);
  note(
    `B woke ${((wokeB.at - savedB.dueAt) / 1000).toFixed(1)}s after its due time (missed during downtime)`
  );
  check(wokeB.lastText.includes('PING-TWO'), '补发注入的是 B 的提醒内容', wokeB.lastText);
  await sleep(15_000);
  check(of('B', 'woke').length === 1, '重启后只补发一次', of('B', 'woke').length);
  check(!reminders().some((r) => r.label === 'ci-two'), '补发后提醒从存储删除', reminders());
  for (const line of logLines('run2', /reminder/i)) note(`run2 log: ${line.trim()}`);
  await quit(run2, 30_000);
  note('run2 exited');

  // 4. 再起一代：不再重复补发
  const run3 = await launch('run3');
  await sleep(20_000);
  check(of('B', 'woke').length === 1 && of('A', 'woke').length === 1, '再次重启不重复唤醒', {
    A: of('A', 'woke').length,
    B: of('B', 'woke').length,
  });
  await quit(run3, 30_000);
  note('run3 exited');
  provider.server.close();

  const failed = results.filter((r) => !r.ok);
  writeFileSync(path.join(OUT, 'timeline.txt'), timeline.join('\n'));
  console.log(`\n${results.length - failed.length}/${results.length} passed → ${OUT}/timeline.txt`);
  if (!KEEP && failed.length === 0) rmSync(OUT, { recursive: true, force: true });
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    console.error(`out: ${OUT}`);
    process.exit(2);
  });
