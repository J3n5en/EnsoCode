import type { ModelProvider } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { modelLabel } from './modelLabel';

const providers = [
  { id: 'p1', name: 'Anthropic', models: [{ id: 'm1' }] },
] as unknown as ModelProvider[];

describe('modelLabel', () => {
  it('有 provider 时写「Provider / model」', () => {
    expect(modelLabel(providers, { providerId: 'p1', modelId: 'm1' })).toBe('Anthropic / m1');
  });

  it('provider 找不到时退回 modelId', () => {
    expect(modelLabel(providers, { providerId: 'gone', modelId: 'm9' })).toBe('m9');
  });

  it('没有模型时返回空串', () => {
    expect(modelLabel(providers, undefined)).toBe('');
  });
});
