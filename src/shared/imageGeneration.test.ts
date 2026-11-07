import { describe, expect, it } from 'vitest';
import {
  imageGenerationCandidateProviders,
  parseImageGenerationConfig,
  resolveImageGenerationConfig,
} from './imageGeneration';
import {
  extractModelOverrides,
  materializeOAuthModels,
  referencedModelIds,
} from './modelDirectory';
import { applyModelOverrides, mergeFetchedModels } from './modelEntry';
import type { ModelProvider } from './types';

const provider: ModelProvider = {
  id: 'p',
  name: 'display',
  api: 'openai-completions',
  apiKey: 'key',
  baseUrl: '',
  enabled: true,
  catalogId: 'openai',
  models: [{ id: 'image', imageGeneration: true }, { id: 'chat' }],
};

describe('生图模型标记', () => {
  it('编辑能力时保留标记', () => {
    expect(
      applyModelOverrides({ id: 'image', imageGeneration: true }, { maxTokens: 100 })
    ).toMatchObject({ imageGeneration: true });
  });
  it('稀疏覆盖和目录物化保留标记', () => {
    const overrides = extractModelOverrides(
      [{ id: 'image', imageGeneration: true }],
      [{ id: 'image' }]
    );
    expect(overrides).toEqual([{ id: 'image', imageGeneration: true }]);
    expect(materializeOAuthModels([{ id: 'image' }], overrides)).toEqual(overrides);
  });
  it('刷新模型列表保留用户标记', () => {
    expect(mergeFetchedModels([{ id: 'image', imageGeneration: true }], [{ id: 'image' }])).toEqual(
      [{ id: 'image', imageGeneration: true }]
    );
  });
  it('独立选型被列为目录引用', () => {
    expect(
      referencedModelIds({ imageGenerationModel: { providerId: 'p', modelId: 'image' } }, 'p').has(
        'image'
      )
    ).toBe(true);
  });
});

describe('生图配置', () => {
  it.each([
    null,
    { ...provider, models: null },
    { ...provider, models: [null] },
    { ...provider, apiKey: 123 },
    { ...provider, baseUrl: 123 },
  ])('坏持久化条目不会阻止旧配置撤销 %#', (invalid) => {
    const providers = [invalid] as unknown as ModelProvider[];
    expect(
      resolveImageGenerationConfig({ providerId: 'p', modelId: 'image' }, providers).config
    ).toBeNull();
    expect(imageGenerationCandidateProviders(providers)).toEqual([]);
  });
  it('筛选启用的 API Key 生图模型且空选择不回退', () => {
    expect(imageGenerationCandidateProviders([provider])[0].models).toEqual([
      { id: 'image', imageGeneration: true },
    ]);
    expect(resolveImageGenerationConfig(null, [provider])).toEqual({ config: null });
    expect(
      resolveImageGenerationConfig({ providerId: 'p', modelId: 'image' }, [provider]).config
    ).toEqual({
      providerId: 'p',
      modelId: 'image',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'key',
    });
    expect(imageGenerationCandidateProviders([{ ...provider, oauthAccountKey: 'x' }])).toEqual([]);
  });
  it('拒绝凭据、查询或片段混入地址并按白名单解析', () => {
    const config = {
      providerId: 'p',
      modelId: 'm',
      protocol: 'openai-compatible',
      baseUrl: 'http://localhost:8080/prefix',
      apiKey: 'key',
      extra: 'discard',
    };
    expect(parseImageGenerationConfig(config)).toBeNull();
    const { extra: _extra, ...valid } = config;
    expect(parseImageGenerationConfig(valid)).toEqual(valid);
    for (const baseUrl of [
      'https://user:pass@example.com/v1',
      'https://example.com/v1?q=1',
      'https://example.com/#x',
    ])
      expect(parseImageGenerationConfig({ ...valid, baseUrl })).toBeNull();
  });
  it('按协议和来源识别官方端点，保留兼容端点路径并补齐 Gemini 版本', () => {
    const ref = { providerId: 'p', modelId: 'image' };
    expect(
      resolveImageGenerationConfig(ref, [
        { ...provider, catalogId: '__custom', baseUrl: 'http://localhost:8000/custom/v2' },
      ]).config
    ).toMatchObject({ protocol: 'openai-compatible', baseUrl: 'http://localhost:8000/custom/v2' });
    expect(
      resolveImageGenerationConfig(ref, [
        {
          ...provider,
          api: 'google-generative-ai',
          baseUrl: 'https://generativelanguage.googleapis.com',
        },
      ]).config
    ).toMatchObject({
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    });
    expect(
      imageGenerationCandidateProviders([{ ...provider, catalogId: '__custom', baseUrl: '' }])
    ).toEqual([]);
    expect(imageGenerationCandidateProviders([{ ...provider, api: 'anthropic-messages' }])).toEqual(
      []
    );
  });
});
