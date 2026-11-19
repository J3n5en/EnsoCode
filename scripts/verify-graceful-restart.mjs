#!/usr/bin/env node
// 优雅重启验证：工具调用结束后再重启进程，新进程接着原来的 agent loop 往下走，不从头跑。
//   node scripts/verify-graceful-restart.mjs [--keep] [--self-test]
//
// 驱动的是旁边的独立模拟器 scripts/graceful-restart-sim.mjs（应用启动路径不引用它）。
// 模拟器直接 import 产品的 src/shared/gracefulRestart.ts（安全点判定 restartGate、断点读写），
// 协议与真实 worker 一致，沿用真实边界的名字：
//   - agent worker：Main 用 utilityProcess.fork 起的进程（src/main/services/agentHost.ts）；
//   - pi 事件：turn_start / tool_execution_start / tool_execution_end / turn_end / agent_end /
//     agent_settled（src/agent/supervisor.ts onSessionEvent），进行中的工具记在 toolStartAt；
//   - 回合收口：worker 发给 Main 的 turn-completed（同一个 turnId 贯穿一次 agent loop）；
//   - 重启：Main 发 graceful-restart 命令，worker 回 graceful-restart-deferred（未到安全点的会话列表）
//     或 graceful-restart-ready（checkpoint = 写进 restart-checkpoint.json 的整份断点）；
//   - 对话正文：session.jsonl（pi SessionManager 会话文件），新进程靠它恢复上下文。
// 两个进程怎么来：本脚本开一个 127.0.0.1 控制端口（扮演 Main），起第 1 代模拟 worker。
// 收到 graceful-restart 后，模拟器在安全点写 restart-checkpoint.json，用 spawn 拉起下一代
// （detached，新 pid），然后自己 process.exit；下一代先等上一代 pid 消失，再读 session.jsonl
// 和断点、重新连上控制端口接着跑。本脚本按 pid 核对：旧进程确实退出，新进程是另一个 pid。
// （产品里换进程由 Main 做：杀掉旧 utilityProcess 后带断点路径 fork 新的，再重发 spawn-parent。）
//
// 要证明的 4 条（任一条失败都非 0 退出，并写明是第几条）：
//   1. 没有进行中的工具调用时收到重启请求，就在当前回合边界重启。
//   2. 工具调用还在跑时收到重启请求，进程保持不动，这次工具调用正常返回。
//   3. 这次工具调用一结束就重启；重启前把「loop 走到哪了」落盘，新进程能读到。
//   4. 新进程从下一步继续，不再执行刚完成的工具调用；对话上下文还在。
// --self-test：正常跑一遍后，再用 SIM_BREAK 让模拟器故意做错，确认对应那条确实会失败。
// --keep：保留 /tmp 下的现场目录（session.jsonl、tool-ledger.jsonl、断点、sim.log）。
//
// 不做的事（留给以后的升级功能）：不换二进制、不拉更新包、不重启整个 Electron 窗口、
// 不处理重启过程中用户又发来的新消息（模拟器直接拒收）、不接自动升级。
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const SELF = fileURLToPath(import.meta.url);
const SIM = path.join(path.dirname(SELF), 'graceful-restart-sim.mjs');
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const SELF_TEST = argv.includes('--self-test');
const BREAK = argv.find((arg) => arg.startsWith('--break='))?.slice('--break='.length) ?? '';

const CLAIMS = {
  1: '没有进行中的工具调用时，在当前回合边界重启',
  2: '工具调用进行中不重启，这次调用正常返回',
  3: '工具调用一结束就重启，重启前断点已落盘',
  4: '新进程从下一步继续，不重做刚完成的工具调用，上下文还在',
};

const results = [];

