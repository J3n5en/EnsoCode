import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const logPath = process.env.FAKE_AGY_LOG;
const version = process.env.FAKE_AGY_VERSION || '1.5.18';
const signedOut = process.env.FAKE_AGY_SIGNED_OUT === '1';
/** 设了就把权限请求换成 agy 对我们 Host MCP 工具发的那种：`mcp_enso_<值>` */
const mcpPermission = process.env.FAKE_AGY_MCP_PERMISSION;

function log(entry) {
  if (!logPath) return;
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
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
  respond(id, {
    stopReason: 'end_turn',
    usage: { inputTokens: 3, cachedReadTokens: 2, outputTokens: 4, totalTokens: 9 },
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
        _meta: { antigravity: { systemPrompt: { append: true } } },
      },
    });
    return;
  }
  if (method === 'session/new' || method === 'session/resume') {
    if (signedOut) {
      fail(id, -32000, 'not signed in');
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
    if (promptId !== null) {
      const current = promptId;
      promptId = null;
      respond(current, { stopReason: 'cancelled' });
    }
    return;
  }
  if (method === 'session/prompt') {
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
