import type { Api, Message, Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@shared/piAccounts', () => ({ ensureAccountProvider: vi.fn() }));

import {
  createVirtualChooser,
  latestUserText,
  nextTier,
  parseJudgeReply,
  resolveClassifierModel,
} from './virtualClassifier';
import type { VirtualMembers } from './virtualModels';

const model = (id: string) => ({ id, provider: 'p', input: ['text'] }) as unknown as Model<Api>;
const members: VirtualMembers = { primary: model('strong'), fast: model('weak'), fallbacks: [] };
const user = (text: string) =>
  ({ role: 'user', content: [{ type: 'text', text }], timestamp: 0 }) as Message;
const request = (state?: object, messages: Message[] = [user('fix the bug')]) =>
  ({ model: model('auto'), thinkingLevel: 'high', reason: 'user', messages, state }) as never;
const runtime = {} as ModelRuntime;
const reply = {
  role: 'assistant',
  content: [],
  stopReason: 'stop',
  timestamp: 0,
} as unknown as Message;

describe('virtualClassifier', () => {
  it('滞回：升档立即生效，降档要连续两轮 simple', () => {
    expect(nextTier('complex', { tier: 'simple', simpleStreak: 3 })).toEqual({
      tier: 'complex',
      simpleStreak: 0,
    });
    expect(nextTier('simple', { tier: 'complex', simpleStreak: 0 })).toEqual({
      tier: 'complex',
      simpleStreak: 1,
    });
    expect(nextTier('simple', { tier: 'complex', simpleStreak: 1 })).toEqual({
      tier: 'simple',
      simpleStreak: 2,
    });
    expect(nextTier('simple', undefined)).toEqual({ tier: 'simple', simpleStreak: 1 });
  });

  it('解析裁判回复与本轮用户文本', () => {
    expect(parseJudgeReply(' complex.')).toBe('complex');
    expect(parseJudgeReply('SIMPLE')).toBe('simple');
    expect(parseJudgeReply('maybe')).toBeUndefined();
    // 扩展注入的上下文（hook、bash 输出）追加在用户输入之后，也是 user 角色
    expect(latestUserText([user('old'), reply, user('  prompt  '), user('hook context')])).toBe(
      'prompt'
    );
    expect(latestUserText([user('x'.repeat(5000))])).toHaveLength(4000);
  });

  it('simple 选快模型、complex 选主模型并写回档位；无快模型或无输入时不分类', async () => {
    const simple = createVirtualChooser(
      runtime,
      { source: 'judge', timeoutMs: 1000 },
      undefined,
      async () => 'simple'
    )!;
    await expect(simple(request(), members)).resolves.toEqual({
      preferred: members.fast,
      state: { tier: 'simple', simpleStreak: 1 },
    });
    const complex = createVirtualChooser(
      runtime,
      { source: 'judge', timeoutMs: 1000 },
      undefined,
      async () => 'complex'
    )!;
    await expect(complex(request(), members)).resolves.toMatchObject({
      preferred: members.primary,
    });
    await expect(simple(request(), { ...members, fast: undefined })).resolves.toBeUndefined();
    await expect(simple(request(undefined, []), members)).resolves.toBeUndefined();
  });

  it('超时以 abort 信号传给分类调用', async () => {
    let aborted = false;
    const chooser = createVirtualChooser(
      runtime,
      { source: 'judge', timeoutMs: 20 },
      undefined,
      (_input, _previous, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        })
    )!;
    await expect(chooser(request(), members)).rejects.toThrow('aborted');
    expect(aborted).toBe(true);
  });

  it('judge 来源缺裁判模型时不创建分类器', () => {
    expect(createVirtualChooser(runtime, { source: 'judge', timeoutMs: 1000 }, undefined)).toBe(
      undefined
    );
  });
});

describe('pi 分类器', () => {
  it('多账号克隆按克隆 provider 取凭证，complex 概率过半走主模型', async () => {
    const seen: Array<{ provider: string; apiKey?: string }> = [];
    const piRuntime = {
      getModelsOfType: () => [{ id: 'jev', provider: 'openrouter', type: 'classifier' }],
      classify: async (
        model: { provider: string },
        _context: unknown,
        options: { apiKey?: string }
      ) => {
        seen.push({ provider: model.provider, apiKey: options.apiKey });
        return {
          stopReason: 'stop',
          answers: {
            complexity: {
              type: 'choice',
              choice: 'complex',
              probabilities: { complex: 0.7 },
              confidence: 0.7,
            },
          },
        };
      },
    } as unknown as ModelRuntime;
    const chooser = createVirtualChooser(
      piRuntime,
      {
        source: 'pi-classifier',
        timeoutMs: 1000,
        classifier: { provider: 'openrouter#2', modelId: 'jev' },
      },
      undefined
    )!;
    await expect(chooser(request(), members)).resolves.toMatchObject({
      preferred: members.primary,
    });
    expect(seen).toEqual([{ provider: 'openrouter#2', apiKey: undefined }]);
  });
});

describe('resolveClassifierModel', () => {
  const runtime = {
    getModelsOfType: () => [
      {
        id: 'jev',
        provider: 'typesafe',
        type: 'classifier',
        baseUrl: 'https://api.typesafe.ai/v1',
      },
    ],
  } as unknown as ModelRuntime;

  it('带自定义地址时改打该地址，否则保留 catalog 地址', () => {
    expect(
      resolveClassifierModel(runtime, {
        provider: 'typesafe',
        modelId: 'jev',
        baseUrl: 'https://gw.example.test/v1',
      })
    ).toMatchObject({ provider: 'typesafe', baseUrl: 'https://gw.example.test/v1' });
    expect(resolveClassifierModel(runtime, { provider: 'typesafe', modelId: 'jev' })).toMatchObject(
      { baseUrl: 'https://api.typesafe.ai/v1' }
    );
  });
});
