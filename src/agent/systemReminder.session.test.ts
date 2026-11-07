import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai/compat';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import {
  createAgentSession,
  DefaultResourceLoader,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';
import { CodemodeHost } from './codemode';
import { SystemReminderRegistry, systemReminderExtension } from './systemReminder';

const model = getModel('openai', 'gpt-4o-mini');
if (!model) throw new Error('Test model is not available in the bundled Pi catalog.');

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function assistant(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason']
) {
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
    stopReason,
    timestamp: Date.now(),
  } satisfies AssistantMessage;
}

const extensionTool: InlineExtension = {
  name: 'extension-tool',
  factory: (pi) => {
    pi.registerTool({
      name: 'probe',
      label: 'probe',
      description: 'probe',
      parameters: { type: 'object', properties: {} } as never,
      defaultActive: true,
      execute: async () => ({ content: [{ type: 'text', text: 'raw' }], details: undefined }),
    });
  },
};

async function runSession(firstCall: { name: string; arguments: { [key: string]: string } }) {
  const root = mkdtempSync(path.join(tmpdir(), 'enso-reminder-'));
  const agentDir = path.join(root, 'agent');
  mkdirSync(agentDir, { recursive: true });
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
  vi.spyOn(runtime, 'hasConfiguredAuth').mockReturnValue(true);
  let calls = 0;
  vi.spyOn(runtime, 'streamSimple').mockImplementation(() => {
    const stream = createAssistantMessageEventStream();
    const message =
      calls++ === 0
        ? assistant([{ type: 'toolCall', id: 'call_1', ...firstCall }], 'toolUse')
        : assistant([{ type: 'text', text: 'done' }], 'stop');
    stream.push({ type: 'done', reason: message.stopReason as 'stop', message });
    return stream;
  });
  const registry = new SystemReminderRegistry();
  const pending = ['task-1 finished'];
  registry.register('background-task', () => pending.splice(0));
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: 'Reminder test.',
    extensionFactories: [
      new CodemodeHost({ codemode: true, deferredServers: [] }).extension,
      extensionTool,
      systemReminderExtension(registry),
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: 'off',
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
    noTools: 'builtin',
  });
  cleanups.push(() => {
    session.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  await session.prompt('go');
  const persisted = session.sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === 'message' && entry.message.role === 'toolResult' ? [entry.message] : []
    );
  return { persisted, pending };
}

function textOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content.map((part) => part.text ?? '').join('');
}

it('扩展注册的工具结果带上待投递提醒，并写进会话记录', async () => {
  const { persisted, pending } = await runSession({ name: 'probe', arguments: {} });
  expect(persisted).toHaveLength(1);
  expect(persisted[0].content).toEqual([
    { type: 'text', text: '<system-reminder>\ntask-1 finished\n</system-reminder>\n\nraw' },
  ]);
  expect(pending).toEqual([]);
});

it('codemode 结果带上提醒；脚本里的嵌套调用拿不到提醒', async () => {
  const { persisted, pending } = await runSession({
    name: 'codemode',
    arguments: { code: 'const r = await tools.probe({}); return JSON.stringify(r);' },
  });
  expect(persisted).toHaveLength(1);
  const text = textOf(persisted[0].content);
  expect(text.startsWith('<system-reminder>\ntask-1 finished\n</system-reminder>')).toBe(true);
  expect(text.match(/task-1 finished/g)).toHaveLength(1);
  expect(text).toContain('raw');
  expect(pending).toEqual([]);
});
