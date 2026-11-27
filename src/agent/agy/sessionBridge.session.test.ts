import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai/compat';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { InlineExtension, ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AGY_PROVIDER_ID } from '@shared/agy/constants';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalGate } from '../approval';
import {
  appendSystemPromptExtension,
  SUBAGENT_CONTRACT_PROMPT,
  tailSystemPromptSection,
} from '../childContract';
import { batchSteering, steerActiveSession } from '../sessionAdapter';
import { createTodoTool } from '../todo';
import { VIZ_GUIDANCE_PROMPT, WORKSPACE_POLICY_PROMPT } from '../workspacePolicy';
import { type AcpHttpMcpServer, closeHostMcp } from './hostMcp';
import { registerAgyProvider, streamAgy } from './provider';
import { closeAllAgySessions } from './registry';
import { setAgySessionOpener } from './runtimeHost';
import type { AgyHostMcp, AgySession, AgyTurnInput, AgyTurnResult } from './session';
import { openAgySession } from './session';
import { attachAgyBridgeToSession } from './sessionBridge';
import { setAgyWorkerConfig } from './workerConfig';

const cleanups: Array<() => void> = [];
beforeEach(() => {
  // 会话由假 opener 提供，但 runtimeHost 仍先解析 agy 二进制：指向一个必然存在的文件，
  // 免得测试依赖开发机装没装 agy（CI 上没有）
  setAgyWorkerConfig({ binaryPath: process.execPath, skipPermissions: false, models: [] });
});
afterEach(async () => {
  setAgySessionOpener(undefined);
  setAgyWorkerConfig({ binaryPath: '', skipPermissions: false, models: [] });
  await closeAllAgySessions();
  await closeHostMcp();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type Turn = (input: AgyTurnInput) => Promise<AgyTurnResult>;

function fakeAgy(turn: Turn, onClose?: () => void): AgySession {
  return {
    phase: () => ({ phase: 'closed' }),
    sessionId: () => 'agy-1',
    resumed: false,
    ensoTools: [],
    turn,
    steer: () => false,
    close: async () => onClose?.(),
  };
}

function result(text: string): AgyTurnResult {
  return {
    stopReason: 'stop',
    text,
    thinking: '',
    tools: [],
    sessionId: 'agy-1',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
  };
}

interface SetupOptions {
  /** 先用 pi 内置模型开会话，之后再切到 agy */
  startOn?: 'agy' | 'other';
  plans?: AssistantMessage[];
  tools?: ToolDefinition[];
  gate?: ApprovalGate;
  /** 照 supervisor 那样挂的系统提示词扩展 */
  extensions?: InlineExtension[];
  /** 用 pi 默认的开头角色段（含 "running inside pi"）而不是自定义提示词，并读工作区的 AGENTS.md */
  piPrompt?: { agentsMd: string };
}

const other = getModel('openai', 'gpt-4o-mini');
if (!other) throw new Error('Test model is not available in the bundled Pi catalog.');

function reply(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: other!.api,
    provider: other!.provider,
    model: other!.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some((part) => part.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: Date.now(),
  };
}

const lookup = {
  name: 'lookup',
  label: 'lookup',
  description: 'lookup',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ content: [{ type: 'text', text: 'lookup-OUTPUT' }], details: undefined }),
} as unknown as ToolDefinition;

