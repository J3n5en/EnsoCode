import { describe, expect, it } from 'vitest';
import { modelUsability, resolveChatModel, sanitizeDefaultModel } from './defaultModel';
import type { ModelProvider } from './types';
import {
  canBeVirtualMember,
  classifierBaseUrlFor,
  classifierProviderFor,
  directMemberRef,
  findVirtualModel,
  parseVirtualClassifier,
  parseVirtualModels,
  VIRTUAL_PROVIDER_ID,
  type VirtualModelEntry,
} from './virtualModels';

const ready = {
  oauthCredentials: { status: 'ready' as const, authenticatedAccountKeys: new Set<string>() },
};
const provider = (
  id: string,
  models: string[],
  extra: Partial<ModelProvider> = {}
): ModelProvider => ({
  id,
  name: id,
  api: 'anthropic-messages',
  apiKey: 'k',
  baseUrl: 'https://x.test',
  enabled: true,
  models: models.map((model) => ({ id: model })),
  ...extra,
});
const providers = [provider('p1', ['strong', 'weak']), provider('p2', ['other'])];
const auto: VirtualModelEntry = {
  id: 'auto',
  name: 'Auto',
  enabled: true,
  primary: { providerId: 'p1', modelId: 'strong' },
  fast: { providerId: 'p1', modelId: 'weak' },
  fallbacks: [{ providerId: 'p2', modelId: 'other' }],
};
const autoRef = { providerId: VIRTUAL_PROVIDER_ID, modelId: 'auto' };

describe('parseVirtualModels', () => {
  it('丢弃非法条目、嵌套虚拟成员与重复 id，空名给默认名，去重备用并钳制分类器超时', () => {
    const parsed = parseVirtualModels([
      {
        id: 'a',
        name: '  Auto  ',
        primary: { providerId: 'p1', modelId: 'strong' },
        fast: { providerId: 'p1', modelId: 'strong' },
        fallbacks: [
          { providerId: 'p1', modelId: 'strong' },
          { providerId: 'p2', modelId: 'other' },
          { providerId: 'p2', modelId: 'other' },
          autoRef,
          'junk',
        ],
        classifier: {
          source: 'judge',
          model: { providerId: 'p1', modelId: 'weak' },
          timeoutMs: 99,
        },
      },
      { id: 'a', name: 'dup', primary: { providerId: 'p1', modelId: 'weak' } },
      { id: 'b', name: 'nested', primary: autoRef },
      { id: 'c', name: '', primary: { providerId: 'p1', modelId: 'weak' } },
      {
        id: 'd',
        name: 'bad classifier',
        primary: { providerId: 'p1', modelId: 'weak' },
        classifier: { source: 'x' },
      },
      null,
    ]);
    expect(parsed).toEqual([
      {
        id: 'a',
        name: 'Auto',
        enabled: true,
        primary: { providerId: 'p1', modelId: 'strong' },
        fallbacks: [{ providerId: 'p2', modelId: 'other' }],
        classifier: {
          source: 'judge',
          model: { providerId: 'p1', modelId: 'weak' },
          timeoutMs: 500,
        },
      },
      {
        id: 'c',
        name: 'Auto',
        enabled: true,
        primary: { providerId: 'p1', modelId: 'weak' },
        fallbacks: [],
      },
      {
        id: 'd',
        name: 'bad classifier',
        enabled: true,
        primary: { providerId: 'p1', modelId: 'weak' },
        fallbacks: [],
      },
    ]);
    expect(parseVirtualModels('nope')).toEqual([]);
  });

  it('辅助场景取快模型，没有快模型取主模型', () => {
    expect(directMemberRef(auto)).toEqual(auto.fast);
    expect(directMemberRef({ ...auto, fast: undefined })).toEqual(auto.primary);
    expect(findVirtualModel([auto], autoRef)).toBe(auto);
    expect(findVirtualModel([auto], { providerId: 'p1', modelId: 'auto' })).toBeUndefined();
  });

  it('Cursor 订阅不能做成员', () => {
    expect(canBeVirtualMember({ oauthAccountKey: 'cursor' })).toBe(false);
    expect(canBeVirtualMember({ oauthAccountKey: 'anthropic#2' })).toBe(true);
    expect(canBeVirtualMember({})).toBe(true);
  });
});

