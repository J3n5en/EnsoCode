#!/usr/bin/env node
// 子代理跨重启续跑真机验证：隔离 dev 实例（ENSO_VERIFY=1、临时 userData、假模型服务），
// 父会话派出 task 子代理 → 子代理执行 bash 途中应用优雅退出 → 同一 userData 重新启动 →
// 子代理接着断点续跑（不重跑已执行的 bash）→ 父会话收到完成通知。
// --stalled-reply：父会话空闲、子代理回复写到一半卡住时退出 → 等满回复保底后 worker 收尾中止 →
// Run 记成被打断并带续跑记录（不是 succeeded）→ 重启后子代理自动续跑、父会话收到完成通知。
// --parent-wait：父会话在 subagent(wait) 阻塞等待子代理期间 → 验证侧栏子代理标记 → 插话(steer)
// 提前打断 wait 并立即响应且不中断子代理 → 再次 wait 途中优雅重启 → 重启后子代理续跑并通知父会话。
// 默认经关窗确认退出；加 --sigterm 改为 SIGTERM（不经确认，到 will-quit 才等安全点，同托盘退出）。
//   node scripts/verify-subagent-restart.mjs [--keep] [--stalled-reply [--sigterm]] [--parent-wait]
// 退出码：全部通过 0，否则 1。不碰真实 userData，不抢焦点（窗口不显示、不进 Dock）。

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
const STALLED = process.argv.includes('--stalled-reply');
const PARENT_WAIT = process.argv.includes('--parent-wait');
const SIGTERM_QUIT = process.argv.includes('--sigterm');
const OUT = mkdtempSync('/tmp/enso-subagent-restart-');
const ENV = path.join(OUT, 'user-data');
const PROJ = path.join(OUT, 'project');
const MARKER = path.join(OUT, 'marker.txt');
const START = Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => `+${((Date.now() - START) / 1000).toFixed(1)}s`;
const timeline = [];
const note = (line) => {
  timeline.push(`${stamp()} ${line}`);
  console.log(`${stamp()} ${line}`);
};
const results = [];
const check = (ok, label, detail) => {
  results.push({ ok: Boolean(ok), label });
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? ` —— ${JSON.stringify(detail)}` : ''}`
  );
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

// ---------- 假模型服务：按会话角色出剧本 ----------
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
const hasToolResult = (messages) =>
  messages.some(
    (m) => Array.isArray(m.content) && m.content.some((c) => c?.type === 'tool_result')
  );

const messageStart = () => ({
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
});
const writeEvents = (res, events) => {
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
};

function sse(res, blocks, stop) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const events = [messageStart()];
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
  writeEvents(res, events);
  res.end();
}

/** 回复写到一半卡住：出一点 text delta 后不再出 token，也不结束连接 */
const stalled = new Set();
let stallChild = STALLED;
function stall(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  writeEvents(res, [
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'CHILD-PARTIAL ' },
    },
  ]);
  stalled.add(res);
  res.on('close', () => {
    stalled.delete(res);
    note('stalled child reply: connection closed by client');
  });
}

function extractRunId(text) {
  const match = text.match(/\\?"runId\\?"\s*:\s*\\?"([^"\\]+)\\?"/);
  return match ? match[1] : null;
}

function script(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const first = textOf(messages[0]);
  const all = messages.map(textOf).join('\n');
  const tools = (body?.tools ?? []).map((tool) => tool.name);
  if (first.includes('CHILD-TASK')) {
    if (stallChild) return { who: 'child', action: 'stall', stall: true };
    if (!STALLED && !hasToolResult(messages)) {
      const bash = tools.find((name) => name === 'bash') ?? 'bash';
      const waitSec = PARENT_WAIT ? 12 : 6;
      return {
        who: 'child',
        action: `tool ${bash}`,
        blocks: [
          {
            type: 'tool_use',
            name: bash,
            input: { command: `sleep ${waitSec}; echo step1 >> ${MARKER}` },
          },
        ],
        stop: 'tool_use',
      };
    }
    return {
      who: 'child',
      action: 'final CHILD-DONE',
      blocks: [{ type: 'text', text: 'CHILD-DONE' }],
      stop: 'end_turn',
    };
  }
  if (first.includes('PARENT-GO')) {
    if (all.includes('CHILD-DONE'))
      return {
        who: 'parent',
        action: 'final PARENT-GOT-IT',
        blocks: [{ type: 'text', text: 'PARENT-GOT-IT' }],
        stop: 'end_turn',
      };
    if (!hasToolResult(messages))
      return {
        who: 'parent',
        action: 'tool subagent spawn',
        blocks: [
          {
            type: 'tool_use',
            name: 'subagent',
            input: {
              operation: 'spawn',
              mode: 'task',
              description: 'restart probe',
              prompt: 'CHILD-TASK: run the step, then report CHILD-DONE',
            },
          },
        ],
        stop: 'tool_use',
      };
    if (PARENT_WAIT) {
      const runId = extractRunId(all);
      if (all.includes('Paused waiting because EnsoCode is restarting')) {
        return {
          who: 'parent',
          action: 'text PARENT-WAITING-AFTER-RESTART',
          blocks: [{ type: 'text', text: 'PARENT-WAITING-AFTER-RESTART' }],
          stop: 'end_turn',
        };
      }
      if (all.includes('STEER-PING') && runId) {
        return {
          who: 'parent',
          action: 'steer ack + wait #2',
          blocks: [
            { type: 'text', text: 'STEER-ACK' },
            {
              type: 'tool_use',
              name: 'subagent',
              input: { operation: 'wait', runId, timeoutMs: 120_000 },
            },
          ],
          stop: 'tool_use',
        };
      }
      if (runId) {
        return {
          who: 'parent',
          action: 'tool subagent wait #1',
          blocks: [
            {
              type: 'tool_use',
              name: 'subagent',
              input: { operation: 'wait', runId, timeoutMs: 120_000 },
            },
          ],
          stop: 'tool_use',
        };
      }
    }
    return {
      who: 'parent',
      action: 'text PARENT-WAITING',
      blocks: [{ type: 'text', text: 'PARENT-WAITING' }],
      stop: 'end_turn',
    };
  }
  return {
    who: 'aux',
    action: 'text ok',
    blocks: [{ type: 'text', text: 'ok' }],
    stop: 'end_turn',
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
        note(`model ← ${reply.who}: ${reply.action}  (last: ${lastText.slice(0, 120)})`);
      if (reply.stall) return stall(res);
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

/** pnpm dev 拉起的 Electron 主进程：命令行里没有 --type= 的那个后代 */
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

/** 只给 Electron 主进程发 SIGTERM：走应用自己的退出（等安全点、写恢复清单），再收掉 dev 进程组 */
async function quit(instance, timeout = 90_000) {
  instance.page.close();
  process.kill(instance.main, 'SIGTERM');
  await waitFor(() => !alive(instance.main), 'electron exit', timeout, 200);
  try {
    process.kill(-instance.child.pid, 'SIGTERM');
  } catch {}
}

/**
 * 用户退出（Cmd+Q / 关窗选「退出」）：关主窗口并在确认里答「退出」，走 beforeConfirmedQuit 等安全点
 */
async function quitConfirmed(instance, timeout) {
  await instance.page.evaluate(`(() => {
    const api = window.electronAPI.app;
    api.onCloseRequest((id) => api.respondCloseRequest(id, { action: 'quit' }));
    setTimeout(() => window.close(), 0);
    return true;
  })()`);
  instance.page.close();
  await waitFor(() => !alive(instance.main), 'electron exit', timeout, 200);
  try {
    process.kill(-instance.child.pid, 'SIGTERM');
  } catch {}
}

const json = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
const logLines = (name, pattern) =>
  existsSync(path.join(OUT, `${name}.log`))
    ? readFileSync(path.join(OUT, `${name}.log`), 'utf8')
        .split('\n')
        .filter((line) => pattern.test(line))
    : [];

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

  // 1. 父会话派出 task 子代理，子代理开始跑 bash
  const first = await launch('run1');
  const conversationId = await first.page.evaluate(`(async () => {
    const S = () => window.__stores.sessions.getState();
    const SET = () => window.__stores.settings.getState();
    const project = await SET().addProject(${JSON.stringify(PROJ)});
    const id = await S().newConversation(project.id);
    S().selectConversation(id);
    S().setApprovalMode(id, 'full');
    const error = await S().send('PARENT-GO', { providerId: 'pv-A', modelId: 'fake-model-1', cwd: project.path }, undefined, id);
    return error ? 'error: ' + error : id;
  })()`);
  check(
    conversationId && !String(conversationId).startsWith('error'),
    '父会话建好并发出消息',
    conversationId
  );
  if (STALLED) {
    await stalledReply(first);
    return finish(provider);
  }
  if (PARENT_WAIT) {
    await parentWaitRestart(first, conversationId);
    return finish(provider);
  }
  await waitFor(
    () => requests.some((r) => r.who === 'child' && r.action.startsWith('tool')),
    '子代理发出 bash 调用'
  );
  await sleep(1500);
  check(!existsSync(MARKER), '退出时子代理的 bash 还在跑（marker 未写）');

  // 2. 优雅退出（SIGTERM → app.quit → 等安全点、写恢复清单）
  note('SIGTERM run1 (graceful quit while the child bash is running)');
  await quit(first);
  note('run1 exited');
  check(readFileSync(MARKER, 'utf8').trim() === 'step1', '退出前 bash 跑完（等到了安全点）');
  const agentDir = path.join(ENV, 'agent');
  const manifest = json(path.join(agentDir, 'restart-manifest.json'));
  const checkpoint = json(path.join(agentDir, 'restart-checkpoint.json'));
  const childEntry = checkpoint?.sessions?.find((s) => s.sessionId.includes('::'));
  note(
    `checkpoint: ${JSON.stringify(checkpoint?.sessions?.map((s) => ({ id: s.sessionId.slice(0, 20), nextStep: s.nextStep })))}`
  );
  note(
    `manifest: ${JSON.stringify(manifest?.sessions?.map((s) => ({ id: s.sessionId.slice(0, 8), nextStep: s.nextStep })))}`
  );
  check(childEntry?.nextStep === 'model-request', '断点记下子会话停在模型请求前', checkpoint);
  const ledger = json(path.join(agentDir, 'subagent-runs.json'));
  const pendingRun = ledger?.runs?.find((r) => r.notified === false && r.restart);
  note(
    `ledger: ${JSON.stringify(ledger?.runs?.map((r) => ({ runId: r.runId.slice(0, 8), status: r.status, notified: r.notified, restart: Boolean(r.restart) })))}`
  );
  check(pendingRun, '台账里这次 Run 带着续跑记录', ledger);

  // 3. 重新启动：子代理自动续跑，父会话收到完成通知
  const childRequestsBefore = requests.filter((r) => r.who === 'child').length;
  const second = await launch('run2');
  await waitFor(
    () => requests.some((r) => r.who === 'parent' && r.action.includes('PARENT-GOT-IT')),
    '父会话收到完成通知并开一轮',
    90_000
  );
  const childAfter = requests.filter((r) => r.who === 'child').slice(childRequestsBefore);
  check(
    childAfter.length === 1 &&
      childAfter[0].action === 'final CHILD-DONE' &&
      childAfter[0].lastText.includes('step1') === false,
    '子代理重启后只发了一次请求：带着 bash 结果直接收尾，没有重新调用 bash',
    childAfter
  );
  check(readFileSync(MARKER, 'utf8').trim() === 'step1', 'bash 只执行过一次（marker 只有一行）');
  const notice = requests.find((r) => r.who === 'parent' && r.action.includes('PARENT-GOT-IT'));
  check(
    /succeeded/.test(notice?.lastText ?? ''),
    '父会话收到的是完成通知（succeeded），不是中断通知',
    notice
  );
  check(
    !requests.some((r) => r.who === 'parent' && /interrupted/.test(r.lastText)),
    '父会话没有收到「已中断」通知'
  );
  check(
    pendingRun && notice?.lastText.includes(pendingRun.runId),
    '完成通知里的 runId 就是重启前那个 runId',
    { runId: pendingRun?.runId, notice: notice?.lastText }
  );
  for (const line of logLines(
    'run2',
    /\[agent\] restart resume|wake owner|cold resume|graceful-restart\] wake/
  ))
    note(`run2 log: ${line.trim()}`);
  await quit(second, 30_000);
  return finish(provider);
}

async function stalledReply(first) {
  await waitFor(() => requests.some((r) => r.action === 'stall'), '子代理开始写回复');
  await waitFor(
    () => requests.some((r) => r.action === 'text PARENT-WAITING'),
    '父会话结束本轮（空闲）'
  );
  await sleep(1500);
  check(stalled.size === 1, '退出时子代理的回复卡在半路（连接未结束）');

  // 2. 用户退出：没有工具在跑，保底 60s、停止出 token 20s 后超时，worker 收尾中止这条回复
  note(
    `quit run1 via ${SIGTERM_QUIT ? 'SIGTERM (will-quit)' : 'close confirm'} (while the child reply is stalled)`
  );
  const quitAt = Date.now();
  if (SIGTERM_QUIT) await quit(first, 150_000);
  else await quitConfirmed(first, 150_000);
  const waited = (Date.now() - quitAt) / 1000;
  note(`run1 exited after ${waited.toFixed(1)}s`);
  check(waited >= 55, '退出等满了回复保底才中止', waited);
  check(stalled.size === 0, '卡住的回复已被中止（连接关闭）');
  const agentDir = path.join(ENV, 'agent');
  const checkpoint =
    json(path.join(agentDir, 'restart-checkpoint.json')) ??
    json(path.join(agentDir, 'restart-checkpoint.consumed.json'));
  note(
    `checkpoint: ${JSON.stringify(checkpoint?.sessions?.map((s) => ({ id: s.sessionId.slice(0, 20), nextStep: s.nextStep })))}`
  );
  check(
    checkpoint?.sessions?.some((s) => s.sessionId.includes('::')),
    '断点里有子会话',
    checkpoint
  );
  const ledgerFile = path.join(agentDir, 'subagent-runs.json');
  const summary = (runs) =>
    JSON.stringify(
      runs?.map((r) => ({
        runId: r.runId.slice(0, 8),
        status: r.status,
        notified: r.notified,
        restart: Boolean(r.restart),
      }))
    );
  const run = json(ledgerFile)?.runs?.at(-1);
  note(`ledger after run1: ${summary(json(ledgerFile)?.runs)}`);
  check(run && run.status !== 'succeeded', '台账里这次 Run 不是 succeeded', run?.status);
  check(run?.restart, '台账里这次 Run 带 restart 续跑记录');
  check(run?.notified === false, '台账里这次 Run 还没通知父会话（notified=false）', run?.notified);

  // 3. 重新启动：子代理按断点续跑（这次正常回 CHILD-DONE），父会话收到完成通知
  stallChild = false;
  const childBefore = requests.filter((r) => r.who === 'child').length;
  const second = await launch('run2');
  const gotIt = await waitFor(
    () => requests.some((r) => r.who === 'parent' && r.action.includes('PARENT-GOT-IT')),
    '父会话收到完成通知并开一轮',
    120_000
  ).catch(() => false);
  check(gotIt, '重启后父会话收到完成通知并回 PARENT-GOT-IT');
  const childAfter = requests.filter((r) => r.who === 'child').slice(childBefore);
  check(
    childAfter.some((r) => r.action === 'final CHILD-DONE'),
    '重启后子代理自动续跑并收尾',
    childAfter
  );
  const notice = requests.find((r) => r.who === 'parent' && r.action.includes('PARENT-GOT-IT'));
  check(
    /succeeded/.test(notice?.lastText ?? '') && notice.lastText.includes(run?.runId),
    '父会话收到的是重启前那个 Run 的完成通知（succeeded）',
    notice
  );
  const lost = [
    ...requests.filter((r) => /restart-lost|record was lost/.test(r.lastText)),
    ...logLines('run2', /restart-lost/),
  ];
  check(lost.length === 0, '没有 restart-lost', lost);
  note(`ledger after run2: ${summary(json(ledgerFile)?.runs)}`);
  for (const line of logLines(
    'run2',
    /\[agent\] restart resume|wake owner|cold resume|graceful-restart\] wake/
  ))
    note(`run2 log: ${line.trim()}`);
  await quit(second, 30_000);
}

async function parentWaitRestart(first, conversationId) {
  await waitFor(
    () => requests.some((r) => r.who === 'parent' && r.action === 'tool subagent wait #1'),
    '父会话进入 subagent wait #1'
  );
  await waitFor(
    () => requests.some((r) => r.who === 'child' && r.action.startsWith('tool')),
    '子代理发出 bash 调用'
  );
  await sleep(1000);
  // 1. 侧栏子代理运行标记可见
  const markerInfo = await waitFor(
    () =>
      first.page.evaluate(`(() => {
        const el = document.querySelector('[data-enso="session-subagent-marker"]');
        return el ? { text: el.textContent, title: el.getAttribute('title') } : null;
      })()`),
    '侧栏显示子代理标记',
    10_000
  );
  check(
    Boolean(markerInfo?.title?.includes('restart probe')),
    '侧栏会话行可见正在等的子代理名称',
    markerInfo
  );

  // 2. 插话(steer)打断长时间 subagent wait，子代理不受影响
  note('sending steer STEER-PING while parent is inside subagent(wait)');
  const steerRes = await first.page.evaluate(`(async () => {
    return await window.electronAPI.agent.steer(${JSON.stringify(conversationId)}, 'STEER-PING');
  })()`);
  check(steerRes?.ok === true, 'steer 调用成功', steerRes);
  await waitFor(
    () => requests.some((r) => r.who === 'parent' && r.action === 'steer ack + wait #2'),
    '父会话 wait 提前返回并立即响应 STEER-PING',
    15_000
  );
  const steerReq = requests.find((r) => r.who === 'parent' && r.action === 'steer ack + wait #2');
  check(steerReq?.lastText.includes('STEER-PING'), '插话内容立即注入父会话', steerReq?.lastText);
  check(!existsSync(MARKER), '插话提前结束 wait 时子代理仍在跑（marker 未写）');
  await sleep(800);

  // 3. 父会话再次停在 subagent(wait) 途中优雅退出：主动 detach wait，父子都干净到安全点
  note('SIGTERM run1 while parent is in subagent(wait) #2 and child bash is still running');
  const quitAt = Date.now();
  await quit(first);
  const quitSec = (Date.now() - quitAt) / 1000;
  note(`run1 exited in ${quitSec.toFixed(1)}s`);
  check(quitSec < 45, '重启未卡在 wait 超时，迅速到达安全点退出', quitSec);
  check(readFileSync(MARKER, 'utf8').trim() === 'step1', '退出前子代理 bash 跑完');

  const agentDir = path.join(ENV, 'agent');
  const checkpoint = json(path.join(agentDir, 'restart-checkpoint.json'));
  const parentEntry = checkpoint?.sessions?.find((s) => !s.sessionId.includes('::'));
  const childEntry = checkpoint?.sessions?.find((s) => s.sessionId.includes('::'));
  check(
    parentEntry?.nextStep === 'model-request' && childEntry?.nextStep === 'model-request',
    '断点里父会话与子会话都停在 model-request 安全点',
    checkpoint?.sessions
  );
  const ledger = json(path.join(agentDir, 'subagent-runs.json'));
  const pendingRun = ledger?.runs?.find((r) => r.notified === false && r.restart);
  check(Boolean(pendingRun), '台账保留子代理续跑记录', ledger?.runs);

  // 4. 重启后子代理自动续跑并收尾，父会话收到同一 runId 的完成通知
  const childBefore = requests.filter((r) => r.who === 'child').length;
  const second = await launch('run2');
  await waitFor(
    () => requests.some((r) => r.who === 'parent' && r.action.includes('PARENT-GOT-IT')),
    '重启后父会话收到子代理完成通知并回 PARENT-GOT-IT',
    90_000
  );
  const childAfter = requests.filter((r) => r.who === 'child').slice(childBefore);
  check(
    childAfter.length === 1 && childAfter[0].action === 'final CHILD-DONE',
    '子代理重启后只补发一次收尾请求，不重跑 bash',
    childAfter
  );
  check(readFileSync(MARKER, 'utf8').trim() === 'step1', '子代理 bash 全程只执行过一次');
  const notice = requests.find((r) => r.who === 'parent' && r.action.includes('PARENT-GOT-IT'));
  check(
    Boolean(
      pendingRun &&
        /succeeded/.test(notice?.lastText ?? '') &&
        notice.lastText.includes(pendingRun.runId)
    ),
    '父会话收到重启前同一 runId 的 succeeded 完成通知',
    { runId: pendingRun?.runId, notice: notice?.lastText }
  );
  check(
    requests.some((r) => r.who === 'parent' && r.action === 'text PARENT-WAITING-AFTER-RESTART'),
    '父会话重启续跑收到了 wait 主动脱离提示而非报错'
  );
  check(
    !requests.some(
      (r) => r.who === 'parent' && /<agent-notification>[\s\S]*interrupted/.test(r.lastText)
    ),
    '父会话未收到误报的 interrupted 通知'
  );
  await quit(second, 30_000);
}

function finish(provider) {
  for (const res of stalled) res.destroy();
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