async function setup(ensoSessionId = 'enso-1', options: SetupOptions = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'agy-bridge-'));
  const cwd = path.join(root, 'workspace');
  const agentDir = path.join(root, 'agent');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  if (options.piPrompt) writeFileSync(path.join(cwd, 'AGENTS.md'), options.piPrompt.agentsMd);
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
  registerAgyProvider(runtime, []);
  vi.spyOn(runtime, 'hasConfiguredAuth').mockReturnValue(true);
  const plans = [...(options.plans ?? [])];
  vi.spyOn(runtime, 'streamSimple').mockImplementation((model, context, streamOptions) => {
    if (model.provider === AGY_PROVIDER_ID) {
      return streamAgy(model as never, context as never, streamOptions as never) as never;
    }
    const stream = createAssistantMessageEventStream();
    const message = plans.shift() ?? reply([{ type: 'text', text: 'unexpected' }]);
    stream.push({ type: 'done', reason: message.stopReason as 'stop', message });
    return stream;
  });
  const agyModel = runtime.getModel(AGY_PROVIDER_ID, 'default');
  if (!agyModel) throw new Error('agy model missing');
  const model = options.startOn === 'other' ? other : agyModel;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: !options.piPrompt,
    ...(options.piPrompt ? {} : { systemPrompt: 'agy bridge test' }),
    ...(options.extensions ? { extensionFactories: options.extensions } : {}),
  });
  await resourceLoader.reload();
  const sessionDir = path.join(root, 'sessions');
  const manager = SessionManager.create(cwd, sessionDir);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: 'off',
    resourceLoader,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
    noTools: 'builtin',
    customTools: options.tools ?? [lookup],
  });
  attachAgyBridgeToSession(session, {
    ensoSessionId,
    cwd,
    sessionDir,
    clientVersion: '0.0.0',
    gate:
      options.gate ??
      new ApprovalGate(
        'full',
        () => {},
        () => {}
      ),
    planActive: () => false,
    readRoots: () => [cwd],
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    session.dispose();
  };
  cleanups.push(() => {
    dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return { session, manager, dispose, agyModel };
}

function readTurn(input: AgyTurnInput): Promise<AgyTurnResult> {
  input.onEvent?.({ type: 'text', delta: 'Reading.' });
  input.onEvent?.({
    type: 'tool',
    id: 'read-1',
    name: 'read_file',
    status: 'in_progress',
    args: { path: '/w/a.ts' },
  });
  input.onEvent?.({
    type: 'tool',
    id: 'read-1',
    name: 'read_file',
    status: 'completed',
    args: { path: '/w/a.ts' },
    output: 'file body',
  });
  input.onEvent?.({ type: 'text', delta: 'Done.' });
  return Promise.resolve(result('Reading.Done.'));
}

type Row = { role?: string; content?: unknown; toolCallId?: string; isError?: boolean };

function shape(messages: readonly unknown[]): string[] {
  return (messages as Row[]).map((message) => {
    if (message.role === 'toolResult') return `toolResult:${message.toolCallId}`;
    if (message.role !== 'assistant') return String(message.role);
    const parts = (message.content as { type: string; text?: string; id?: string }[]).map((part) =>
      part.type === 'text' ? `text:${part.text}` : `${part.type}:${part.id ?? ''}`
    );
    return `assistant[${parts.join(',')}]`;
  });
}

function persisted(file: string): unknown[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; message?: unknown })
    .filter((entry) => entry.type === 'message')
    .map((entry) => entry.message)
    .filter((message) => (message as Row).role !== 'system');
}

it('persists agy tool calls with their results in order, and pi does not run them', async () => {
  setAgySessionOpener(async () => fakeAgy(readTurn));
  const { session, manager } = await setup();
  await session.prompt('read a.ts');
  await session.waitForIdle();

  const expected = [
    'user',
    'assistant[text:Reading.,toolCall:read-1]',
    'toolResult:read-1',
    'assistant[text:Done.]',
  ];
  const file = manager.getSessionFile();
  if (!file) throw new Error('no session file');
  expect(shape(persisted(file))).toEqual(expected);
  expect(shape(session.messages.filter((m) => (m as Row).role !== 'system'))).toEqual(expected);
  const toolResult = persisted(file)[2] as Row;
  expect(toolResult.isError).toBe(false);
  expect(JSON.stringify(toolResult.content)).toContain('file body');

  const reloaded = SessionManager.open(file).buildSessionContext().messages;
  expect(shape(reloaded.filter((m) => (m as Row).role !== 'system'))).toEqual(expected);
});

