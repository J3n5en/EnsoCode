import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai/compat';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { AGY_PROVIDER_ID } from '@shared/agy/constants';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalGate } from '../approval';
import { registerAgyProvider, streamAgy } from './provider';
import { closeAllAgySessions } from './registry';
import { setAgySessionOpener } from './runtimeHost';
import type { AgySession, AgyTurnInput, AgyTurnResult } from './session';
import { attachAgyBridgeToSession } from './sessionBridge';

const cleanups: Array<() => void> = [];
afterEach(async () => {
  setAgySessionOpener(undefined);
  await closeAllAgySessions();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type Turn = (input: AgyTurnInput) => Promise<AgyTurnResult>;

function fakeAgy(turn: Turn, onClose?: () => void): AgySession {
  return {
    phase: () => ({ phase: 'closed' }),
    sessionId: () => 'agy-1',
    resumed: false,
    turn,
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
    noContextFiles: true,
    systemPrompt: 'agy bridge test',
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
    customTools: [lookup],
  });
  attachAgyBridgeToSession(session, {
    ensoSessionId,
    cwd,
    sessionDir,
    clientVersion: '0.0.0',
    gate: new ApprovalGate(
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
