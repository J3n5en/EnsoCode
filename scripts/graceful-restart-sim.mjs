#!/usr/bin/env node
// 优雅重启模拟器：只由 scripts/verify-graceful-restart.mjs 启动，应用启动路径不引用。
// 一个进程扮演一代 agent worker。事件名沿用 src/agent/supervisor.ts onSessionEvent 消费的
// pi AgentSession 事件（agent_start / turn_start / message_start / message_end /
// tool_execution_start / tool_execution_end / turn_end / agent_end / agent_settled），
// 回合收口沿用 worker 发给 Main 的 turn-completed；进行中的工具按 toolCallId 记在 toolStartAt。
// 正文逐条追加到 session.jsonl（对应 pi SessionManager 的会话文件）。
// 重启：写 restart-checkpoint.json → 拉起下一代进程 → 本进程退出；下一代等上一代退出后才接管。
// SIM_BREAK 故意做错一处，供验证脚本 --self-test 确认每条检查真的会失败。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const DIR = process.env.SIM_DIR;
const PORT = Number(process.env.SIM_CONTROL_PORT);
const GENERATION = Number(process.env.SIM_GENERATION || '1');
const PREDECESSOR = Number(process.env.SIM_PREDECESSOR_PID || '0');
const BREAK = process.env.SIM_BREAK || '';
const SLOW_TOOL_MS = Number(process.env.SIM_SLOW_TOOL_MS || '1500');
const STREAM_MS = Number(process.env.SIM_STREAM_MS || '600');
if (!DIR || !PORT) {
  console.error('SIM_DIR / SIM_CONTROL_PORT 未设置');
  process.exit(2);
}

const SESSION_FILE = path.join(DIR, 'session.jsonl');
const CHECKPOINT_FILE = path.join(DIR, 'restart-checkpoint.json');
const LEDGER_FILE = path.join(DIR, 'tool-ledger.jsonl');

const messages = [];
const toolStartAt = new Map();
let status = 'idle';
let restartRequested = false;
let restarting = false;
let currentTurnId;
let lastCompletedToolCallId = null;
let socket;

function emit(event) {
  socket.write(
    `${JSON.stringify({ ...event, generation: GENERATION, pid: process.pid, at: Date.now() })}\n`
  );
}

function persist(message) {
  messages.push(message);
  appendFileSync(
    SESSION_FILE,
    `${JSON.stringify({ type: 'message', id: randomUUID(), message })}\n`
  );
}