it('shows the tool call on the streaming assistant before the turn ends', async () => {
  let release: () => void = () => {};
  setAgySessionOpener(async () =>
    fakeAgy(async (input) => {
      input.onEvent?.({
        type: 'tool',
        id: 'cmd-1',
        name: 'run_command',
        status: 'in_progress',
        args: { command: 'ls' },
      });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return result('');
    })
  );
  const { session } = await setup();
  const live: string[] = [];
  session.subscribe((event) => {
    if (event.type !== 'message_update') return;
    const parts = (event.message as { content: { type: string; id?: string }[] }).content;
    if (parts.some((part) => part.type === 'toolCall' && part.id === 'cmd-1')) {
      live.push('toolCall');
      release();
    }
  });
  await session.prompt('list');
  await session.waitForIdle();
  expect(live.length).toBeGreaterThan(0);
  const names = shape(session.messages.filter((m) => (m as Row).role !== 'system'));
  expect(names).toEqual(['user', 'assistant[toolCall:cmd-1]', 'toolResult:cmd-1', 'assistant[]']);
});

it('closes its agy session when the pi session is disposed', async () => {
  let closed = 0;
  setAgySessionOpener(async () => fakeAgy(readTurn, () => (closed += 1)));
  const { session, dispose } = await setup('enso-child-a');
  await session.prompt('read a.ts');
  await session.waitForIdle();
  dispose();
  await vi.waitFor(() => expect(closed).toBe(1));
});

it('leaves tool calls of other providers to pi', async () => {
  const { session } = await setup();
  const message = {
    role: 'assistant',
    api: 'anthropic-messages',
    content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: {} }],
  };
  const before = session.messages.length;
  // 直接经 pi 的事件出口：bridge 只认 agy 的消息
  (session as unknown as { _emit(event: unknown): void })._emit({ type: 'message_end', message });
  expect(message.content).toHaveLength(1);
  expect(session.messages.length).toBe(before);
});

it('leaves a session on another model alone, then runs agy after a mid-session switch', async () => {
  setAgySessionOpener(async () => fakeAgy(readTurn));
  const { session, manager, agyModel } = await setup('enso-switch', {
    startOn: 'other',
    plans: [
      reply([{ type: 'toolCall', id: 't1', name: 'lookup', arguments: {} }]),
      reply([{ type: 'text', text: 'ok' }]),
    ],
  });
  await session.prompt('first');
  await session.waitForIdle();
  await session.setModel(agyModel);
  await session.prompt('read a.ts');
  await session.waitForIdle();
  const file = manager.getSessionFile();
  if (!file) throw new Error('no session file');
  expect(shape(persisted(file))).toEqual([
    'user',
    'assistant[toolCall:t1]',
    'toolResult:t1',
    'assistant[text:ok]',
    'user',
    'assistant[text:Reading.,toolCall:read-1]',
    'toolResult:read-1',
    'assistant[text:Done.]',
  ]);
  expect(JSON.stringify(persisted(file)[2])).toContain('lookup-OUTPUT');
});

const noteCalls: unknown[] = [];
const note = {
  name: 'note',
  label: 'note',
  description: 'Keep a note for the user.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  execute: async (_id: string, params: { text: string }) => {
    noteCalls.push(params);
    return {
      content: [{ type: 'text', text: `noted ${params.text}` }],
      details: { kept: params.text },
    };
  },
} as unknown as ToolDefinition;

/** 同一个工具换个名字：核心工具名（直挂）或插件式名字（懒加载） */
function named(tool: ToolDefinition, name: string): ToolDefinition {
  return { ...tool, name, label: name } as ToolDefinition;
}
const todoNote = named(note, 'todo');

async function mcpClient(server: AcpHttpMcpServer) {
  const client = new Client({ name: 'fake-agy', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: {
        headers: Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
      },
    })
  );
  return client;
}