function check(claim, ok, label, detail) {
  results.push({ claim, ok: Boolean(ok) });
  const extra =
    !ok && detail !== undefined
      ? ` —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
      : '';
  console.log(`${ok ? 'PASS' : 'FAIL'} [第${claim}条] ${label}${extra}`);
  return Boolean(ok);
}

class StepTimeout extends Error {
  constructor(claim, label) {
    super(label);
    this.claim = claim;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() > deadline) return false;
    await delay(20);
  }
  return true;
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

const transcriptOf = (dir) =>
  readJsonl(path.join(dir, 'session.jsonl'))
    .filter((entry) => entry.type === 'message')
    .map((entry) => entry.message);

const nonce = (prefix) => `${prefix}-${randomBytes(3).toString('hex')}`;

// 模拟器 import 了 .ts：老一些的 Node 22 需要显式打开类型剥离
const SIM_ARGS = process.features?.typescript ? [SIM] : ['--experimental-strip-types', SIM];

const isRestartReaction = (generation) => (e) =>
  e.generation === generation &&
  (e.type === 'graceful-restart-deferred' || e.type === 'graceful-restart-ready');

/** 断点里只有这一个会话时取出它的条目，否则 undefined（多出或缺少会话都算错） */
const entryOf = (event) =>
  event?.checkpoint?.sessions?.length === 1 ? event.checkpoint.sessions[0] : undefined;

/** 推迟回执里只有这一个会话时取出它，否则 undefined */
const deferredOf = (event) =>
  event?.type === 'graceful-restart-deferred' && event.sessions?.length === 1
    ? event.sessions[0]
    : undefined;

const is =
  (type, generation, more = () => true) =>
  (event) =>
    event.type === type && event.generation === generation && more(event);

/** 扮演 Main：收模拟 worker 的事件（按到达顺序编号 seen），按代发命令。 */
async function openHub() {
  const events = [];
  const sockets = new Map();
  const server = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const event = { ...JSON.parse(line), seen: events.length };
        if (event.type === 'hello') sockets.set(event.generation, socket);
        events.push(event);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    events,
    send(generation, command) {
      const socket = sockets.get(generation);
      if (!socket) throw new Error(`第 ${generation} 代没有连上`);
      socket.write(`${JSON.stringify(command)}\n`);
    },
    async wait(claim, label, predicate, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = events.find(predicate);
        if (hit) return hit;
        if (Date.now() > deadline) throw new StepTimeout(claim, `等待超时：${label}`);
        await delay(20);
      }
    },
    close() {
      for (const socket of sockets.values()) socket.destroy();
      server.close();
    },
  };
}

async function scenario(name, claims, body) {
  console.log(`\n== 场景：${name} ==`);
  const dir = mkdtempSync(path.join(tmpdir(), 'enso-graceful-restart-'));
  const hub = await openHub();
  const pids = new Set();
  const before = results.length;
  const start = () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('SIM_'))
    );
    const log = openSync(path.join(dir, 'sim.log'), 'a');
    const child = spawn(process.execPath, SIM_ARGS, {
      env: {
        ...env,
        SIM_DIR: dir,
        SIM_CONTROL_PORT: String(hub.port),
        ...(BREAK ? { SIM_BREAK: BREAK } : {}),
      },
      stdio: ['ignore', log, log],
      detached: true,
    });
    pids.add(child.pid);
    return child;
  };
  try {
    await body({ dir, hub, start });
  } catch (error) {
    const claim = error instanceof StepTimeout ? error.claim : claims[0];
    check(
      claim,
      false,
      error instanceof StepTimeout ? error.message : String(error?.stack ?? error)
    );
  } finally {
    for (const event of hub.events) {
      if (event.pid) pids.add(event.pid);
      if (event.successorPid) pids.add(event.successorPid);
    }
    for (const pid of pids) {
      if (!alive(pid)) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    hub.close();
  }
  const mine = results.slice(before);
  for (const claim of claims) {
    if (!mine.some((result) => result.claim === claim)) {
      check(claim, false, '没有执行到这一条的检查（前置步骤已失败）');
    }
  }
  const failed = results.slice(before).some((result) => !result.ok);
  if (KEEP || failed) {
    console.log(`现场目录：${dir}`);
    if (failed && existsSync(path.join(dir, 'sim.log'))) {
      const log = readFileSync(path.join(dir, 'sim.log'), 'utf8').trim();
      if (log) console.log(`sim.log:\n${log}`);
    }
  } else {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function idleBoundaryScenario({ hub, start }) {
  const remember = nonce('alpha');
  start();
  const hello1 = await hub.wait(1, '第 1 代 worker 连上', is('hello', 1));
  hub.send(1, { type: 'prompt', text: `REMEMBER:${remember} PLAN:` });
  await hub.wait(
    1,
    '第 1 代开始流式回复',
    is('message_start', 1, (e) => e.role === 'assistant')
  );
  hub.send(1, { type: 'graceful-restart' });
  const reaction = await hub.wait(1, '第 1 代回应重启请求', isRestartReaction(1));
  check(
    1,
    deferredOf(reaction)?.reason === 'turn-in-progress' &&
      deferredOf(reaction).toolsInFlight.length === 0,
    '回复流式输出中途收到请求（toolStartAt 为空）：不打断，等到回合边界',
    reaction
  );
  const completed = await hub.wait(1, '第 1 代 turn-completed', is('turn-completed', 1));
  const restarting1 = await hub.wait(
    1,
    '第 1 代在回合边界发出 graceful-restart-ready',
    is('graceful-restart-ready', 1)
  );
  const reply1 = hub.events.find(is('message_end', 1, (e) => e.role === 'assistant'));
  check(
    1,
    reply1?.text === `reply remember=${remember} results=`,
    '这条回复完整写完，没有被重启截断',
    reply1?.text
  );
  check(
    1,
    restarting1.seen > completed.seen &&
      !hub.events.some(is('turn_start', 1, (e) => e.seen > completed.seen)),
    '重启紧跟 turn-completed，之后没有再开 turn_start'
  );
  check(1, !hub.events.some(is('tool_execution_start', 1)), '这一回合没有工具调用');
  check(
    1,
    entryOf(restarting1)?.nextStep === 'await-user' && entryOf(restarting1).turnId === null,
    '断点记为 await-user（回合已收口，等用户下一条）',
    restarting1.checkpoint
  );
  check(1, await waitExit(hello1.pid, 3000), `第 1 代进程 ${hello1.pid} 已退出`);
  const hello2 = await hub.wait(1, '第 2 代 worker 连上', is('hello', 2));
  check(
    1,
    hello2.pid !== hello1.pid &&
      hello2.pid === restarting1.successorPid &&
      hello2.predecessor === hello1.pid &&
      hello2.predecessorExited === true,
    `第 2 代是第 1 代拉起的新进程 ${hello2.pid}，第 1 代退出后才接管`,
    { hello1: hello1.pid, hello2 }
  );
  await delay(300);
  check(
    1,
    !hub.events.some(
      (e) => e.generation === 2 && (e.type === 'agent_start' || e.type === 'turn_start')
    ),
    '第 2 代起来后保持空闲，没有自己开跑'
  );
  const requestedAt = Date.now();
  hub.send(2, { type: 'graceful-restart' });
  const reaction2 = await hub.wait(1, '第 2 代回应空闲时的重启请求', isRestartReaction(2));
  check(
    1,
    reaction2.type === 'graceful-restart-ready' &&
      entryOf(reaction2)?.nextStep === 'await-user' &&
      reaction2.at - requestedAt < 1000,
    '会话空闲（两个回合之间）收到请求：立即重启，不等待',
    { type: reaction2.type, waitedMs: reaction2.at - requestedAt }
  );
  check(1, await waitExit(hello2.pid, 3000), `第 2 代进程 ${hello2.pid} 已退出`);
  await hub.wait(1, '第 3 代 worker 连上', is('hello', 3));
  hub.send(3, { type: 'prompt', text: 'PLAN:' });
  await hub.wait(1, '第 3 代 turn-completed', is('turn-completed', 3));
  const reply3 = hub.events.find(is('message_end', 3, (e) => e.role === 'assistant'));
  check(
    1,
    reply3?.text === `reply remember=${remember} results=`,
    '两次重启后对话上下文还在（第 3 代答出第 1 代时用户给的口令）',
    reply3?.text
  );
}

async function toolBoundaryScenario({ dir, hub, start }) {
  const remember = nonce('beta');
  start();
  const hello1 = await hub.wait(2, '第 1 代 worker 连上', is('hello', 1));
  hub.send(1, { type: 'prompt', text: `REMEMBER:${remember} PLAN:slow_probe,marker` });
  const agentStart = await hub.wait(2, '第 1 代 agent_start', is('agent_start', 1));
  const toolStart = await hub.wait(
    2,
    '第 1 代 slow_probe 的 tool_execution_start',
    is('tool_execution_start', 1, (e) => e.toolName === 'slow_probe')
  );
  const callId = toolStart.toolCallId;
  hub.send(1, { type: 'graceful-restart' });

  // 第 2 条
  const reaction = await hub.wait(2, '第 1 代回应重启请求', isRestartReaction(1));
  check(
    2,
    deferredOf(reaction)?.reason === 'tool-in-flight' &&
      deferredOf(reaction).toolsInFlight.includes(callId),
    `工具 ${callId} 还在跑：请求挂起，不立即重启`,
    reaction
  );
  await delay(300);
  check(
    2,
    alive(hello1.pid) && !hub.events.some(is('graceful-restart-ready', 1)),
    `请求发出 300ms 后第 1 代进程 ${hello1.pid} 仍在，没有开始重启`
  );
  const toolEnd = await hub.wait(
    2,
    `${callId} 的 tool_execution_end`,
    is('tool_execution_end', 1, (e) => e.toolCallId === callId)
  );
  check(
    2,
    toolEnd.isError === false && toolEnd.result === `probe-${callId}-${hello1.pid}`,
    '这次工具调用由第 1 代正常返回（不是错误、不是中断）',
    toolEnd
  );
  const early = hub.events.find(is('graceful-restart-ready', 1));
  check(2, !early || early.seen > toolEnd.seen, '工具返回之前没有发生重启');

  // 第 3 条
  const restarting1 = await hub.wait(
    3,
    '工具结束后第 1 代发出 graceful-restart-ready',
    is('graceful-restart-ready', 1)
  );
  check(
    3,
    restarting1.at - toolEnd.at < 1000,
    `工具结束后 ${restarting1.at - toolEnd.at}ms 开始重启`,
    { gapMs: restarting1.at - toolEnd.at }
  );
  check(
    3,
    !hub.events.some(is('turn_start', 1, (e) => e.seen > toolEnd.seen)),
    '第 1 代在工具结束后没有再发下一次模型请求（turn_start）'
  );
  const checkpoint = entryOf(restarting1);
  check(
    3,
    checkpoint?.nextStep === 'model-request' &&
      checkpoint.lastCompletedToolCallId === callId &&
      checkpoint.turnId === agentStart.turnId &&
      checkpoint.toolsInFlight.length === 0,
    `断点写明：下一步是模型请求，刚完成 ${callId}，同一个 turnId，没有在跑的工具`,
    restarting1.checkpoint
  );
  check(3, await waitExit(hello1.pid, 3000), `第 1 代进程 ${hello1.pid} 已退出`);
  const hello2 = await hub.wait(3, '第 2 代 worker 连上', is('hello', 2));
  const resumed = await hub.wait(3, '第 2 代读到断点（resumed）', is('resumed', 2));
  const archived = readJsonl(path.join(dir, 'restart-checkpoint.gen2.json'))[0];
  check(
    3,
    isDeepStrictEqual(archived, restarting1.checkpoint) &&
      isDeepStrictEqual(resumed.checkpoint, checkpoint),
    '断点落在磁盘 restart-checkpoint.json，第 2 代读到的就是第 1 代写下的',
    { archived, resumed: resumed.checkpoint, written: restarting1.checkpoint }
  );
  check(
    3,
    transcriptOf(dir)
      .slice(0, checkpoint.messageCount)
      .some((message) => message.role === 'toolResult' && message.toolCallId === callId),
    `重启前 ${callId} 的工具结果已写进 session.jsonl`
  );

  // 第 4 条
  check(
    4,
    hello2.pid !== hello1.pid &&
      hello2.pid === restarting1.successorPid &&
      hello2.predecessor === hello1.pid &&
      hello2.predecessorExited === true,
    `第 2 代是另一个进程 ${hello2.pid}：由第 1 代 ${hello1.pid} 拉起，第 1 代退出后才接管`,
    { hello2, successorPid: restarting1.successorPid }
  );
  const completed2 = await hub.wait(4, '第 2 代 turn-completed', is('turn-completed', 2), 8000);
  check(
    4,
    completed2.turnId === agentStart.turnId,
    '收口的是同一个回合（turnId 不变），不是重开一轮',
    { first: agentStart.turnId, second: completed2.turnId }
  );
  const firstStep = hub.events.find((e) => e.generation === 2 && e.seen > resumed.seen);
  check(
    4,
    firstStep?.type === 'turn_start' && !hub.events.some(is('agent_start', 2)),
    '第 2 代接着发下一次模型请求（turn_start），没有重新 agent_start',
    firstStep?.type
  );
  check(
    4,
    !hub.events.some(is('tool_execution_start', 2, (e) => e.toolCallId === callId)),
    `第 2 代没有再执行 ${callId}`
  );
  const ledger = readJsonl(path.join(dir, 'tool-ledger.jsonl'));
  const starts = (id) => ledger.filter((row) => row.toolCallId === id && row.phase === 'start');
  check(
    4,
    starts(callId).length === 1 && starts(callId)[0].pid === hello1.pid,
    `工具执行账本：${callId} 只执行过 1 次，由第 1 代执行`,
    ledger
  );
  const marker = hub.events.find(is('tool_execution_start', 2, (e) => e.toolName === 'marker'));
  check(
    4,
    marker &&
      starts(marker.toolCallId).length === 1 &&
      starts(marker.toolCallId)[0].pid === hello2.pid,
    '计划里的下一个工具 marker 由第 2 代执行 1 次',
    ledger
  );
  const transcript = transcriptOf(dir);
  const resultIds = transcript.filter((m) => m.role === 'toolResult').map((m) => m.toolCallId);
  check(
    4,
    transcript.filter((m) => m.role === 'user').length === 1 &&
      new Set(resultIds).size === resultIds.length,
    'session.jsonl 里用户消息 1 条、每个工具结果各 1 条，没有重复',
    transcript
  );
  const finalReply = hub.events.findLast(is('message_end', 2, (e) => e.role === 'assistant'));
  const expected = `reply remember=${remember} results=probe-${callId}-${hello1.pid},marker-${marker?.toolCallId}`;
  check(
    4,
    finalReply?.text === expected,
    '对话上下文还在：最终回复带着用户口令和第 1 代的工具结果',
    { got: finalReply?.text, expected }
  );
}

async function verify() {
  console.log(
    BREAK
      ? `故障注入：SIM_BREAK=${BREAK}`
      : '优雅重启验证（模拟器，与产品共用安全点判定与断点代码）'
  );
  await scenario('没有工具在跑时的重启（第 1 条）', [1], idleBoundaryScenario);
  await scenario('工具调用中途的重启（第 2-4 条）', [2, 3, 4], toolBoundaryScenario);
  console.log('\n汇总：');
  const failed = [];
  for (const claim of [1, 2, 3, 4]) {
    const mine = results.filter((result) => result.claim === claim);
    const ok = mine.length > 0 && mine.every((result) => result.ok);
    if (!ok) failed.push(claim);
    console.log(`  第${claim}条 ${ok ? 'PASS' : 'FAIL'}（${mine.length} 项检查）${CLAIMS[claim]}`);
  }
  if (failed.length > 0) {
    console.log(`失败：${failed.map((claim) => `第${claim}条`).join('、')}`);
    return 1;
  }
  console.log('4 条全部通过');
  return 0;
}

const BREAKS = [
  ['ignore-idle', 1, '没有工具在跑也不在回合边界重启'],
  ['restart-immediately', 2, '工具还在跑就重启'],
  ['no-checkpoint', 3, '重启前不写断点'],
  ['replay-tool', 4, '新进程重做刚完成的工具'],
  ['drop-context', 4, '新进程丢了对话上下文'],
];

async function selfTest() {
  console.log('\n== 自检：故意做错，确认对应那条会失败 ==');
  let missed = 0;
  for (const [mode, claim, label] of BREAKS) {
    const child = spawn(process.execPath, [SELF, `--break=${mode}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const code = await new Promise((resolve) => child.once('close', resolve));
    const caught = code !== 0 && output.includes(`第${claim}条 FAIL`);
    if (!caught) missed++;
    console.log(
      `${caught ? 'PASS' : 'FAIL'} [自检] SIM_BREAK=${mode}（${label}）→ 退出码 ${code}，第${claim}条${caught ? '如期失败' : '没有抓到'}`
    );
    if (!caught) console.log(output);
  }
  return missed === 0 ? 0 : 1;
}

let code = await verify();
if (SELF_TEST && !BREAK && code === 0) code = await selfTest();
process.exit(code);
