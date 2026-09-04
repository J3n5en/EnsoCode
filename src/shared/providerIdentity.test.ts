import { describe, expect, it } from 'vitest';
import { CUSTOM_VENDOR_ID } from './providerGroups';
import { applyIncomingProviders, providerDedupeKey, unionProviderModels } from './providerIdentity';
import type { ModelProvider } from './types/llm';

const provider = (overrides: Partial<ModelProvider>): ModelProvider => ({
  id: overrides.id ?? 'id',
  name: overrides.name ?? 'p',
  api: 'openai-completions',
  apiKey: 'sk',
  baseUrl: 'https://api.x.ai/v1',
  enabled: true,
  models: [],
  ...overrides,
});

describe('providerDedupeKey', () => {
  it('订阅条目仍按 oauthAccountKey，避免同厂商第二账号被吞', () => {
    expect(providerDedupeKey({ oauthAccountKey: 'xai#2', baseUrl: '', apiKey: '' })).toBe(
      'oauth::xai#2'
    );
  });

  it('API-key 条目按归一化 baseUrl + apiKey；尾斜杠不影响', () => {
    expect(
      providerDedupeKey({
        baseUrl: 'https://api.x.ai/v1/',
        apiKey: ' sk ',
      })
    ).toBe(providerDedupeKey({ baseUrl: 'https://api.x.ai/v1', apiKey: 'sk' }));
  });

  it('向导里选 Custom 即使 URL 撞上官方 xAI，也是另一条配置', () => {
    const official = providerDedupeKey({
      baseUrl: 'https://api.x.ai/v1',
      apiKey: 'sk',
    });
    const custom = providerDedupeKey({
      baseUrl: 'https://api.x.ai/v1',
      apiKey: 'sk',
      catalogId: CUSTOM_VENDOR_ID,
    });
    expect(custom).not.toBe(official);
    expect(custom).toContain(CUSTOM_VENDOR_ID);
  });

  it('xAI 向导改用已有 OpenAI 中转 URL 时与 OpenAI 条目不是同一条', () => {
    const importedOpenAI = providerDedupeKey({
      baseUrl: 'https://done.5111online.uk/v1',
      apiKey: 'sk',
    });
    const xaiWizard = providerDedupeKey({
      baseUrl: 'https://done.5111online.uk/v1',
      apiKey: 'sk',
      catalogId: 'xai',
    });
    expect(xaiWizard).not.toBe(importedOpenAI);
  });
});

describe('unionProviderModels', () => {
  it('已有模型保留覆盖，只追加新 id', () => {
    expect(
      unionProviderModels(
        [{ id: 'grok-3', enabled: false, reasoning: 'off' }],
        [
          { id: 'grok-3', enabled: true },
          { id: 'grok-4', enabled: true },
        ]
      )
    ).toEqual([
      { id: 'grok-3', enabled: false, reasoning: 'off' },
      { id: 'grok-4', enabled: true },
    ]);
  });

  it('没有新模型时仍返回新数组，避免调用方误共享容器引用', () => {
    const current = [{ id: 'grok-3', enabled: true }];
    const result = unionProviderModels(current, [{ id: 'grok-3', enabled: false }]);
    expect(result).toEqual(current);
    expect(result).not.toBe(current);
  });
});

describe('applyIncomingProviders', () => {
  it('Custom 与已有官方 xAI 同 URL/同 key 时仍新增，模型清单生效', () => {
    const existing = [
      provider({
        id: 'xai-official',
        name: 'xAI',
        models: [{ id: 'grok-3', enabled: true }],
      }),
    ];
    const { providers, added } = applyIncomingProviders(existing, [
      provider({
        id: 'my-xai',
        name: 'My xAI',
        catalogId: CUSTOM_VENDOR_ID,
        models: [{ id: 'grok-4', enabled: true }],
      }),
    ]);
    expect(added).toBe(1);
    expect(providers.map((item) => item.id)).toEqual(['xai-official', 'my-xai']);
    expect(providers[1].models.map((model) => model.id)).toEqual(['grok-4']);
  });

  it('同一官方端点再次录入时合并模型，而不是整条丢弃', () => {
    const existing = [
      provider({
        id: 'xai-official',
        models: [{ id: 'grok-3', enabled: true }],
      }),
    ];
    const { providers, added } = applyIncomingProviders(existing, [
      provider({
        id: 'ignored-new-id',
        models: [
          { id: 'grok-3', enabled: false },
          { id: 'grok-4', enabled: true },
        ],
      }),
    ]);
    expect(added).toBe(1);
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe('xai-official');
    expect(providers[0].models).toEqual([
      { id: 'grok-3', enabled: true },
      { id: 'grok-4', enabled: true },
    ]);
  });

  it('完全相同的端点+模型是 no-op', () => {
    const existing = [provider({ models: [{ id: 'grok-3' }] })];
    const { providers, added } = applyIncomingProviders(existing, [
      provider({ id: 'dup', models: [{ id: 'grok-3' }] }),
    ]);
    expect(added).toBe(0);
    expect(providers).toEqual(existing);
  });

  it('从 xAI 向导录入同一中转 URL 的 grok 模型时新增独立供应商，不吞进 OpenAI', () => {
    const existing = [
      provider({
        id: 'openai-relay',
        name: 'OpenAI',
        api: 'openai-responses',
        baseUrl: 'https://done.5111online.uk/v1',
        models: [{ id: 'gpt-5.6-sol', enabled: true }],
      }),
    ];
    const { providers, added } = applyIncomingProviders(existing, [
      provider({
        id: 'xai-relay',
        name: 'xAI (Grok/X subscription)',
        catalogId: 'xai',
        baseUrl: 'https://done.5111online.uk/v1',
        models: [{ id: 'grok-4.6', enabled: true }],
      }),
    ]);
    expect(added).toBe(1);
    expect(providers.map((item) => item.id)).toEqual(['openai-relay', 'xai-relay']);
    expect(providers[1].models.map((model) => model.id)).toEqual(['grok-4.6']);
  });

  it('选 Custom 且 URL 已在自定义组时把新模型合并进已有行', () => {
    const existing = [
      provider({
        id: 'openai-relay',
        name: 'OpenAI',
        baseUrl: 'https://done.5111online.uk/v1',
        models: [{ id: 'gpt-5.6-sol', enabled: true }],
      }),
    ];
    const { providers, added } = applyIncomingProviders(existing, [
      provider({
        id: 'ignored',
        catalogId: CUSTOM_VENDOR_ID,
        baseUrl: 'https://done.5111online.uk/v1',
        models: [{ id: 'grok-4.6', enabled: true }],
      }),
    ]);
    expect(added).toBe(1);
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe('openai-relay');
    expect(providers[0].models.map((model) => model.id)).toEqual(['gpt-5.6-sol', 'grok-4.6']);
  });
});