describe('虚拟模型可用性', () => {
  it('按主模型判定；不接受虚拟模型的调用方视为 provider 缺失', () => {
    expect(modelUsability(autoRef, providers, ready, [auto])).toBe('usable');
    expect(modelUsability(autoRef, providers, ready)).toBe('provider-missing');
    expect(modelUsability(autoRef, providers, ready, [])).toBe('model-missing');
    expect(modelUsability(autoRef, providers, ready, [{ ...auto, enabled: false }])).toBe(
      'model-disabled'
    );
    expect(modelUsability(autoRef, [provider('p1', ['weak']), providers[1]!], ready, [auto])).toBe(
      'model-missing'
    );
  });

  it('会话与默认模型可解析到虚拟模型，默认模型校验不会把它洗掉', () => {
    expect(
      resolveChatModel({
        defaultModel: autoRef,
        providers,
        credentials: ready,
        virtualModels: [auto],
      })
    ).toMatchObject({ ...autoRef, source: 'default' });
    expect(
      sanitizeDefaultModel({
        defaultModel: autoRef,
        providers,
        credentials: ready,
        virtualModels: [auto],
      }).status
    ).toBe('unchanged');
    expect(
      sanitizeDefaultModel({
        defaultModel: autoRef,
        providers,
        credentials: ready,
        virtualModels: [],
      })
    ).toMatchObject({ status: 'sanitized', defaultModel: { providerId: 'p1', modelId: 'strong' } });
  });
});

describe('parseVirtualClassifier', () => {
  const model = { providerId: 'p', modelId: 'fast' };

  it('用户设的时限照用并带上标记；越界收到 0.5–30s，不报错', () => {
    expect(
      parseVirtualClassifier({ source: 'judge', model, timeoutMs: 3000, timeoutSet: true })
    ).toEqual({ source: 'judge', model, timeoutMs: 3000, timeoutSet: true });
    expect(
      parseVirtualClassifier({ source: 'judge', model, timeoutMs: 100, timeoutSet: true })
    ).toMatchObject({ timeoutMs: 500, timeoutSet: true });
    expect(
      parseVirtualClassifier({ source: 'judge', model, timeoutMs: 60_000, timeoutSet: true })
    ).toMatchObject({ timeoutMs: 30_000, timeoutSet: true });
  });

  it.each([20_000, 30_000])('保留合法的 %i ms 时限', (timeoutMs) => {
    for (const source of ['judge', 'pi-classifier']) {
      expect(parseVirtualClassifier({ source, model, timeoutMs, timeoutSet: true })).toEqual({
        source,
        model,
        timeoutMs,
        timeoutSet: true,
      });
    }
  });

  it('旧配置没有标记；非 true 的标记视为未设置', () => {
    expect(parseVirtualClassifier({ source: 'judge', model, timeoutMs: 3000 })).toEqual({
      source: 'judge',
      model,
      timeoutMs: 3000,
    });
    expect(
      parseVirtualClassifier({ source: 'judge', model, timeoutMs: 3000, timeoutSet: 'yes' })
    ).not.toHaveProperty('timeoutSet');
  });
});

describe('classifierProviderFor', () => {
  it('按订阅账号、目录 id 或域名识别分类器 provider', () => {
    expect(classifierProviderFor({ oauthAccountKey: 'openrouter#2', baseUrl: '' })).toBe(
      'openrouter#2'
    );
    expect(classifierProviderFor({ oauthAccountKey: 'anthropic', baseUrl: '' })).toBeUndefined();
    expect(classifierProviderFor({ baseUrl: 'https://openrouter.ai/api/v1' })).toBe('openrouter');
    expect(classifierProviderFor({ baseUrl: 'https://ai-gateway.vercel.sh/v1' })).toBe(
      'vercel-ai-gateway'
    );
    expect(
      classifierProviderFor({ baseUrl: 'https://relay.test', catalogId: 'openrouter' })
    ).toBeUndefined();
    expect(classifierProviderFor({ baseUrl: 'https://opencode.ai/zen/v1' })).toBe('opencode');
    expect(classifierProviderFor({ baseUrl: 'https://evil-openrouter.ai.test' })).toBeUndefined();
    expect(classifierProviderFor({ baseUrl: 'not a url' })).toBeUndefined();
  });
});

describe('自定义地址的 System One 分类器', () => {
  const gateway = { api: 'typesafe-system-one' as const, baseUrl: 'https://gw.example.test/v1/' };

  it('显式声明 System One 协议的条目不受域名白名单限制，按自身地址调用', () => {
    expect(classifierProviderFor(gateway)).toBe('typesafe');
    expect(classifierBaseUrlFor(gateway)).toBe('https://gw.example.test/v1');
  });

  it('官方地址与未填地址沿用 pi 内置地址，其它协议的中转地址仍不认', () => {
    expect(
      classifierBaseUrlFor({ api: 'typesafe-system-one', baseUrl: 'https://api.typesafe.ai/v1/' })
    ).toBeUndefined();
    expect(classifierProviderFor({ api: 'typesafe-system-one', baseUrl: '' })).toBe('typesafe');
    expect(classifierBaseUrlFor({ api: 'typesafe-system-one', baseUrl: '' })).toBeUndefined();
    expect(
      classifierProviderFor({ api: 'openai-completions', baseUrl: 'https://gw.example.test/v1' })
    ).toBeUndefined();
    expect(
      classifierProviderFor({ api: 'typesafe-system-one', baseUrl: 'not a url' })
    ).toBeUndefined();
    expect(
      classifierProviderFor({ api: 'typesafe-system-one', baseUrl: 'file:///etc/passwd' })
    ).toBeUndefined();
  });
});
