import { describe, expect, it } from 'vitest';
import type { ModelProvider } from '@shared/types';
import { pickSubagentModelRefs } from './subagentModels';

const provider = (overrides: Partial<ModelProvider>): ModelProvider => ({
  id: 'p1',
  name: 'OpenAI',
  api: 'openai-completions',
  apiKey: 'k',
  baseUrl: 'https://api.openai.com/v1',
  enabled: true,
  models: [],
  ...overrides,
});

describe('pickSubagentModelRefs', () => {
  it('只取有凭证且启用的 provider 下勾选 subagent 且启用的模型', () => {
    const providers: ModelProvider[] = [
      provider({
        id: 'p1',
        models: [
          { id: 'gpt-cheap', subagent: true },
          { id: 'gpt-off', subagent: true, enabled: false },
          { id: 'gpt-unchecked' },
        ],
      }),
      provider({
        id: 'p2',
        name: 'NoKey',
        apiKey: '',
        models: [{ id: 'm', subagent: true }],
      }),
      provider({
        id: 'p3',
        name: 'Disabled',
        enabled: false,
        models: [{ id: 'm', subagent: true }],
      }),
    ];
    expect(pickSubagentModelRefs(providers)).toEqual([
      { name: 'OpenAI/gpt-cheap', providerId: 'p1', modelId: 'gpt-cheap' },
    ]);
  });

  it('订阅 provider(oauthAccountKey)视为有凭证', () => {
    const providers = [
      provider({
        id: 'p1',
        name: 'Claude',
        apiKey: '',
        oauthAccountKey: 'anthropic',
        models: [{ id: 'sonnet', subagent: true }],
      }),
    ];
    expect(pickSubagentModelRefs(providers)).toEqual([
      { name: 'Claude/sonnet', providerId: 'p1', modelId: 'sonnet' },
    ]);
  });

  it('name 冲突时追加序号保证唯一', () => {
    const providers = [
      provider({ id: 'p1', name: 'X', models: [{ id: 'm', subagent: true }] }),
      provider({ id: 'p2', name: 'X', models: [{ id: 'm', subagent: true }] }),
    ];
    expect(pickSubagentModelRefs(providers).map((entry) => entry.name)).toEqual(['X/m', 'X/m#2']);
  });

  it('脏输入不崩:models 非数组直接跳过', () => {
    const dirty = provider({ models: undefined as unknown as ModelProvider['models'] });
    expect(pickSubagentModelRefs([dirty])).toEqual([]);
  });
});
