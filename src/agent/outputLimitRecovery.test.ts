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
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OUTPUT_LIMIT_RECOVERY_ATTEMPTS,
  OUTPUT_LIMIT_RESUME,
  outputLimitRecovery,
  outputLimitRecoveryExtension,
} from './outputLimitRecovery';

describe('outputLimitRecovery', () => {
  const base = {
    outcome: 'completed',
    stopReason: 'length',
    outputTokens: 8192,
    modelMaxTokens: 8192,
    toolResultCount: 0,
    attempts: 0,
  };

  it('纯文本在模型输出上限处被截断：续写', () => {
    expect(outputLimitRecovery(base)).toBe('resume');
  });

  it('续写次数用完、正常结束、被中断或出错时不处理', () => {
    expect(outputLimitRecovery({ ...base, attempts: OUTPUT_LIMIT_RECOVERY_ATTEMPTS })).toBe(
      undefined
    );
    expect(outputLimitRecovery({ ...base, stopReason: 'stop' })).toBe(undefined);
    expect(outputLimitRecovery({ ...base, outcome: 'aborted' })).toBe(undefined);
    expect(outputLimitRecovery({ ...base, outcome: 'error' })).toBe(undefined);
  });

  it('输出未达模型上限（被上下文挤压，pi 自己压缩重试）时不处理', () => {
    expect(outputLimitRecovery({ ...base, outputTokens: 1000 })).toBe(undefined);
  });

  it('截断的回复里有工具调用（已被 pi 拒绝执行）：追加拆分指导而不是续写', () => {
    expect(outputLimitRecovery({ ...base, toolResultCount: 1 })).toBe('split');
  });
});

const model = getModel('openai', 'gpt-4o-mini');
if (!model) throw new Error('Test model is not available in the bundled Pi catalog.');

function reply(text: string, stopReason: 'stop' | 'length', output: number): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: model!.api,
    provider: model!.provider,
    model: model!.id,
    usage: {
      input: 0,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

it('会话内：截断后自动追加续写提示并发起下一轮，最多续写固定次数', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'enso-output-limit-'));
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
    const message = reply(`part-${requests.length}`, 'length', model!.maxTokens);
    stream.push({ type: 'done', reason: 'length', message });
    return stream;
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: 'Output limit test.',
    extensionFactories: [outputLimitRecoveryExtension],
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
  });
  cleanups.push(() => {
    session.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  await session.prompt('Write a long essay.');

  expect(requests).toHaveLength(1 + OUTPUT_LIMIT_RECOVERY_ATTEMPTS);
  const second = JSON.stringify(requests[1]!.messages);
  expect(second).toContain('part-1');
  expect(second).toContain('Resume directly');
  expect(
    manager
      .getBranch()
      .filter((entry) => entry.type === 'custom_message' && entry.content === OUTPUT_LIMIT_RESUME)
  ).toHaveLength(OUTPUT_LIMIT_RECOVERY_ATTEMPTS);

  // 新的一次运行重新计数
  await session.prompt('Again.');
  expect(requests).toHaveLength(2 * (1 + OUTPUT_LIMIT_RECOVERY_ATTEMPTS));
});
