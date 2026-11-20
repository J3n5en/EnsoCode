import { describe, expect, it } from 'vitest';
import { dispatchModelChoices, dispatchProviderId } from './dispatchModel';

const providers = [
  {
    id: 'bed36597',
    name: 'Max',
    models: [{ id: 'claude-opus-5-5' }, { id: 'off', enabled: false }],
  },
  { id: 'aaa', name: 'kencc', models: [{ id: 'k1' }] },
  { id: 'bbb', name: 'kencc', models: [{ id: 'k2' }] },
  { id: 'ccc', name: 'Dead', models: [{ id: 'd1' }] },
];

describe('dispatchProviderId', () => {
  it('精确 id 原样返回', () => {
    expect(dispatchProviderId('bed36597', providers)).toBe('bed36597');
  });

  it('显示名唯一命中时换成 id，忽略大小写与空白', () => {
    expect(dispatchProviderId(' max ', providers)).toBe('bed36597');
  });

  it('重名或无匹配时不猜，原样返回', () => {
    expect(dispatchProviderId('kencc', providers)).toBe('kencc');
    expect(dispatchProviderId('anthropic', providers)).toBe('anthropic');
  });
});

describe('dispatchModelChoices', () => {
  it('只列可用模型，带名字与精确 id', () => {
    const text = dispatchModelChoices(providers, (providerId) => providerId !== 'ccc');
    expect(text).toContain('Max: providerId "bed36597", modelId claude-opus-5-5');
    expect(text).not.toContain('off');
    expect(text).not.toContain('Dead');
    expect(text).toContain('providerId "aaa", modelId k1');
  });

  it('没有可用模型时为空', () => {
    expect(dispatchModelChoices(providers, () => false)).toBe('');
  });

  it('单个 provider 模型过多时截断', () => {
    const many = [{ id: 'p', name: 'P', models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }];
    expect(dispatchModelChoices(many, () => true, 2)).toBe(
      'P: providerId "p", modelId a, b (+1 more)'
    );
  });
});
