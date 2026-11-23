import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Api, AssistantMessage, Message, Model, Provider } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { SpawnModelConfig } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import {
  directModelFor,
  estimateRequestTokens,
  registerVirtualModel,
  routeVirtualRequest,
  type VirtualMembers,
  withAdaptiveThinking,
} from './virtualModels';

const model = (provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> =>
  ({
    id,
    name: id,
    api: 'anthropic-messages',
    provider,
    baseUrl: 'https://x.test',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
    ...extra,
  }) as Model<Api>;

const strong = model('p1', 'strong');
const weak = model('p1', 'weak', { input: ['text'], contextWindow: 100_000 });
const backup = model('p2', 'backup', { contextWindow: 1_000_000 });
const members: VirtualMembers = { primary: strong, fast: weak, fallbacks: [backup] };
const virtual = model('enso-virtual', 'auto', { api: 'pi-virtual' as Api });

const user = (content: Message['content']): Message =>
  ({ role: 'user', content, timestamp: 0 }) as Message;
const reply = (m: Model<Api>, totalTokens = 10): Message =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    api: m.api,
    provider: m.provider,
    model: m.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: {} },
    stopReason: 'stop',
    timestamp: 0,
  }) as unknown as Message;

const request = (
  reason: 'user' | 'continuation' | 'retry' | 'direct',
  extra: Record<string, unknown> = {}
) =>
  ({
    model: virtual,
    thinkingLevel: 'high',
    reason,
    messages: [user('hi')],
    ...extra,
  }) as Parameters<typeof routeVirtualRequest>[0];

describe('routeVirtualRequest', () => {
  it('新一轮走主模型，摘要等直接请求走快模型', () => {
    expect(routeVirtualRequest(request('user'), members)).toMatchObject({
      model: strong,
      thinkingLevel: 'high',
    });
    expect(routeVirtualRequest(request('direct'), members).model).toBe(weak);
  });

  it('续请求沿用上一个成员保住缓存；带图而上一个不收图时换收图成员', () => {
    expect(
      routeVirtualRequest(request('continuation', { previous: { model: backup } }), members).model
    ).toBe(backup);
    expect(
      routeVirtualRequest(
        request('continuation', {
          previous: { model: weak },
          messages: [user([{ type: 'image', data: 'x', mimeType: 'image/png' }])],
        }),
        members
      ).model
    ).toBe(strong);
  });

  it('重试按顺序故障转移并记下失败成员，新一轮回到主模型并清空记录', () => {
    const failed = { model: strong, message: {} as AssistantMessage };
    const first = routeVirtualRequest(request('retry', { failed }), members);
    expect(first.model).toBe(backup);
    expect(first.state).toEqual({ failed: ['p1/strong'] });
    const second = routeVirtualRequest(
      request('retry', { failed: { model: backup, message: {} }, state: first.state }),
      members
    );
    expect(second.model).toBe(weak);
    expect(second.state).toEqual({ failed: ['p1/strong', 'p2/backup'] });
    const exhausted = routeVirtualRequest(
      request('retry', { failed: { model: weak, message: {} }, state: second.state }),
      members
    );
    expect(exhausted.model).toBe(weak);
    const next = routeVirtualRequest(request('user', { state: second.state }), members);
    expect(next.model).toBe(strong);
    expect(next.state).toEqual({ failed: [] });
    expect(routeVirtualRequest(request('user', { state: { failed: [] } }), members).state).toBe(
      undefined
    );
  });

  it('上下文超过主模型窗口时换窗口足够的成员；图片按固定值估、不信旧 usage', () => {
    const messages = [user('a'.repeat(800_000)), reply(strong, 999_999), user('b')];
    expect(routeVirtualRequest(request('user', { messages }), members).model).toBe(backup);
    expect(estimateRequestTokens(messages)).toBeLessThan(210_000);
    const image = user([{ type: 'image', data: 'x'.repeat(4_000_000), mimeType: 'image/png' }]);
    expect(estimateRequestTokens([image])).toBe(1500);
  });

  it('工具执行中被中止后的新输入算新一轮', () => {
    const toolTurn = { ...(reply(backup) as object), stopReason: 'toolUse' } as unknown as Message;
    const aborted = {
      role: 'toolResult',
      toolCallId: 't1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'Operation aborted' }],
      isError: true,
      timestamp: 0,
    } as unknown as Message;
    const routed = routeVirtualRequest(
      request('user', {
        previous: { model: backup },
        state: { failed: ['p1/strong'] },
        messages: [user('go'), toolTurn, aborted, user('new task')],
      }),
      members
    );
    expect(routed.model).toBe(strong);
    expect(routed.state).toEqual({ failed: [] });
  });

  it('运行中插入的 steering 按续请求处理：不重置失败记录、不回主模型', () => {
    const toolTurn = {
      ...(reply(backup) as object),
      stopReason: 'toolUse',
    } as unknown as Message;
    const steering = routeVirtualRequest(
      request('user', {
        previous: { model: backup },
        state: { failed: ['p1/strong'] },
        messages: [user('go'), toolTurn, user('also check tests')],
      }),
      members
    );
    expect(steering.model).toBe(backup);
    expect(steering.state).toBeUndefined();
  });

  it('首选成员（分类器）优先，状态合并写回；关推理时一律 off', () => {
    const routed = routeVirtualRequest(request('user'), members, {
      preferred: weak,
      state: { tier: 'simple', simpleStreak: 2 },
    });
    expect(routed.model).toBe(weak);
    expect(routed.state).toEqual({ tier: 'simple', simpleStreak: 2 });
    const off = routeVirtualRequest(
      request('user', { model: { ...virtual, reasoning: false } }),
      members
    );
    expect(off.thinkingLevel).toBe('off');
  });
});