it('runs an Enso tool agy calls over Host MCP as one Enso card, persisted with its details', async () => {
  noteCalls.length = 0;
  const offered: AgyHostMcp[] = [];
  const listed: string[] = [];
  const called: unknown[] = [];
  let revoked = false;
  setAgySessionOpener(async (options) => {
    const hostMcp = options.hostMcp;
    if (!hostMcp) throw new Error('no host MCP offered');
    offered.push(hostMcp);
    const grant = await hostMcp.issue();
    return {
      ...fakeAgy(async (input) => {
        input.onEvent?.({ type: 'text', delta: 'Noting.' });
        const client = await mcpClient(grant.server);
        listed.push(...(await client.listTools()).tools.map((tool) => tool.name));
        called.push(await client.callTool({ name: 'todo', arguments: { text: 'milk' } }));
        await client.close();
        input.onEvent?.({ type: 'text', delta: 'Done.' });
        return result('Noting.Done.');
      }),
      ensoTools: hostMcp.tools,
      close: async () => {
        grant.revoke();
        revoked = true;
      },
    };
  });
  const { session, manager, dispose } = await setup('enso-mcp', { tools: [lookup, todoNote] });
  const cards: string[] = [];
  session.subscribe((event) => {
    if (event.type === 'tool_execution_start') cards.push(event.toolName);
  });
  await session.prompt('note milk');
  await session.waitForIdle();

  // lookup 不是核心工具：不直挂，经 enso_tool_search / enso_tool_call 才够得着
  expect(offered[0]?.tools).toEqual(['todo', 'enso_tool_search', 'enso_tool_call']);
  expect(listed).toEqual(['todo', 'enso_tool_search', 'enso_tool_call']);
  expect(noteCalls).toEqual([{ text: 'milk' }]);
  expect(called).toEqual([{ content: [{ type: 'text', text: 'noted milk' }] }]);
  expect(cards).toEqual(['todo']);
  const file = manager.getSessionFile();
  if (!file) throw new Error('no session file');
  const rows = persisted(file) as Array<Row & { toolName?: string; details?: unknown }>;
  expect(shape(rows)).toEqual([
    'user',
    expect.stringMatching(/^assistant\[text:Noting\.,toolCall:enso_[\w-]+\]$/),
    expect.stringMatching(/^toolResult:enso_/),
    'assistant[text:Done.]',
  ]);
  const toolCall = (rows[1]!.content as { type: string; name?: string; arguments?: unknown }[])[1];
  expect(toolCall).toMatchObject({ name: 'todo', arguments: { text: 'milk' } });
  expect(rows[2]).toMatchObject({
    toolName: 'todo',
    isError: false,
    details: { kept: 'milk' },
    content: [{ type: 'text', text: 'noted milk' }],
  });
  dispose();
  await vi.waitFor(() => expect(revoked).toBe(true));
});

it('ends the Host-MCP todo with its details mid-turn; the persisted toolResult keeps them after the turn', async () => {
  const todos = [
    { content: 'write tests', status: 'in_progress' },
    { content: 'ship', status: 'pending' },
  ];
  const seen: Array<{ type: string; toolName?: unknown; result?: { details?: unknown } }> = [];
  let midTurn: typeof seen = [];
  setAgySessionOpener(async (options) => {
    const hostMcp = options.hostMcp;
    if (!hostMcp) throw new Error('no host MCP offered');
    const grant = await hostMcp.issue();
    return {
      ...fakeAgy(async (input) => {
        const client = await mcpClient(grant.server);
        await client.callTool({ name: 'todo', arguments: { todos } });
        await client.close();
        // 本轮 assistant 还没收尾（toolResult 未落盘）时看到的事件
        midTurn = [...seen];
        input.onEvent?.({ type: 'text', delta: 'Listed.' });
        return result('Listed.');
      }),
      ensoTools: hostMcp.tools,
      close: async () => grant.revoke(),
    };
  });
  const { session, manager } = await setup('enso-mcp-todo', { tools: [createTodoTool()] });
  session.subscribe((event) => {
    seen.push(event as unknown as (typeof seen)[number]);
  });
  await session.prompt('list it');
  await session.waitForIdle();

  const end = midTurn.find((event) => event.type === 'tool_execution_end');
  expect(end).toMatchObject({ toolName: 'todo', result: { details: { todos } } });
  expect(
    midTurn.some(
      (event) =>
        event.type === 'message_end' &&
        (event as { message?: { role?: string } }).message?.role === 'toolResult'
    )
  ).toBe(false);
  const file = manager.getSessionFile();
  if (!file) throw new Error('no session file');
  const rows = persisted(file) as Array<Row & { toolName?: string; details?: unknown }>;
  expect(rows.find((row) => row.role === 'toolResult')).toMatchObject({
    toolName: 'todo',
    details: { todos },
  });
});