function ledger(toolCallId, phase) {
  appendFileSync(
    LEDGER_FILE,
    `${JSON.stringify({ toolCallId, phase, generation: GENERATION, pid: process.pid })}\n`
  );
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// 假模型：只凭上下文决定下一步，和真模型一样不知道进程换过。
// 上下文里缺了工具结果，它就会再调一次那个工具——所以丢上下文和重做工具都能被看出来。
function nextAssistant() {
  const runStart = messages.findLastIndex((message) => message.role === 'user');
  const prompt = runStart >= 0 ? messages[runStart].text : '';
  const plan = (/PLAN:(\S*)/.exec(prompt)?.[1] ?? '').split(',').filter(Boolean);
  const done = new Map(
    messages
      .slice(runStart + 1)
      .filter((message) => message.role === 'toolResult')
      .map((message) => [message.toolName, message])
  );
  const pending = plan.find((name) => !done.has(name));
  if (pending) {
    return {
      role: 'assistant',
      text: '',
      toolCalls: [{ id: `${pending}-${runStart}`, name: pending }],
    };
  }
  const remember =
    messages
      .map((message) => message.role === 'user' && /REMEMBER:(\S+)/.exec(message.text)?.[1])
      .find(Boolean) ?? 'MISSING';
  const results = plan.map((name) => done.get(name).output).join(',');
  return {
    role: 'assistant',
    text: `reply remember=${remember} results=${results}`,
    toolCalls: [],
  };
}

const TOOLS = {
  async slow_probe(call) {
    await delay(SLOW_TOOL_MS);
    return `probe-${call.id}-${process.pid}`;
  },
  async marker(call) {
    return `marker-${call.id}`;
  },
};

async function streamAssistant() {
  emit({ type: 'message_start', role: 'assistant' });
  await delay(STREAM_MS);
  const message = nextAssistant();
  persist(message);
  emit({
    type: 'message_end',
    role: 'assistant',
    text: message.text,
    toolCalls: message.toolCalls.map((call) => call.id),
  });
  return message;
}

async function executeTool(call) {
  toolStartAt.set(call.id, Date.now());
  ledger(call.id, 'start');
  emit({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name });
  const output = await TOOLS[call.name](call);
  toolStartAt.delete(call.id);
  ledger(call.id, 'end');
  emit({
    type: 'tool_execution_end',
    toolCallId: call.id,
    toolName: call.name,
    isError: false,
    result: output,
  });
  persist({ role: 'toolResult', toolCallId: call.id, toolName: call.name, output });
  emit({ type: 'message_end', role: 'toolResult', toolCallId: call.id });
  lastCompletedToolCallId = call.id;
}

async function runAgentLoop(resumed) {
  status = 'running';
  if (!resumed) {
    currentTurnId = randomUUID();
    emit({ type: 'agent_start', turnId: currentTurnId });
  }
  for (;;) {
    emit({ type: 'turn_start' });
    const assistant = await streamAssistant();
    for (const call of assistant.toolCalls) await executeTool(call);
    emit({ type: 'turn_end', toolResults: assistant.toolCalls.map((call) => call.id) });
    if (assistant.toolCalls.length === 0) break;
    // 本批工具全部返回、结果已落盘、下一次模型请求还没发：loop 中途唯一的安全重启点
    if (restartRequested) return gracefulRestart('model-request');
  }
  emit({ type: 'agent_end' });
  emit({ type: 'agent_settled' });
  status = 'idle';
  const turnId = currentTurnId;
  currentTurnId = undefined;
  emit({ type: 'turn-completed', turnId });
  if (restartRequested && BREAK !== 'ignore-idle') await gracefulRestart('await-user');
}

async function gracefulRestart(nextStep) {
  if (restarting) return;
  restarting = true;
  const checkpoint = {
    generation: GENERATION,
    pid: process.pid,
    nextStep,
    turnId: currentTurnId ?? null,
    lastCompletedToolCallId,
    messageCount: messages.length,
    toolsInFlight: [...toolStartAt.keys()],
  };
  if (BREAK !== 'no-checkpoint') {
    writeFileSync(`${CHECKPOINT_FILE}.tmp`, JSON.stringify(checkpoint));
    renameSync(`${CHECKPOINT_FILE}.tmp`, CHECKPOINT_FILE);
  }
  const log = openSync(path.join(DIR, 'sim.log'), 'a');
  const successor = spawn(process.execPath, [SELF], {
    env: {
      ...process.env,
      SIM_GENERATION: String(GENERATION + 1),
      SIM_PREDECESSOR_PID: String(process.pid),
    },
    stdio: ['ignore', log, log],
    detached: true,
  });
  await new Promise((resolve, reject) => {
    successor.once('spawn', resolve);
    successor.once('error', reject);
  });
  successor.unref();
  emit({ type: 'restarting', checkpoint, successorPid: successor.pid });
  await new Promise((resolve) => socket.end(resolve));
  process.exit(0);
}

function onCommand(command) {
  if (command.type === 'prompt') {
    // 重启过程中又来的新消息不在本模拟范围内，直接拒收
    if (status !== 'idle' || restarting) {
      emit({ type: 'prompt-rejected' });
      return;
    }
    persist({ role: 'user', text: command.text });
    emit({ type: 'message_end', role: 'user' });
    void runAgentLoop(false).catch(fatal);
    return;
  }
  if (command.type !== 'restart-request' || restarting) return;
  if (BREAK === 'restart-immediately') {
    void gracefulRestart(status === 'idle' ? 'await-user' : 'model-request').catch(fatal);
    return;
  }
  if (status === 'idle' && BREAK !== 'ignore-idle') {
    void gracefulRestart('await-user').catch(fatal);
    return;
  }
  restartRequested = true;
  emit({
    type: 'restart-deferred',
    reason: toolStartAt.size > 0 ? 'tool-in-flight' : 'turn-in-progress',
    toolsInFlight: [...toolStartAt.keys()],
  });
}

function fatal(error) {
  console.error(error);
  try {
    emit({ type: 'sim-error', message: String(error?.stack ?? error) });
  } catch {}
  process.exit(1);
}

function loadTranscript() {
  if (!existsSync(SESSION_FILE)) return;
  for (const line of readFileSync(SESSION_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (entry.type === 'message') messages.push(entry.message);
  }
}

/** 读到即改名归档：同一个断点只被接管一次，归档文件留给验证脚本核对。 */
function takeCheckpoint() {
  if (!existsSync(CHECKPOINT_FILE)) return null;
  const consumed = path.join(DIR, `restart-checkpoint.gen${GENERATION}.json`);
  renameSync(CHECKPOINT_FILE, consumed);
  return JSON.parse(readFileSync(consumed, 'utf8'));
}

async function main() {
  const ppidAtBoot = process.ppid;
  if (PREDECESSOR) {
    const deadline = Date.now() + 10_000;
    while (alive(PREDECESSOR)) {
      if (Date.now() > deadline) throw new Error(`上一代进程 ${PREDECESSOR} 一直没有退出`);
      await delay(20);
    }
  }
  socket = connect(PORT, '127.0.0.1');
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) onCommand(JSON.parse(line));
    }
  });
  socket.on('close', () => {
    if (!restarting) process.exit(0);
  });
  emit({
    type: 'hello',
    predecessor: PREDECESSOR || null,
    predecessorExited: PREDECESSOR ? !alive(PREDECESSOR) : null,
    ppidAtBoot,
  });
  if (BREAK !== 'drop-context' || GENERATION === 1) loadTranscript();
  const checkpoint = GENERATION > 1 ? takeCheckpoint() : null;
  if (!checkpoint) return;
  if (BREAK === 'replay-tool') {
    while (messages.at(-1)?.role === 'toolResult') messages.pop();
    if (messages.at(-1)?.toolCalls?.length) messages.pop();
  }
  emit({ type: 'resumed', checkpoint, messageCount: messages.length });
  if (checkpoint.nextStep !== 'model-request') return;
  currentTurnId = checkpoint.turnId;
  lastCompletedToolCallId = checkpoint.lastCompletedToolCallId;
  void runAgentLoop(true).catch(fatal);
}

main().catch(fatal);
