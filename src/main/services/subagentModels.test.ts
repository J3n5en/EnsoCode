import type { ModelProvider, SubagentModelEntry } from '@shared/types';
import { VIRTUAL_PROVIDER_ID, type VirtualModelEntry } from '@shared/virtualModels';
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
  it('关闭单个条目仅移除对应候选，缺省与显式启用的邻居保持可用', () => {
    const providers = [provider({ models: [{ id: 'off' }, { id: 'legacy' }, { id: 'on' }] })];
    const entries = [
      entry({ id: 'off', modelId: 'off', enabled: false }),
      entry({ id: 'legacy', modelId: 'legacy' }),
      entry({ id: 'on', modelId: 'on', enabled: true }),
    ];
    expect(pickSubagentModelRefs(entries, providers, []).map((ref) => ref.modelId)).toEqual([
      'legacy',
      'on',
    ]);
    expect(providers[0].enabled).toBe(true);
    expect(providers[0].models).toEqual([{ id: 'off' }, { id: 'legacy' }, { id: 'on' }]);
  });

  it('禁用条目不占用去重键，同一模型后续启用条目的配置仍透传', () => {
    const entries = [
      entry({ enabled: false, description: '禁用配置', reasoning: 'off' }),
      entry({ id: 'e2', enabled: true, description: '启用配置', reasoning: 'on' }),
    ];
    expect(pickSubagentModelRefs(entries, [provider({})], [])).toEqual([
      {
        name: 'OpenAI/gpt-cheap',
        providerId: 'p1',
        modelId: 'gpt-cheap',
        description: '启用配置',
        reasoning: 'on',
      },
    ]);
  });

  it('关闭不修改持久化配置，重新启用后恢复描述和推理覆盖', () => {
    const configured = entry({ enabled: false, reasoning: 'off', thinkingLevel: 'high' });
    const original = structuredClone(configured);
    expect(pickSubagentModelRefs([configured], [provider({})], [])).toEqual([]);
    expect(configured).toEqual(original);
    expect(
      pickSubagentModelRefs([{ ...configured, enabled: true }], [provider({})], [])[0]
    ).toEqual({
      name: 'OpenAI/gpt-cheap',
      providerId: 'p1',
      modelId: 'gpt-cheap',
      description: original.description,
      reasoning: 'off',
      thinkingLevel: 'high',
    });
  });

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
    expect(pickSubagentModelRefs(entries, providers, [])).toEqual([
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
      pickSubagentModelRefs([entry({ modelId: 'sonnet', description: '' })], providers, [])
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
    expect(pickSubagentModelRefs(entries, providers, []).map((ref) => ref.name)).toEqual([
      'X/m',
      'X/m#2',
    ]);
  });

  it('条目级推理覆盖透传;非法值丢弃;缺省不透传', () => {
    const providers = [provider({})];
    expect(
      pickSubagentModelRefs([entry({ reasoning: 'on', thinkingLevel: 'high' })], providers, [])[0]
    ).toMatchObject({ reasoning: 'on', thinkingLevel: 'high' });
    expect(pickSubagentModelRefs([entry({ reasoning: 'off' })], providers, [])[0]).toMatchObject({
      reasoning: 'off',
    });
    const plain = pickSubagentModelRefs([entry({})], providers, [])[0];
    expect(plain).not.toHaveProperty('reasoning');
    expect(plain).not.toHaveProperty('thinkingLevel');
    const bad = pickSubagentModelRefs(
      [
        entry({
          reasoning: 'maybe' as unknown as SubagentModelEntry['reasoning'],
          thinkingLevel: 'ultra' as unknown as SubagentModelEntry['thinkingLevel'],
        }),
      ],
      providers,
      []
    )[0];
    expect(bad).not.toHaveProperty('reasoning');
    expect(bad).not.toHaveProperty('thinkingLevel');
  });

  it('脏输入不崩:models 非数组/条目缺字段直接跳过', () => {
    const dirty = provider({ models: undefined as unknown as ModelProvider['models'] });
    const badEntry = { id: 'x' } as unknown as SubagentModelEntry;
    expect(pickSubagentModelRefs([entry({}), badEntry], [dirty], [])).toEqual([]);
  });

  const auto = (overrides: Partial<VirtualModelEntry> = {}): VirtualModelEntry => ({
    id: 'auto',
    name: 'Auto',
    enabled: true,
    primary: { providerId: 'p1', modelId: 'gpt-cheap' },
    fallbacks: [],
    ...overrides,
  });

  const virtualEntry = (overrides: Partial<SubagentModelEntry> = {}): SubagentModelEntry =>
    entry({
      providerId: VIRTUAL_PROVIDER_ID,
      modelId: 'auto',
      description: '按难度路由',
      reasoning: 'on',
      thinkingLevel: 'high',
      ...overrides,
    });

  it('启用的虚拟条目按条目名列出，不查凭证，描述和推理覆盖透传', () => {
    expect(pickSubagentModelRefs([virtualEntry()], [], [auto()])).toEqual([
      {
        name: 'Auto',
        providerId: VIRTUAL_PROVIDER_ID,
        modelId: 'auto',
        description: '按难度路由',
        reasoning: 'on',
        thinkingLevel: 'high',
      },
    ]);
  });

  it('禁用或缺失的虚拟条目被跳过，且不占去重键', () => {
    const entries = [
      virtualEntry({
        id: 'disabled-model',
        modelId: 'off',
        description: '目录停用',
        reasoning: 'off',
      }),
      virtualEntry({ id: 'missing', modelId: 'ghost', description: '缺失' }),
      virtualEntry({ id: 'entry-off', enabled: false, description: '条目禁用', reasoning: 'off' }),
      virtualEntry({ id: 'e2', description: '启用配置', reasoning: 'on' }),
    ];
    expect(
      pickSubagentModelRefs(
        entries,
        [],
        [auto(), auto({ id: 'off', name: 'Auto', enabled: false })]
      )
    ).toEqual([
      {
        name: 'Auto',
        providerId: VIRTUAL_PROVIDER_ID,
        modelId: 'auto',
        description: '启用配置',
        reasoning: 'on',
        thinkingLevel: 'high',
      },
    ]);
  });

  it('虚拟条目名与真实模型名冲突时追加 #2', () => {
    const providers = [provider({ name: 'OpenAI', models: [{ id: 'gpt-cheap' }] })];
    expect(
      pickSubagentModelRefs(
        [entry({}), virtualEntry({ id: 'v1', description: '虚拟' })],
        providers,
        [auto({ name: 'OpenAI/gpt-cheap' })]
      ).map((ref) => ref.name)
    ).toEqual(['OpenAI/gpt-cheap', 'OpenAI/gpt-cheap#2']);
  });
});
