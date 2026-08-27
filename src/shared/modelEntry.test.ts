import { describe, expect, it } from 'vitest';
import {
  applyModelOverrides,
  catalogMatchedFromMeta,
  hasModelOverrides,
  modelRowBadge,
} from './modelEntry';
import type { ModelEntry } from './types';

const base: ModelEntry = { id: 'gpt-test', enabled: true };

describe('hasModelOverrides', () => {
  it('全缺失不算覆盖', () => {
    expect(hasModelOverrides(base)).toBe(false);
  });

  it('reasoning:false 是显式覆盖，不是跟随', () => {
    expect(hasModelOverrides({ ...base, reasoning: false })).toBe(true);
  });

  it('任一窗口/档位有值即覆盖', () => {
    expect(hasModelOverrides({ ...base, contextWindow: 64_000 })).toBe(true);
    expect(hasModelOverrides({ ...base, maxTokens: 4096 })).toBe(true);
    expect(hasModelOverrides({ ...base, thinkingLevel: 'high' })).toBe(true);
  });
});

describe('catalogMatchedFromMeta', () => {
  it('不发明 catalog：没有 meta 就 unknown', () => {
    expect(catalogMatchedFromMeta(undefined)).toBeUndefined();
  });

  it('沿用 queryModelMeta 的 source，不另造一份目录', () => {
    expect(catalogMatchedFromMeta({ source: 'catalog' })).toBe(true);
    expect(catalogMatchedFromMeta({ source: 'catalog-fallback' })).toBe(true);
    expect(catalogMatchedFromMeta({ source: 'unknown' })).toBe(false);
  });
});

describe('modelRowBadge', () => {
  it('有覆盖优先 已覆盖', () => {
    expect(modelRowBadge({ ...base, reasoning: true }, true)).toBe('override');
    expect(modelRowBadge({ ...base, reasoning: true }, false)).toBe('override');
  });

  it('无覆盖时才区分 catalog / 默认', () => {
    expect(modelRowBadge(base, true)).toBe('catalog');
    expect(modelRowBadge(base, false)).toBe('default');
  });

  it('lookup 未完成时回退跟随，不猜 catalog vs 默认', () => {
    expect(modelRowBadge(base)).toBe('inherit');
    expect(modelRowBadge(base, undefined)).toBe('inherit');
  });
});

describe('applyModelOverrides', () => {
  it('设值后能清回缺失（跟随），不会留下 null', () => {
    const set = applyModelOverrides(base, { reasoning: true, contextWindow: 32_000 });
    expect(set).toMatchObject({ reasoning: true, contextWindow: 32_000 });

    const cleared = applyModelOverrides(set, { reasoning: undefined, contextWindow: undefined });
    expect(cleared).not.toHaveProperty('reasoning');
    expect(cleared).not.toHaveProperty('contextWindow');
    expect(JSON.stringify(cleared)).toBe(JSON.stringify({ id: 'gpt-test', enabled: true }));
  });

  it('未出现在 patch 里的键保持原样', () => {
    const prev = applyModelOverrides(base, { reasoning: false, maxTokens: 2048 });
    const next = applyModelOverrides(prev, { contextWindow: 8000 });
    expect(next).toMatchObject({ reasoning: false, maxTokens: 2048, contextWindow: 8000 });
  });
});
