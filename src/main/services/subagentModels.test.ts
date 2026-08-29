import type { ModelProvider, SubagentModelEntry } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { pickSubagentModelRefs } from './subagentModels';

const provider = (overrides: Partial<ModelProvider>): ModelProvider => ({
  id: 'p1',
  name: 'OpenAI',
  api: 'openai-completions',
  apiKey: 'k',
  baseUrl: 'https://api.openai.com/v1',
  enabled: true,
  models: [{ id: 'gpt-cheap' }, { id: 'gpt-off', enabled: false }],
  ...overrides,
});

const entry = (overrides: Partial<SubagentModelEntry>): SubagentModelEntry => ({
  id: 'e1',
  providerId: 'p1',
  modelId: 'gpt-cheap',
  description: '便宜快,适合简单任务',
  ...overrides,
});

describe('pickSubagentModelRefs', () => {
  it('条目按 provider 凭证/启用与模型行启用过滤,描述透传', () => {
    const providers = [
      provider({}),
      provider({ id: 'p-nokey', name: 'NoKey', apiKey: '' }),
      provider({ id: 'p-disabled', name: 'Off', enabled: false }),
    ];
    const entries = [
      entry({}),
      entry({ id: 'e2', providerId: 'p-nokey' }),
      entry({ id: 'e3', providerId: 'p-disabled' }),
      entry({ id: 'e4', modelId: 'gpt-off' }),
      entry({ id: 'e5', modelId: 'ghost' }),
      entry({ id: 'e6', providerId: 'ghost' }),
    ];
    expect(pickSubagentModelRefs(entries, providers)).toEqual([
      {
        name: 'OpenAI/gpt-cheap',
        providerId: 'p1',
        modelId: 'gpt-cheap',
        description: '便宜快,适合简单任务',
      },
    ]);
  });

  it('订阅 provider(oauthAccountKey)视为有凭证;空描述不透传', () => {
    const providers = [
      provider({
        id: 'p1',
        name: 'Claude',
        apiKey: '',
        oauthAccountKey: 'anthropic',
        models: [{ id: 'sonnet' }],
      }),
    ];
    expect(
      pickSubagentModelRefs([entry({ modelId: 'sonnet', description: '' })], providers)
    ).toEqual([{ name: 'Claude/sonnet', providerId: 'p1', modelId: 'sonnet' }]);
  });

  it('name 冲突时追加序号保证唯一;同一模型重复条目去重', () => {
    const providers = [
      provider({ id: 'p1', name: 'X', models: [{ id: 'm' }] }),
      provider({ id: 'p2', name: 'X', models: [{ id: 'm' }] }),
    ];
    const entries = [
      entry({ id: 'e1', providerId: 'p1', modelId: 'm' }),
      entry({ id: 'e2', providerId: 'p2', modelId: 'm' }),
      entry({ id: 'e3', providerId: 'p1', modelId: 'm' }),
    ];
    expect(pickSubagentModelRefs(entries, providers).map((ref) => ref.name)).toEqual([
      'X/m',
      'X/m#2',
    ]);
  });

  it('脏输入不崩:models 非数组/条目缺字段直接跳过', () => {
    const dirty = provider({ models: undefined as unknown as ModelProvider['models'] });
    const badEntry = { id: 'x' } as unknown as SubagentModelEntry;
    expect(pickSubagentModelRefs([entry({}), badEntry], [dirty])).toEqual([]);
  });
});