describe('withAdaptiveThinking', () => {
  it('只给未显式设置的 anthropic 推理模型补 adaptive，且不重复包装', () => {
    const seen: Array<unknown> = [];
    const provider = {
      id: 'p1',
      stream: vi.fn((m: Model<Api>) => seen.push(m.compat)),
      streamSimple: vi.fn((m: Model<Api>) => seen.push(m.compat)),
    } as unknown as Provider;
    const wrapped = withAdaptiveThinking(provider, (id) => id !== 'old');
    expect(withAdaptiveThinking(wrapped, () => true)).toBe(wrapped);
    wrapped.streamSimple(strong, { messages: [] } as never);
    wrapped.streamSimple(model('p1', 'old'), { messages: [] } as never);
    wrapped.streamSimple(
      { ...strong, compat: { forceAdaptiveThinking: undefined } } as Model<Api>,
      { messages: [] } as never
    );
    wrapped.stream({ ...strong, api: 'openai-completions' as Api }, { messages: [] } as never);
    expect(seen).toEqual([
      { forceAdaptiveThinking: true },
      undefined,
      { forceAdaptiveThinking: undefined },
      undefined,
    ]);
  });
});

describe('registerVirtualModel（真实 ModelRuntime）', () => {
  it('注册后可被 pi 路由到真实成员；不可用成员跳过；直接调用取快模型', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-virtual-'));
    const runtime = await ModelRuntime.create({
      authPath: path.join(dir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const register = (provider: string, ids: string[]) =>
      runtime.registerProvider(provider, {
        baseUrl: 'https://x.test',
        api: 'anthropic-messages',
        apiKey: 'k',
        models: ids.map((id) => ({
          id,
          name: id,
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: id === 'weak' ? 50_000 : 200_000,
          maxTokens: 8_000,
        })),
      });
    register('p1', ['strong', 'weak']);
    const config = (modelId: string, providerId = 'p1'): SpawnModelConfig => ({
      api: 'anthropic-messages',
      baseUrl: '',
      apiKey: '',
      modelId,
      settingsProviderId: providerId,
    });
    const resolveMember = async (member: SpawnModelConfig) => {
      const found = runtime.getModel(member.settingsProviderId, member.modelId);
      if (!found) throw new Error('missing');
      return found;
    };
    const { model: registered } = await registerVirtualModel(
      runtime,
      {
        ...config('auto-1'),
        settingsProviderId: 'enso-virtual',
        virtual: {
          name: 'Auto',
          primary: config('strong'),
          fast: config('weak'),
          fallbacks: [config('gone', 'p9')],
        },
      },
      resolveMember
    );
    expect(registered).toMatchObject({ api: 'pi-virtual', name: 'Auto', contextWindow: 50_000 });
    const routed = await runtime.resolveModel(registered, [user('hi')], {
      reason: 'user',
      thinkingLevel: 'medium',
    });
    expect(routed.model).toMatchObject({ provider: 'p1', id: 'strong' });
    const direct = await runtime.resolveModel(registered, [user('hi')], {
      reason: 'direct',
      thinkingLevel: 'medium',
    });
    expect(direct.model.id).toBe('weak');
    expect(directModelFor(registered)).toMatchObject({ id: 'weak' });
    expect(directModelFor(strong)).toBe(strong);
    // 只在 Enso 合成、不在目录里的模型不能做主模型
    await expect(
      registerVirtualModel(
        runtime,
        {
          ...config('auto-2'),
          settingsProviderId: 'enso-virtual',
          virtual: { name: 'Bad', primary: config('strong'), fallbacks: [] },
        },
        async () => model('p1', 'synthetic-overlay')
      )
    ).rejects.toThrow('cannot be routed');
  });

  it('分类器被中止（Request aborted / AbortError）时不打 warn；其他失败照旧 warn', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-virtual-'));
    const runtime = await ModelRuntime.create({
      authPath: path.join(dir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerProvider('p1', {
      baseUrl: 'https://x.test',
      api: 'anthropic-messages',
      apiKey: 'k',
      models: ['strong', 'weak'].map((id) => ({
        id,
        name: id,
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_000,
      })),
    });
    const config = (modelId: string): SpawnModelConfig => ({
      api: 'anthropic-messages',
      baseUrl: '',
      apiKey: '',
      modelId,
      settingsProviderId: 'p1',
    });
    let failure: unknown;
    const { model: registered } = await registerVirtualModel(
      runtime,
      {
        ...config('auto-abort'),
        settingsProviderId: 'enso-virtual',
        virtual: { name: 'Auto', primary: config('strong'), fast: config('weak'), fallbacks: [] },
      },
      async (member) => runtime.getModel(member.settingsProviderId, member.modelId)!,
      async () => {
        throw failure;
      }
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const route = () =>
      runtime.resolveModel(registered, [user('hi')], { reason: 'user', thinkingLevel: 'medium' });
    try {
      failure = new Error('Request aborted');
      expect((await route()).model.id).toBe('strong');
      failure = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      await route();
      expect(warn).not.toHaveBeenCalled();
      failure = new Error('401 unauthorized');
      await route();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
