import { describe, expect, it, vi } from 'vitest';
import type { DefaultModelRef } from '../../../shared/defaultModel';
import type { SpawnModelConfig } from '../../../shared/types/agent';
import {
  briefErrorReason,
  createModelProbe,
  describeModelIssue,
  isModelFailure,
} from './modelProbe';

const ENGINE: DefaultModelRef = { providerId: 'openai', modelId: 'gpt-5' };
const DEFAULT: DefaultModelRef = { providerId: 'anthropic', modelId: 'claude' };

const config = (modelId: string, extra: Record<string, unknown> = {}): SpawnModelConfig =>
  ({
    api: 'openai-completions',
    baseUrl: 'https://api.example.com',
    apiKey: 'k',
    modelId,
    settingsProviderId: 'openai',
    ...extra,
  }) as SpawnModelConfig;

function fixture(overrides: {
  state?: Record<string, unknown>;
  resolveOk?: boolean;
  resolveError?: string;
  workerReady?: boolean;
  completeError?: string;
  now?: () => number;
}) {
  const state = overrides.state ?? { defaultModel: DEFAULT };
  const resolve = vi.fn((ref: DefaultModelRef) =>
    (overrides.resolveOk ?? true)
      ? { ok: true as const, config: config(ref.modelId) }
      : {
          ok: false as const,
          error: overrides.resolveError ?? 'Model is unavailable: model-missing',
        }
  );
  const complete = vi.fn(
    async (_request: {
      systemPrompt: string;
      userText: string;
      candidates: SpawnModelConfig[];
      timeoutMs: number;
      maxTokens: number;
    }): Promise<string> =>
      overrides.completeError ? Promise.reject(new Error(overrides.completeError)) : 'OK'
  );
  const probe = createModelProbe({
    settings: () => state,
    credentials: async () => new Set<string>(),
    resolve,
    isWorkerReady: () => overrides.workerReady ?? true,
    complete,
    now: overrides.now,
  });
  return { probe, resolve, complete };
}

