import { resolveChatModel } from '@shared/defaultModel';
import { translate } from '@shared/i18n';
import type { ModelProvider } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { unusableDefaultMessage } from './unusableModel';

function provider(id: string, modelIds: string[], overrides: Partial<ModelProvider> = {}) {
  return {
    id,
    name: id,
    api: 'openai-completions',
    apiKey: `key-${id}`,
    baseUrl: 'https://example.test/v1',
    enabled: true,
    models: modelIds.map((modelId) => ({ id: modelId })),
    ...overrides,
  } satisfies ModelProvider;
}

const credentials = {
  oauthCredentials: { status: 'ready' as const, authenticatedAccountKeys: new Set<string>() },
};
const en = (key: string, params?: Record<string, string | number>) => translate('en', key, params);
const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);

describe('(c) 新会话：默认模型不可用时报错，不改用别的模型', () => {
  const providers = [
    provider('magpie', ['devin/swe-2-1'], { name: 'Magpie', apiKey: '' }),
    provider('max', ['claude-fable-5'], { name: 'Max' }),
  ];
  const resolution = resolveChatModel({
    defaultModel: { providerId: 'magpie', modelId: 'devin/swe-2-1' },
    providers,
    credentials,
  });

  it('新草稿不解析到 Max，而是 none + 点名 magpie', () => {
    expect(resolution).toMatchObject({ source: 'none', providerId: null, modelId: null });
    if (resolution.source !== 'none' || !('unavailableDefault' in resolution)) {
      throw new Error('expected unavailable default');
    }
    if (!resolution.unavailableDefault) throw new Error('expected unavailable default');
    expect(unusableDefaultMessage(resolution.unavailableDefault, providers, [], en)).toBe(
      'Default model "Magpie / devin/swe-2-1" is unavailable: its provider has no API key. No other model will be used. Fix it in Settings or choose a model for this conversation.'
    );
    expect(unusableDefaultMessage(resolution.unavailableDefault, providers, [], zh)).toBe(
      '默认模型「Magpie / devin/swe-2-1」不可用：所属服务商未配置 API Key。不会改用其他模型；请到设置里修复，或为本会话手动选择模型。'
    );
  });

  it('项目默认与虚拟模型的说法', () => {
    const message = unusableDefaultMessage(
      {
        source: 'project',
        model: { providerId: 'enso-virtual', modelId: 'auto' },
        reason: 'model-disabled',
      },
      providers,
      [
        {
          id: 'auto',
          name: 'Auto',
          enabled: false,
          primary: { providerId: 'max', modelId: 'claude-fable-5' },
          fallbacks: [],
        },
      ],
      zh
    );
    expect(message).toContain('项目默认模型「Auto」不可用：该模型已停用');
  });
});
