import { describe, expect, it } from 'vitest';
import { applyModelOverrides, hasModelOverrides, modelRowBadge } from './modelEntry';
import type { ModelEntry, ModelMeta } from './types';

const base: ModelEntry = { id: 'gpt-test', enabled: true };

const catalogMeta: ModelMeta = {
  modelId: 'gpt-test',
  source: 'catalog-fallback',
  reasoning: true,
  thinkingLevels: ['low', 'medium', 'high', 'max'],
  contextWindow: 200_000,
  maxTokens: 64_000,
};

const unknownMeta: ModelMeta = { modelId: 'gpt-test', source: 'unknown' };

describe('hasModelOverrides', () => {
  it('全缺失不算覆盖', () => {
    expect(hasModelOverrides(base)).toBe(false);
  });

  it("reasoning:'off' 是显式覆盖，不是跟随", () => {
    expect(hasModelOverrides({ ...base, reasoning: 'off' })).toBe(true);
  });

  it("不把 'follow' 或非法值当成覆盖", () => {
    expect(hasModelOverrides({ ...base, reasoning: 'follow' as never })).toBe(false);
    expect(hasModelOverrides({ ...base, contextWindow: 0 })).toBe(false);
  });

  it('任一窗口/档位有值即覆盖', () => {
    expect(hasModelOverrides({ ...base, contextWindow: 64_000 })).toBe(true);
    expect(hasModelOverrides({ ...base, maxTokens: 4096 })).toBe(true);
    expect(hasModelOverrides({ ...base, thinkingLevel: 'high' })).toBe(true);
  });
});

describe('modelRowBadge', () => {
  it('有覆盖优先 已覆盖（走 resolveCustomModelView）', () => {
    expect(modelRowBadge({ ...base, reasoning: 'on' }, catalogMeta)).toBe('override');
    expect(modelRowBadge({ ...base, reasoning: 'off' }, unknownMeta)).toBe('override');
  });

  it('无覆盖时 catalog-fallback / catalog → catalog', () => {
    expect(modelRowBadge(base, catalogMeta)).toBe('catalog');
    expect(
      modelRowBadge(base, {
        modelId: 'gpt-test',
        source: 'catalog',
        reasoning: true,
      })
    ).toBe('catalog');
  });

  it('无覆盖且 unknown / 未查 → 默认（不另写 resolver）', () => {
    expect(modelRowBadge(base, unknownMeta)).toBe('default');
    expect(modelRowBadge(base)).toBe('default');
  });
});

describe('applyModelOverrides', () => {
  it("设 'on' 后能清回缺失（跟随），不会留下 follow/null", () => {
    const set = applyModelOverrides(base, { reasoning: 'on', contextWindow: 32_000 });
    expect(set).toMatchObject({ reasoning: 'on', contextWindow: 32_000 });

    const cleared = applyModelOverrides(set, { reasoning: undefined, contextWindow: undefined });
    expect(cleared).not.toHaveProperty('reasoning');
    expect(cleared).not.toHaveProperty('contextWindow');
    expect(JSON.stringify(cleared)).toBe(JSON.stringify({ id: 'gpt-test', enabled: true }));
  });

  it('未出现在 patch 里的键保持原样', () => {
    const prev = applyModelOverrides(base, { reasoning: 'off', maxTokens: 2048 });
    const next = applyModelOverrides(prev, { contextWindow: 8000 });
    expect(next).toMatchObject({ reasoning: 'off', maxTokens: 2048, contextWindow: 8000 });
  });

  it("不会把 'follow' 写进条目", () => {
    const next = applyModelOverrides(base, { reasoning: 'follow' as never });
    expect(next).not.toHaveProperty('reasoning');
  });
});
