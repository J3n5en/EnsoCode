import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AssistantMessage, TranscriptContext } from '@earendil-works/pi-ai';
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
import { PLUGIN_MESSAGE_TYPE } from '@shared/extensionPlugins/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createTurnDiscardState,
  createTurnDiscardTools,
  turnDiscardExtension,
} from './turnDiscard';

const probe = (name: string, readOnlyHint: boolean): ToolDefinition =>
  ({
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {} },
    annotations: { readOnlyHint },
    execute: async () => ({
      content: [{ type: 'text', text: `${name}-OUTPUT` }],
      details: undefined,
    }),
  }) as unknown as ToolDefinition;

const model = getModel('openai', 'gpt-4o-mini');
if (!model) throw new Error('Test model is not available in the bundled Pi catalog.');

function reply(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: model!.api,
    provider: model!.provider,
    model: model!.id,
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

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function setup(plans: AssistantMessage[]) {
  const root = mkdtempSync(path.join(tmpdir(), 'enso-turn-discard-'));
  const cwd = path.join(root, 'workspace');
  const agentDir = path.join(root, 'agent');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
  vi.spyOn(runtime, 'hasConfiguredAuth').mockReturnValue(true);
  const requests: TranscriptContext[] = [];
  vi.spyOn(runtime, 'streamSimple').mockImplementation((_model, context) => {
    requests.push(context as TranscriptContext);
    const stream = createAssistantMessageEventStream();
    const message = plans.shift() ?? reply([{ type: 'text', text: 'unexpected' }]);
    stream.push({ type: 'done', reason: message.stopReason as 'stop', message });
    return stream;
  });
  const state = createTurnDiscardState();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: 'Turn discard test.',
    extensionFactories: [turnDiscardExtension(state)],
  });
  await resourceLoader.reload();
  const manager = SessionManager.create(cwd, path.join(root, 'sessions'));
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
    customTools: [probe('lookup', true), probe('mutate', false), ...createTurnDiscardTools(state)],
  });
  cleanups.push(() => {
    session.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  const deliver = async (text: string) => {
    await session.sendCustomMessage(
      { customType: PLUGIN_MESSAGE_TYPE, content: text, display: true },
      { triggerTurn: true }
    );
    await session.waitForIdle();
  };
  return { session, manager, requests, deliver };
}

const discard = (reason: string) =>
  reply([{ type: 'toolCall', id: 'd1', name: 'turn_discard', arguments: { reason } }]);

it('丢弃本轮后立即结束，后续请求只见痕迹不见投递原文与本轮消息', async () => {
  const { manager, requests, deliver } = await setup([
    discard('unrelated chip news'),
    reply([{ type: 'text', text: 'handled' }]),
  ]);

  await deliver('NVIDIA-CHIP-NEWS');
  expect(requests).toHaveLength(1);

  await deliver('EnsoCode bug report');
  expect(requests).toHaveLength(2);
  const second = JSON.stringify(requests[1]!.messages);
  expect(second).not.toContain('NVIDIA-CHIP-NEWS');
  expect(second).not.toContain('"toolCallId":"d1"');
  expect(second).not.toContain('Turn discarded');
  expect(second).toContain('unrelated chip news');
  expect(second).toContain('EnsoCode bug report');

  const raw = JSON.stringify(manager.getBranch());
  expect(raw).toContain('NVIDIA-CHIP-NEWS');
});

it('reason 可省略：照常丢弃；过长报错且不丢', async () => {
  const { manager, requests, deliver } = await setup([
    reply([{ type: 'toolCall', id: 'd1', name: 'turn_discard', arguments: {} }]),
    reply([
      { type: 'toolCall', id: 'd2', name: 'turn_discard', arguments: { reason: 'x'.repeat(301) } },
    ]),
    reply([{ type: 'text', text: 'ok' }]),
    reply([{ type: 'text', text: 'handled' }]),
  ]);
  await deliver('NVIDIA-CHIP-NEWS');
  await deliver('SECOND-NEWS');
  await deliver('EnsoCode bug report');
  const last = JSON.stringify(requests.at(-1)!.messages);
  expect(last).not.toContain('NVIDIA-CHIP-NEWS');
  expect(last).toContain('SECOND-NEWS');
  const traces = manager
    .getBranch()
    .filter((entry) => entry.type === 'context_edit' && entry.replacement !== null);
  expect(traces).toHaveLength(1);
  expect(last).toContain('[Discarded turn input');
});

const use = (name: string) => reply([{ type: 'toolCall', id: `p-${name}`, name, arguments: {} }]);

it('只读工具查过再丢：查询结果连同投递一起离开上下文', async () => {
  const { manager, requests, deliver } = await setup([
    use('lookup'),
    discard('checked, unrelated'),
    reply([{ type: 'text', text: 'handled' }]),
  ]);
  await deliver('NVIDIA-CHIP-NEWS');
  await deliver('EnsoCode bug report');
  const last = JSON.stringify(requests.at(-1)!.messages);
  expect(last).not.toContain('NVIDIA-CHIP-NEWS');
  expect(last).not.toContain('lookup-OUTPUT');
  expect(last).toContain('checked, unrelated');
  expect(manager.getBranch().some((entry) => entry.type === 'context_edit')).toBe(true);
});

it('本轮调用过有副作用的工具时 turn_discard 报错，不写 context_edit', async () => {
  const { manager, deliver } = await setup([
    use('mutate'),
    discard('nope'),
    reply([{ type: 'text', text: 'ok' }]),
  ]);
  await deliver('NVIDIA-CHIP-NEWS');
  expect(manager.getBranch().some((entry) => entry.type === 'context_edit')).toBe(false);
});

it('用户消息触发的轮次可丢弃，之后只见痕迹', async () => {
  const { session, requests } = await setup([
    discard('throwaway question'),
    reply([{ type: 'text', text: 'ok' }]),
  ]);
  await session.prompt('SIDE-QUESTION');
  await session.prompt('next');
  const last = JSON.stringify(requests.at(-1)!.messages);
  expect(last).not.toContain('SIDE-QUESTION');
  expect(last).toContain('throwaway question');
});
