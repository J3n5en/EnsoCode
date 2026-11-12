import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AssistantMessage, TranscriptContext } from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai/compat';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { afterEach, expect, it, vi } from 'vitest';
import {
  MICROCOMPACT_IDLE_MS,
  MICROCOMPACT_PLACEHOLDER,
  microcompactExtension,
} from './microcompact';

const model = getModel('openai', 'gpt-4o-mini');
if (!model) throw new Error('Test model is not available in the bundled Pi catalog.');

const read: ToolDefinition = {
  name: 'read',
  label: 'Read',
  description: 'Read a file.',
  parameters: Type.Object({ path: Type.String() }),
  execute: async (_id, params) => ({
    content: [{ type: 'text', text: `OUT-${(params as { path: string }).path}` }],
    details: undefined,
  }),
};

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

it('缓存冷却后的下一回合：旧读取结果在请求里换成占位，并以 context_edit 持久化', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'enso-microcompact-'));
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
  const plans = [
    ...Array.from({ length: 6 }, (_, i) =>
      reply([{ type: 'toolCall', id: `r${i}`, name: 'read', arguments: { path: `f${i}` } }])
    ),
    reply([{ type: 'text', text: 'read all' }]),
    reply([{ type: 'text', text: 'welcome back' }]),
  ];
  const requests: TranscriptContext[] = [];
  vi.spyOn(runtime, 'streamSimple').mockImplementation((_model, context) => {
    requests.push(context as TranscriptContext);
    const stream = createAssistantMessageEventStream();
    const message = plans.shift() ?? reply([{ type: 'text', text: 'unexpected' }]);
    stream.push({ type: 'done', reason: message.stopReason as 'stop', message });
    return stream;
  });
  let skew = 0;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: 'Microcompact test.',
    extensionFactories: [microcompactExtension(() => Date.now() + skew)],
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
    customTools: [read],
  });
  cleanups.push(() => {
    session.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  await session.prompt('Read six files.');
  expect(JSON.stringify(requests.at(-1)!.messages)).toContain('OUT-f0');

  skew = MICROCOMPACT_IDLE_MS + 1;
  await session.prompt('Back after lunch.');

  const sent = JSON.stringify(requests.at(-1)!.messages);
  expect(sent).not.toContain('OUT-f0');
  expect(sent).toContain('OUT-f1');
  expect(sent).toContain(MICROCOMPACT_PLACEHOLDER);
  const edits = manager.getBranch().filter((entry) => entry.type === 'context_edit');
  expect(edits).toHaveLength(1);
  const projected = JSON.stringify(manager.buildSessionProjection().messages);
  expect(projected).not.toContain('OUT-f0');
  expect(projected).toContain(MICROCOMPACT_PLACEHOLDER);
});
