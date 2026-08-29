import { describe, expect, it } from 'vitest';
import { applyModelOverrides } from './modelEntry';
import type { ModelEntry } from './types';

describe('applyModelOverrides', () => {
  it('保留 subagent 标记:改能力覆盖不得抹掉子代理开关', () => {
    const model: ModelEntry = { id: 'gpt', subagent: true };
    const next = applyModelOverrides(model, { contextWindow: 128000 });
    expect(next.subagent).toBe(true);
    expect(next.contextWindow).toBe(128000);
  });

  it('subagent 未设时不落盘多余键', () => {
    const next = applyModelOverrides({ id: 'gpt' }, { maxTokens: 100 });
    expect('subagent' in next).toBe(false);
  });
});