it('reaches a lazy plugin tool through enso_tool_search and enso_tool_call, shown as the real tool', async () => {
  noteCalls.length = 0;
  const outputs: Record<string, unknown> = {};
  setAgySessionOpener(async (options) => {
    const hostMcp = options.hostMcp;
    if (!hostMcp) throw new Error('no host MCP offered');
    const grant = await hostMcp.issue();
    return {
      ...fakeAgy(async (input) => {
        const client = await mcpClient(grant.server);
        const call = (name: string, args: Record<string, unknown>) =>
          client.callTool({ name, arguments: args });
        outputs.list = await call('enso_tool_search', {});
        outputs.search = await call('enso_tool_search', { query: 'note' });
        outputs.called = await call('enso_tool_call', {
          name: 'tg_note',
          arguments: '{"text":"milk"}',
        });
        outputs.eagerName = await call('enso_tool_call', { name: 'todo', arguments: {} });
        outputs.hidden = await call('enso_tool_call', { name: 'bash', arguments: {} });
        outputs.lazyDirect = await call('tg_note', { text: 'x' });
        await client.close();
        input.onEvent?.({ type: 'text', delta: 'Done.' });
        return result('Done.');
      }),
      ensoTools: hostMcp.tools,
      close: async () => grant.revoke(),
    };
  });
  const bash = named(lookup, 'bash');
  const { session, manager } = await setup('enso-lazy', {
    tools: [todoNote, named(note, 'tg_note'), bash],
  });
  const cards: Array<{ name: string; args: unknown }> = [];
  session.subscribe((event) => {
    if (event.type === 'tool_execution_start')
      cards.push({ name: event.toolName, args: event.args });
  });
  await session.prompt('note milk via the plugin');
  await session.waitForIdle();

  const text = (value: unknown) =>
    ((value as { content: { text: string }[] }).content ?? []).map((part) => part.text).join('');
  expect(text(outputs.list)).toContain('- tg_note: Keep a note for the user.');
  expect(text(outputs.list)).not.toContain('bash');
  expect(JSON.parse(text(outputs.search))).toEqual([
    {
      name: 'tg_note',
      description: 'Keep a note for the user.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  ]);
  expect(outputs.called).toEqual({ content: [{ type: 'text', text: 'noted milk' }] });
  expect(noteCalls).toEqual([{ text: 'milk' }]);
  expect(outputs.eagerName).toMatchObject({ isError: true });
  expect(text(outputs.eagerName)).toContain('call it as mcp_enso_todo');
  expect(outputs.hidden).toMatchObject({ isError: true });
  expect(outputs.lazyDirect).toMatchObject({ isError: true });
  // 卡片只有真实工具，参数是解开后的对象
  expect(cards).toEqual([{ name: 'tg_note', args: { text: 'milk' } }]);
  const file = manager.getSessionFile();
  if (!file) throw new Error('no session file');
  const rows = persisted(file) as Array<Row & { toolName?: string; details?: unknown }>;
  expect(JSON.stringify(rows)).not.toContain('enso_tool_call');
  expect(JSON.stringify(rows)).not.toContain('enso_tool_search');
  const toolCall = (rows[1]!.content as { type: string; name?: string; arguments?: unknown }[])[0];
  expect(toolCall).toMatchObject({ name: 'tg_note', arguments: { text: 'milk' } });
  expect(rows[2]).toMatchObject({ toolName: 'tg_note', details: { kept: 'milk' }, isError: false });
  expect(rows.filter((row) => row.role === 'toolResult')).toHaveLength(1);
});

const fakeCli = fileURLToPath(new URL('./fixtures/fakeAgy.mjs', import.meta.url));

function useFakeCli(env: Record<string, string>) {
  setAgySessionOpener((options) =>
    openAgySession({
      ...options,
      command: process.execPath,
      args: [fakeCli],
      env: { ...process.env, ...env },
      timeoutMs: 8_000,
    })
  );
}

it('splits a mid-turn steer into its own user message and answer, as pi expects', async () => {
  useFakeCli({ FAKE_AGY_SCRIPT: 'steer' });
  const { session, manager } = await setup('enso-steer');
  batchSteering(session);
  let steered: Promise<unknown> | undefined;
  session.subscribe((event) => {
    if (steered || event.type !== 'message_update') return;
    if (event.assistantMessageEvent.type !== 'text_delta') return;
    steered = steerActiveSession(session, 'Stop. Reply steered', undefined, () => {});
  });
  await session.prompt('Tell a story');
  await session.waitForIdle();
  expect(await steered).toBe('queued');

  const file = manager.getSessionFile();
  if (!file) throw new Error('no session file');
  const expected = ['user', 'assistant[text:Once upon a time.]', 'user', 'assistant[text:steered]'];
  expect(shape(persisted(file))).toEqual(expected);
  expect(shape(session.messages.filter((m) => (m as Row).role !== 'system'))).toEqual(expected);
  const rows = persisted(file) as Array<Row & { usage?: { totalTokens: number } }>;
  expect(JSON.stringify(rows[2]?.content)).toContain('Stop. Reply steered');
  // 第二段以 usage_update(12) 收口：占用是 agy 当前上下文，不是 PromptResponse 的整轮累加 90
  expect(rows[3]?.usage?.totalTokens).toBe(12);
});

it('keeps the turn open for a background command and lands its follow-up in the same turn', async () => {
  useFakeCli({ FAKE_AGY_SCRIPT: 'background' });
  const { session, manager } = await setup('enso-background');
  const ends: string[] = [];
  session.subscribe((event) => {
    if (event.type === 'tool_execution_end') ends.push(String(event.toolCallId));
  });
  await session.prompt('run it in the background');
  await session.waitForIdle();
  expect(ends).toEqual(['bg-1']);
  const file = manager.getSessionFile();
  if (!file) throw new Error('no session file');
  const rows = persisted(file);
  expect(shape(rows)).toEqual([
    'user',
    'assistant[text:Starting.,toolCall:bg-1]',
    'toolResult:bg-1',
    'assistant[text:It printed done.]',
  ]);
  expect(rows[2]).toMatchObject({ isError: false, content: [{ type: 'text', text: 'done\n' }] });
}, 15_000);

it('reopens agy with resume when the Enso tool set changes, so it lists the new tools', async () => {
  const opened: Array<{ tools: readonly string[]; resume?: string }> = [];
  let closed = 0;
  setAgySessionOpener(async (options) => {
    opened.push({ tools: options.hostMcp?.tools ?? [], resume: options.resumeSessionId });
    return fakeAgy(
      async () => result('ok'),
      () => (closed += 1)
    );
  });
  const { session } = await setup('enso-hotplug', {
    tools: [named(lookup, 'ask_user'), todoNote],
  });
  await session.prompt('one');
  await session.waitForIdle();
  await session.prompt('two');
  await session.waitForIdle();
  expect(opened).toHaveLength(1);
  session.setActiveToolsByName(['ask_user']);
  await session.prompt('three');
  await session.waitForIdle();
  expect(closed).toBe(1);
  expect(opened).toEqual([
    { tools: ['ask_user', 'todo'], resume: undefined },
    { tools: ['ask_user'], resume: 'agy-1' },
  ]);
});

it('keys the agy process on what is listed directly: lazy tools and over-budget core do not reopen it', async () => {
  const opened: Array<{ tools: readonly string[]; resume?: string }> = [];
  let closed = 0;
  setAgySessionOpener(async (options) => {
    opened.push({ tools: options.hostMcp?.tools ?? [], resume: options.resumeSessionId });
    return fakeAgy(
      async () => result('ok'),
      () => (closed += 1)
    );
  });
  const big = (name: string, kb: number) =>
    ({ ...lookup, name, label: name, description: 'x'.repeat(kb * 1000) }) as ToolDefinition;
  const { session } = await setup('enso-budget', {
    tools: [big('subagent', 20), big('workflow', 15), lookup, named(lookup, 'tg_plugin')],
  });
  await session.prompt('one');
  await session.waitForIdle();
  // 懒加载的插件工具关掉：直挂的没变，不换进程
  session.setActiveToolsByName(['subagent', 'workflow', 'lookup']);
  await session.prompt('two');
  await session.waitForIdle();
  expect(closed).toBe(0);
  // subagent 关掉，腾出的预算让 workflow 直挂：换进程 resume
  session.setActiveToolsByName(['workflow', 'lookup']);
  await session.prompt('three');
  await session.waitForIdle();
  expect(closed).toBe(1);
  expect(opened).toEqual([
    { tools: ['subagent', 'enso_tool_search', 'enso_tool_call'], resume: undefined },
    { tools: ['workflow', 'enso_tool_search', 'enso_tool_call'], resume: 'agy-1' },
  ]);
});

// 真机：AGY_LIVE=1 pnpm vitest run src/agent/agy/sessionBridge.session.test.ts -t live
function useLiveCli(name: string): { out: string; wire: string } {
  const out = process.env.AGY_LIVE_OUT || path.join(tmpdir(), 'agy-live');
  mkdirSync(out, { recursive: true });
  const wire = path.join(out, `wire-${name}.jsonl`);
  writeFileSync(wire, '');
  const tap = fileURLToPath(new URL('./fixtures/wireTap.mjs', import.meta.url));
  setAgySessionOpener((options) =>
    openAgySession({
      ...options,
      command: process.execPath,
      args: [tap, wire, options.command, ...options.args],
      timeoutMs: 90_000,
    })
  );
  return { out, wire };
}

// 真机：一条 prompt 加一条插话。插话走 Enso 的可撤回插话入口。
it.runIf(process.env.AGY_LIVE === '1')(
  'live steer: the steer lands as its own user message and answer in the jsonl',
  async () => {
    const { out } = useLiveCli('bridge-steer');
    const { session, manager } = await setup('enso-live-steer');
    batchSteering(session);
    let steered: Promise<unknown> | undefined;
    session.subscribe((event) => {
      if (steered || event.type !== 'message_update') return;
      if (event.assistantMessageEvent.type !== 'text_delta') return;
      steered = steerActiveSession(
        session,
        'Stop the story. Reply with only the word: steered',
        undefined,
        () => {}
      );
    });
    await session.prompt('Write a 250-word story about a lighthouse keeper.');
    await session.waitForIdle();
    const file = manager.getSessionFile();
    if (!file) throw new Error('no session file');
    const rows = persisted(file);
    writeFileSync(
      path.join(out, 'bridge-steer.json'),
      `${JSON.stringify({ steered: await steered, shape: shape(rows), rows }, null, 2)}\n`
    );
    expect(await steered).toBe('queued');
    expect(rows.map((row) => (row as Row).role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(JSON.stringify((rows[3] as Row).content).toLowerCase()).toContain('steered');
  },
  300_000
);

// 真机：一条 prompt，让 agy 把命令放到后台跑。
it.runIf(process.env.AGY_LIVE === '1')(
  'live background: a command agy runs in the background keeps the turn open until it reports',
  async () => {
    const { out } = useLiveCli('bridge-background');
    const gate = new ApprovalGate(
      'full',
      () => {},
      () => {}
    );
    const { session, manager } = await setup('enso-live-background', { gate });
    const started = Date.now();
    await session.prompt(
      'Start the shell command `sleep 8 && echo bg-done` as a background command without waiting for it, reply "started", and after it finishes tell me its output.'
    );
    await session.waitForIdle();
    const file = manager.getSessionFile();
    if (!file) throw new Error('no session file');
    const rows = persisted(file);
    writeFileSync(
      path.join(out, 'bridge-background.json'),
      `${JSON.stringify({ ms: Date.now() - started, shape: shape(rows), rows }, null, 2)}\n`
    );
  },
  300_000
);

// 真机：一条 prompt。supervised + 无人值守自动拒绝：只有我们自己的 MCP 工具会被放行。
it.runIf(process.env.AGY_LIVE === '1')(
  'live: agy calls the Enso todo tool over Host MCP, one Enso card, consistent jsonl',
  async () => {
    const out = process.env.AGY_LIVE_OUT || path.join(tmpdir(), 'agy-live');
    mkdirSync(out, { recursive: true });
    const wire = path.join(out, 'wire-bridge-todo.jsonl');
    writeFileSync(wire, '');
    const tap = fileURLToPath(new URL('./fixtures/wireTap.mjs', import.meta.url));
    setAgySessionOpener((options) =>
      openAgySession({
        ...options,
        command: process.execPath,
        args: [tap, wire, options.command, ...options.args],
        timeoutMs: 90_000,
      })
    );
    const gate = new ApprovalGate(
      'supervised',
      () => {},
      () => {},
      { autoReject: true }
    );
    const { session, manager } = await setup('enso-live-todo', {
      tools: [createTodoTool()],
      gate,
    });
    const events: Array<{ type: string; toolName?: unknown; toolCallId?: unknown }> = [];
    session.subscribe((event) => {
      if (event.type.startsWith('tool_execution'))
        events.push(event as unknown as (typeof events)[number]);
    });
    await session.prompt(
      'Use the todo tool once to record exactly two items: "write tests" (in_progress) and "ship" (pending). Then reply with the single word: done'
    );
    await session.waitForIdle();
    const file = manager.getSessionFile();
    if (!file) throw new Error('no session file');
    const rows = persisted(file);
    writeFileSync(
      path.join(out, 'bridge-todo.json'),
      `${JSON.stringify({ events, shape: shape(rows), rows }, null, 2)}\n`
    );
    const starts = events.filter((event) => event.type === 'tool_execution_start');
    expect(starts.map((event) => event.toolName)).toEqual(['todo']);
    expect(JSON.stringify(rows)).not.toContain('mcp_enso_');
    const result = rows.find((row) => (row as Row).role === 'toolResult') as
      | (Row & { toolName?: string; details?: { todos?: unknown[] } })
      | undefined;
    expect(result?.toolName).toBe('todo');
    expect(result?.details?.todos).toHaveLength(2);
    expect(rows.filter((row) => (row as Row).role === 'toolResult')).toHaveLength(1);
  },
  300_000
);

describe('Enso system append handed to agy', () => {
  const ensoExtensions = (child: boolean): InlineExtension[] => [
    appendSystemPromptExtension('workspace-policy', WORKSPACE_POLICY_PROMPT),
    appendSystemPromptExtension('viz-guidance', VIZ_GUIDANCE_PROMPT),
    ...(child ? [appendSystemPromptExtension('subagent-contract', SUBAGENT_CONTRACT_PROMPT)] : []),
    tailSystemPromptSection('preset_tail', 'PRESET-TAIL-MARKER'),
  ];

  async function appendFor(child: boolean) {
    const atOpen: Array<string | undefined> = [];
    const atTurn: Array<string | undefined> = [];
    setAgySessionOpener(async (options) => {
      atOpen.push(options.systemAppend);
      return fakeAgy(async (input) => {
        atTurn.push(input.systemAppend);
        return result('ok');
      });
    });
    const { session } = await setup(child ? 'enso-child' : 'enso-top', {
      extensions: ensoExtensions(child),
      piPrompt: { agentsMd: 'AGENTS-MD-MARKER' },
    });
    await session.prompt('draw a chart');
    await session.waitForIdle();
    // pi 那边确实带着这些段，agy 这边才有得剔
    expect(session.systemPrompt).toContain('running inside pi');
    expect(session.systemPrompt).toContain('AGENTS-MD-MARKER');
    expect(session.systemPrompt).toContain('<tools>');
    expect(atOpen).toHaveLength(1);
    expect(atTurn).toEqual(atOpen);
    return atOpen[0] ?? '';
  }

  it('carries workspace policy, html-viz guidance and preset tail, nothing of pi', async () => {
    const text = await appendFor(false);
    expect(text).toContain('# Working in the workspace');
    expect(text).toContain('```html-viz');
    expect(text).toContain('<preset_tail>\nPRESET-TAIL-MARKER\n</preset_tail>');
    expect(text).not.toContain('Delegated agent contract');
    for (const banned of [
      'running inside pi',
      '<skills>',
      '<rules>',
      '<tools>',
      '<project_context>',
      'AGENTS-MD-MARKER',
      '<cwd>',
    ]) {
      expect(text).not.toContain(banned);
    }
  });

  it('adds the subagent contract only for a child session', async () => {
    const text = await appendFor(true);
    expect(text).toContain('# Delegated agent contract');
    expect(text).toContain('```html-viz');
    expect(text).not.toContain('running inside pi');
  });
});
