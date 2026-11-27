import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const logPath = process.env.FAKE_AGY_LOG;
const version = process.env.FAKE_AGY_VERSION || '1.5.18';
const signedOut = process.env.FAKE_AGY_SIGNED_OUT === '1';
/** 设了就把权限请求换成 agy 对我们 Host MCP 工具发的那种：`mcp_enso_<值>` */
const mcpPermission = process.env.FAKE_AGY_MCP_PERMISSION;
/** `1`：initialize 不通告 `_meta.antigravity.systemPrompt.append` */
const noAppend = process.env.FAKE_AGY_NO_APPEND === '1';
/** `1`：session/resume 回一个非登录类错误，让客户端退回 session/new */
const resumeFails = process.env.FAKE_AGY_RESUME_FAIL === '1';
/**
 * 按 agy 1.5.18 线上记下的顺序回放：
 * - `steer`：第一个 prompt 流到一半等第二个 prompt；第二个一到，第一个 23ms 内返回 end_turn（无 usage），
 *   剩余文字照流、usage_update，再流第二个的回答、usage_update，第二个返回 end_turn 和整轮 usage。
 * - `background`：起一个后台命令（`FAKE_AGY_DAEMON=1` 时 IsDaemon），prompt 先 end_turn；
 *   命令跑完后 agy 不等新 prompt 自己接着回复，以 usage_update 收口。
 */
const script = process.env.FAKE_AGY_SCRIPT;

function log(entry) {
  if (!logPath) return;
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

let batched = null;

function send(message) {
  const line = `${JSON.stringify(message)}\n`;
  if (batched) batched.push(line);
  else process.stdout.write(line);
}

function batch(write) {
  batched = [];
  write();
  const lines = batched.join('');
  batched = null;
  process.stdout.write(lines);
}

let nextId = 1;
const pending = new Map();
let promptId = null;
let generation = 0;

function request(method, params) {
  const id = nextId;
  nextId += 1;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function update(sessionId, body) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: body },
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (sessionId, text) =>
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const usageUpdate = (sessionId, used) =>
  update(sessionId, { sessionUpdate: 'usage_update', used, size: 1048576 });
const fullUsage = { inputTokens: 3, cachedReadTokens: 2, outputTokens: 4, totalTokens: 9 };

let steerWaiter = null;
let cancelled = false;

async function steerPrompt(id, params) {
  const sessionId = params.sessionId;
  if (steerWaiter) {
    const first = steerWaiter;
    steerWaiter = null;
    first(id);
    return;
  }
  promptId = id;
  usageUpdate(sessionId, 0);
  say(sessionId, 'Once upon');
  const second = await new Promise((resolve) => {
    steerWaiter = resolve;
    setTimeout(() => resolve(null), 3_000);
  });
  if (second === null) {
    steerWaiter = null;
    say(sessionId, ' the end.');
    usageUpdate(sessionId, 10);
    promptId = null;
    respond(id, { stopReason: 'end_turn', usage: fullUsage });
    return;
  }
  await sleep(20);
  // 答复和随后的剩余文字、usage_update 放进同一次写：读端会在一块 stdout 里同时收到
  batch(() => {
    respond(id, { stopReason: 'end_turn' });
    say(sessionId, ' a time.');
    usageUpdate(sessionId, 10);
  });
  promptId = second;
  await sleep(30);
  say(sessionId, 'steered');
  usageUpdate(sessionId, 12);
  await sleep(10);
  promptId = null;
  respond(second, {
    stopReason: 'end_turn',
    usage: { inputTokens: 30, cachedReadTokens: 20, outputTokens: 40, totalTokens: 90 },
  });
}

async function backgroundPrompt(id, params) {
  const sessionId = params.sessionId;
  cancelled = false;
  promptId = id;
  say(sessionId, 'Starting.');
  const rawInput = {
    CommandLine: 'sleep 1 && echo done',
    toolSummary: 'Wait',
    ...(process.env.FAKE_AGY_DAEMON === '1' ? { IsDaemon: true } : {}),
  };
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'bg-1',
    name: 'run_command',
    kind: 'execute',
    title: rawInput.CommandLine,
    status: 'in_progress',
    rawInput,
  });
  usageUpdate(sessionId, 5);
  promptId = null;
  respond(id, { stopReason: 'end_turn', usage: fullUsage });
  await sleep(Number(process.env.FAKE_AGY_BACKGROUND_MS || 300));
  if (cancelled) return;
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'bg-1',
    name: 'run_command',
    kind: 'execute',
    status: 'completed',
    rawInput,
    rawOutput: { output: 'done\n', exit_code: 0 },
  });
  await sleep(20);
  say(sessionId, 'It printed done.');
  usageUpdate(sessionId, 8);
}

const sessionResult = {
  sessionId: 'fake-session',
  configOptions: [
    {
      id: 'model',
      type: 'select',
      currentValue: 'gemini-4-hydrogen',
      options: [{ value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' }],
    },
    {
      id: 'thought_level',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'xhigh', name: 'Extra' },
      ],
    },
    {
      id: 'mode',
      category: 'mode',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'plan', name: 'Plan' },
      ],
    },
  ],
  modes: {
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'plan', name: 'Plan' },
    ],
  },
};

