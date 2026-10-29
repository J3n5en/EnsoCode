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
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

const model = getModel('openai', 'gpt-4o-mini');
if (!model) throw new Error('Test model is not available in the bundled Pi catalog.');

const usage = (output: number): AssistantMessage['usage'] => ({
  input: 100,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 100 + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const assistant = (
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason']
): AssistantMessage => ({
  role: 'assistant',
  content,
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: usage(10),
  stopReason,
  timestamp: Date.now(),
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Pi 1.4.0 已原生修复 length 截断回复恢复后的孤立 toolResult；此测试保护升级后的配对省略行为。
//
// Pi 1.4.0 natively fixes orphaned tool results after length recovery; keep this regression for paired omission.
it('prompt 前恢复 length 截断回复时，连同其 toolResult 一起移出上下文', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'enso-recovery-omission-'));
  roots.push(root);
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
    const message = assistant([{ type: 'text', text: 'ok' }], 'stop');
    stream.push({ type: 'done', reason: 'stop', message });
    return stream;
  });

  const manager = SessionManager.create(cwd, path.join(root, 'sessions'));
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'write' }], timestamp: 1 });
  manager.appendMessage(
    assistant([{ type: 'toolCall', id: 'call_1', name: 'write', arguments: {} }], 'length')
  );
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'call_1',
    toolName: 'write',
    content: [{ type: 'text', text: 'not executed: output token limit' }],
    isError: true,
    timestamp: Date.now(),
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: 'Recovery omission test.',
  });
  await resourceLoader.reload();
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
      compaction: { enabled: true },
    }),
    noTools: 'builtin',
  });
  try {
    await session.prompt('continue');
  } finally {
    session.dispose();
  }

  const omitted = manager
    .getBranch()
    .flatMap((entry) =>
      entry.type === 'context_edit' && entry.replacement === null
        ? [manager.getEntry(entry.targetId)]
        : []
    )
    .map((entry) => (entry?.type === 'message' ? entry.message.role : undefined));
  expect(omitted).toEqual(['assistant', 'toolResult']);
  expect(requests.at(-1)?.messages.some((m) => m.role === 'toolResult')).toBe(false);
});