describe('createModelProbe', () => {
  it('未配置成员模型时回落默认，默认也不可用报默认模型原因', async () => {
    const { probe } = fixture({ resolveOk: false });
    const result = await probe(undefined);
    expect(result).toEqual({ ok: false, error: '模型 claude：模型不存在' });
  });

  it('成员与默认都没配置时报未配置可用模型', async () => {
    const { probe } = fixture({ state: {} });
    expect(await probe(undefined)).toEqual({ ok: false, error: '未配置可用模型' });
  });

  it('成员配置不可用时报成员所选模型与原因，不回落默认', async () => {
    const { probe } = fixture({
      resolveOk: false,
      resolveError: 'Model is unavailable: api-key-missing',
    });
    const result = await probe(ENGINE);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('gpt-5');
    expect(result.error).toContain('缺少 API Key');
  });

  it('模型配置存在但实测失败时报告模型与归类原因（鉴权）', async () => {
    const { probe } = fixture({ completeError: '401 Unauthorized: invalid api key' });
    const result = await probe(ENGINE);
    expect(result).toEqual({
      ok: false,
      error: '成员模型 gpt-5：鉴权失败；默认模型 claude：鉴权失败',
    });
  });

  it('实测失败：网络错误归类', async () => {
    const { probe } = fixture({ completeError: 'fetch failed: connect ECONNREFUSED 127.0.0.1' });
    const result = await probe(ENGINE);
    expect(result).toEqual({
      ok: false,
      error: '成员模型 gpt-5：网络连接失败；默认模型 claude：网络连接失败',
    });
  });

  it('实测失败：超时与限流归类', async () => {
    const { probe } = fixture({ completeError: 'completion timed out' });
    expect(await probe(ENGINE)).toEqual({
      ok: false,
      error: '成员模型 gpt-5：调用超时；默认模型 claude：调用超时',
    });
    const rate = fixture({ completeError: 'HTTP 429 too many requests' });
    expect(await rate.probe(ENGINE)).toEqual({
      ok: false,
      error: '成员模型 gpt-5：请求被限流；默认模型 claude：请求被限流',
    });
  });

  it('worker 未就绪时会话服务未启动', async () => {
    const { probe } = fixture({ workerReady: false });
    expect(await probe(ENGINE)).toEqual({ ok: false, error: '会话服务未启动' });
  });

  it('无成员模型时实测默认模型并沿用默认失败原因', async () => {
    const { probe, complete } = fixture({ completeError: 'HTTP 404 model not found' });
    const result = await probe(undefined);
    expect(result).toEqual({ ok: false, error: '模型 claude：模型不存在' });
    expect(complete.mock.calls[0]?.[0]?.candidates[0]?.modelId).toBe('claude');
  });

  it('同一模型配置实测通过后缓存；配置变化重新实测', async () => {
    const { probe, complete } = fixture({});
    expect(await probe(ENGINE)).toEqual({ ok: true });
    expect(await probe(ENGINE)).toEqual({ ok: true });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(await probe({ ...ENGINE, modelId: 'gpt-6' })).toEqual({ ok: true });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('探测预算给 thinking 模型的思维链留出余量', async () => {
    const { probe, complete } = fixture({});
    await probe(ENGINE);
    expect(complete.mock.calls[0]?.[0]?.maxTokens).toBeGreaterThanOrEqual(128);
  });

  it('失败缓存 60 秒，过期后重新实测并恢复成员模型', async () => {
    let now = 0;
    const fx = fixture({ completeError: '401 Unauthorized', now: () => now });
    expect((await fx.probe(ENGINE)).ok).toBe(false);
    fx.complete.mockResolvedValue('OK');
    now = 59_999;
    expect((await fx.probe(ENGINE)).ok).toBe(false);
    expect(fx.complete).toHaveBeenCalledTimes(2);
    now = 60_000;
    expect(await fx.probe(ENGINE)).toEqual({ ok: true });
    expect(fx.complete).toHaveBeenCalledTimes(3);
  });

  it('成员模型调用失败但默认模型可用，返回本次回退配置和原因', async () => {
    const fx = fixture({});
    fx.complete.mockImplementation(async (request) => {
      if (request.candidates[0].modelId === ENGINE.modelId) throw new Error('401 Unauthorized');
      return 'OK';
    });
    expect(await fx.probe(ENGINE)).toEqual({
      ok: true,
      fallback: { model: DEFAULT, label: 'claude', reason: '模型 gpt-5：鉴权失败' },
    });
    await fx.probe(ENGINE);
    expect(fx.complete).toHaveBeenCalledTimes(2);
  });

  it('成员配置缺失时仍实测默认模型', async () => {
    const fx = fixture({});
    fx.resolve.mockImplementation((ref) =>
      ref.modelId === ENGINE.modelId
        ? { ok: false, error: 'Model is unavailable: model-missing' }
        : { ok: true, config: config(ref.modelId) }
    );
    expect(await fx.probe(ENGINE)).toMatchObject({ ok: true, fallback: { model: DEFAULT } });
    expect(fx.complete.mock.calls[0][0].candidates.map((c) => c.modelId)).toEqual(['claude']);
  });

  it('虚拟主模型401仍使用实测通过的备用，不依赖worker自动重试、不回退默认', async () => {
    const fx = fixture({});
    const primary = config('broken');
    const backup = config('healthy');
    fx.resolve.mockReturnValue({
      ok: true,
      config: config('virtual', {
        virtual: { name: 'Virtual', primary, fallbacks: [backup] },
      }),
    });
    fx.complete.mockImplementation(async (request) => {
      if (request.candidates[0].modelId !== 'healthy') throw new Error('401');
      return 'OK';
    });
    expect(await fx.probe(ENGINE)).toEqual({
      ok: true,
      model: { providerId: 'openai', modelId: 'healthy' },
    });
    expect(fx.complete.mock.calls.map(([r]) => r.candidates[0])).toEqual([primary, backup]);
  });

  it('虚拟模型整条链包含快模型；主模型恢复后下轮不再pin备用', async () => {
    let now = 0;
    const fx = fixture({ now: () => now });
    fx.resolve.mockReturnValue({
      ok: true,
      config: config('virtual', {
        virtual: {
          name: 'Virtual',
          primary: config('broken'),
          fallbacks: [config('also-broken')],
          fast: config('fast'),
        },
      }),
    });
    fx.complete.mockImplementation(async (r) => {
      if (r.candidates[0].modelId !== 'fast') throw new Error('401');
      return 'OK';
    });
    expect(await fx.probe(ENGINE)).toEqual({
      ok: true,
      model: { providerId: 'openai', modelId: 'fast' },
    });
    expect(fx.complete).toHaveBeenCalledTimes(3);
    fx.complete.mockResolvedValue('OK');
    now = 60_000;
    expect(await fx.probe(ENGINE)).toEqual({ ok: true });
    expect(fx.complete).toHaveBeenCalledTimes(4);
  });

  it('并发投递同配置只测一次', async () => {
    const fx = fixture({});
    await Promise.all([fx.probe(ENGINE), fx.probe(ENGINE)]);
    expect(fx.complete).toHaveBeenCalledTimes(1);
  });

  it('测通后一直有效：两次投递间隔超过 60 秒不再发第二次 ping', async () => {
    let now = 0;
    const fx = fixture({ now: () => now });
    expect(await fx.probe(ENGINE)).toEqual({ ok: true });
    now = 60_000;
    expect(await fx.probe(ENGINE)).toEqual({ ok: true });
    now = 24 * 3600_000;
    expect(await fx.probe(ENGINE)).toEqual({ ok: true });
    expect(fx.complete).toHaveBeenCalledTimes(1);
  });

  it('同一模型引用但解析出的配置变化（换 key / baseUrl）会重测', async () => {
    const fx = fixture({});
    expect(await fx.probe(ENGINE)).toEqual({ ok: true });
    fx.resolve.mockReturnValue({ ok: true, config: config(ENGINE.modelId, { apiKey: 'k2' }) });
    expect(await fx.probe(ENGINE)).toEqual({ ok: true });
    expect(fx.complete).toHaveBeenCalledTimes(2);
  });

  it('真实投递报模型错误后作废该成员缓存，下次重测', async () => {
    const fx = fixture({});
    expect(await fx.probe(ENGINE)).toEqual({ ok: true });
    fx.complete.mockImplementation(async (r) => {
      if (r.candidates[0].modelId === ENGINE.modelId) throw new Error('401');
      return 'OK';
    });
    fx.probe.invalidate(ENGINE);
    expect(await fx.probe(ENGINE)).toMatchObject({ ok: true, fallback: { model: DEFAULT } });
    expect(fx.complete).toHaveBeenCalledTimes(3);
    expect(await fx.probe(ENGINE)).toMatchObject({ ok: true, fallback: { model: DEFAULT } });
    expect(fx.complete).toHaveBeenCalledTimes(3);
  });

  it('作废只影响该成员用过的模型，其他成员缓存保留', async () => {
    const fx = fixture({});
    const other = { providerId: 'openai', modelId: 'other' };
    await fx.probe(ENGINE);
    await fx.probe(other);
    fx.probe.invalidate(other);
    await fx.probe(ENGINE);
    expect(fx.complete).toHaveBeenCalledTimes(2);
    await fx.probe(other);
    expect(fx.complete).toHaveBeenCalledTimes(3);
  });
});

describe('isModelFailure', () => {
  it('鉴权、模型不存在、网络、超时、限流算模型错误；取消与其他错误不算', () => {
    for (const error of [
      '401 Unauthorized',
      'HTTP 404 model not found',
      'fetch failed',
      'request timed out',
      '429 rate limit',
      '403 This model is not available in your region.',
    ])
      expect(isModelFailure(error)).toBe(true);
    for (const error of ['aborted', 'canceled', 'steer-rejected', 'context window exceeded', ''])
      expect(isModelFailure(error)).toBe(false);
  });
});

describe('describeModelIssue', () => {
  const providers = [
    {
      id: 'openai',
      name: 'OpenAI',
      api: 'openai-completions',
      apiKey: '',
      baseUrl: 'https://x',
      enabled: true,
      models: [{ id: 'gpt-5', name: 'GPT-5' }],
    },
  ];
  const state = { providers };

  it('缺 key / 停用 / 不存在各有可读原因', () => {
    expect(describeModelIssue(state, ENGINE)).toBe('模型 gpt-5 (OpenAI) 不可用：缺少 API Key');
    const disabled = { providers: [{ ...providers[0], enabled: false }] };
    expect(describeModelIssue(disabled, ENGINE)).toContain('服务商已停用');
    const missing = { providers: [{ ...providers[0], models: [] }] };
    expect(describeModelIssue(missing, ENGINE)).toContain('模型不存在');
  });

  it('服务商找不到时仍带模型 id', () => {
    expect(describeModelIssue(state, { providerId: 'ghost', modelId: 'm1' })).toContain('m1');
    expect(describeModelIssue(state, { providerId: 'ghost', modelId: 'm1' })).toContain(
      '找不到服务商'
    );
  });
});

describe('briefErrorReason', () => {
  it('已知形态归类，未知错误截断', () => {
    expect(briefErrorReason(new Error('401 Unauthorized'))).toBe('鉴权失败');
    expect(briefErrorReason(new Error('connect ETIMEDOUT'))).toBe('网络连接失败');
    expect(briefErrorReason(new Error('p/m: Connection error.'))).toBe('网络连接失败');
    expect(briefErrorReason(new Error('aborted'))).toBe('已取消');
    const long = `x${'y'.repeat(200)}`;
    expect(briefErrorReason(new Error(long))).toHaveLength(81);
    expect(briefErrorReason('模型 gpt-5：鉴权失败')).toBe('模型 gpt-5：鉴权失败');
  });

  it('空正文归成可读原因，且 provider UUID 里的 401/403 不会改判成鉴权失败', () => {
    for (const text of [
      '965e2e3c-be13-4a72-b3c0-4247edefabd5/deepseek-v4.1-flash: empty completion',
      '401403-0000-4000-8000-000000000000/m: empty completion',
    ])
      expect(briefErrorReason(new Error(text)), text).toBe('模型没有返回正文');
  });

  it('地区限制的 403 不算鉴权失败', () => {
    for (const text of [
      '403 {"error":{"message":"This model is not available in your region.","code":403}}',
      '403 Country, region, or territory not supported',
      'unsupported_country_region_territory',
    ])
      expect(briefErrorReason(new Error(text)), text).toBe('当前地区不可用');
  });
});