async function handlePrompt(id, params) {
  const token = ++generation;
  promptId = id;
  log({ method: 'session/prompt', params });
  const sessionId = params.sessionId;
  update(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Hello from agy' },
  });
  update(sessionId, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'thinking' },
  });
  const readPath = process.env.FAKE_AGY_READ;
  const target = readPath || '/tmp/a.ts';
  // agy 1.5.18：update 上带 name / args / kind，title 是给人看的
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'read-1',
    name: 'read_file',
    args: { Path: target },
    status: 'in_progress',
    kind: 'read',
    title: 'File a.ts',
    locations: [{ path: target }],
    rawInput: { Path: target },
  });
  if (readPath) {
    try {
      const content = await request('fs/read_text_file', { sessionId, path: readPath });
      log({ method: 'fs/read_text_file', result: content });
    } catch (error) {
      log({ method: 'fs/read_text_file', error: String(error) });
    }
  }
  if (token !== generation) return;
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'read-1',
    name: 'read_file',
    status: 'failed',
    kind: 'read',
    title: 'File a.ts',
    rawInput: { Path: target },
    rawOutput: 'step error',
  });
  try {
    const permission = await request('session/request_permission', {
      sessionId,
      toolCall: mcpPermission
        ? {
            sessionUpdate: 'tool_call',
            toolCallId: 'mcp-1',
            name: `mcp_enso_${mcpPermission}`,
            title: `Run mcp_enso_${mcpPermission}`,
            kind: 'other',
            status: 'pending',
            rawInput: {},
          }
        : {
            sessionUpdate: 'tool_call',
            toolCallId: 'cmd-1',
            name: 'run_command',
            args: { CommandLine: 'ls', toolSummary: 'List' },
            title: 'ls',
            kind: 'execute',
            status: 'pending',
            rawInput: { CommandLine: 'ls', toolSummary: 'List' },
          },
      // agy 1.5.18 只给这两项
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
    log({ method: 'session/request_permission', result: permission });
  } catch (error) {
    log({ method: 'session/request_permission', error: String(error) });
  }
  if (token !== generation) return;
  promptId = null;
  // agy 每段回复以 usage_update 收口：used 是当前上下文占用（FAKE_AGY_CONTEXT_USED）
  usageUpdate(sessionId, Number(process.env.FAKE_AGY_CONTEXT_USED || 7));
  // FAKE_AGY_INPUT_TOKENS：PromptResponse.usage 是整轮内部多次模型调用的累加，可以远超窗口
  const inputTokens = Number(process.env.FAKE_AGY_INPUT_TOKENS || 3);
  respond(id, {
    stopReason: 'end_turn',
    usage: { inputTokens, cachedReadTokens: 2, outputTokens: 4, totalTokens: inputTokens + 6 },
  });
}

function handle(message) {
  if (message.id !== undefined && message.method === undefined) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (!waiter) return;
    if (message.error) waiter.reject(new Error(message.error.message || 'rpc error'));
    else waiter.resolve(message.result);
    return;
  }
  const { id, method, params } = message;
  log({ method, params });
  if (method === 'initialize') {
    respond(id, {
      protocolVersion: 1,
      agentInfo: { name: 'fake-agy', version },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        ...(noAppend ? {} : { _meta: { antigravity: { systemPrompt: { append: true } } } }),
      },
    });
    return;
  }
  if (method === 'session/new' || method === 'session/resume') {
    if (signedOut) {
      fail(id, -32000, 'not signed in');
      return;
    }
    if (method === 'session/resume' && resumeFails) {
      fail(id, -32602, 'unknown session');
      return;
    }
    respond(id, {
      ...sessionResult,
      sessionId: params?.sessionId || sessionResult.sessionId,
    });
    return;
  }
  if (method === 'session/set_config_option' || method === 'session/set_mode') {
    const configId = method === 'session/set_mode' ? 'mode' : params?.configId;
    const value = method === 'session/set_mode' ? params?.modeId : params?.value;
    for (const option of sessionResult.configOptions) {
      if (option.id === configId) option.currentValue = value;
    }
    if (configId === 'mode') sessionResult.modes.currentModeId = value;
    respond(id, { configOptions: sessionResult.configOptions });
    return;
  }
  if (method === 'session/cancel') {
    generation += 1;
    cancelled = true;
    if (promptId !== null) {
      const current = promptId;
      promptId = null;
      respond(current, { stopReason: 'cancelled' });
    }
    return;
  }
  if (method === 'session/prompt') {
    if (script === 'steer') {
      void steerPrompt(id, params ?? {});
      return;
    }
    if (script === 'background') {
      void backgroundPrompt(id, params ?? {});
      return;
    }
    void handlePrompt(id, params ?? {});
    return;
  }
  if (id !== undefined) fail(id, -32601, `unknown ${method}`);
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handle(JSON.parse(trimmed));
  } catch (error) {
    log({ method: 'parse-error', error: String(error) });
  }
});
