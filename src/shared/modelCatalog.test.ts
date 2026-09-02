import { describe, expect, it } from 'vitest';
import {
  findCatalogModelById,
  pickModelCapabilityOverrides,
  positiveFiniteNumber,
  resolveCustomModelCapabilities,
  resolveCustomModelView,
  thinkingLevelMapForCap,
} from './modelCatalog';

const sonnetCatalog = {
  id: 'claude-sonnet-4',
  reasoning: true,
  thinkingLevelMap: { max: 'max' },
  contextWindow: 200_000,
  maxTokens: 64_000,
} as const;

const noReasoningCatalog = {
  id: 'gpt-4.1',
  reasoning: false,
  contextWindow: 1_047_576,
  maxTokens: 32_768,
} as const;

describe('findCatalogModelById', () => {
  it('只按精确 id 命中，不按前缀', () => {
    const catalog = [sonnetCatalog, { id: 'claude-sonnet-4-5', reasoning: true }];
    expect(findCatalogModelById(catalog, 'claude-sonnet-4')).toEqual(sonnetCatalog);
    expect(findCatalogModelById(catalog, 'claude-sonnet')).toBeUndefined();
    expect(findCatalogModelById(catalog, 'claude-sonnet-4-5')?.id).toBe('claude-sonnet-4-5');
  });
});

describe('pickModelCapabilityOverrides', () => {
  it('空 / 非法覆盖视为跟随，不发明数字', () => {
    expect(pickModelCapabilityOverrides(undefined)).toEqual({});
    expect(
      pickModelCapabilityOverrides({
        reasoning: 'follow' as never,
        thinkingLevel: '' as never,
        contextWindow: 0,
        maxTokens: Number.NaN,
      })
    ).toEqual({});
  });

  it('只保留合法覆盖', () => {
    expect(
      pickModelCapabilityOverrides({
        reasoning: 'off',
        thinkingLevel: 'high',
        contextWindow: 128_000,
        maxTokens: 8_000,
      })
    ).toEqual({
      reasoning: 'off',
      thinkingLevel: 'high',
      contextWindow: 128_000,
      maxTokens: 8_000,
    });
  });
});

describe('resolveCustomModelCapabilities', () => {
  it('catalog 命中官方 id 时用 catalog 的 reasoning / 档位 / 窗口', () => {
    const resolved = resolveCustomModelCapabilities(sonnetCatalog, {});
    expect(resolved.reasoning).toBe(true);
    expect(resolved.thinkingLevelMap).toEqual({ max: 'max' });
    expect(resolved.thinkingLevels).toEqual(['minimal', 'low', 'medium', 'high', 'max']);
    expect(resolved.contextWindow).toBe(200_000);
    expect(resolved.maxTokens).toBe(64_000);
    expect(resolved.source).toEqual({
      reasoning: 'catalog',
      thinkingLevel: 'catalog',
      contextWindow: 'catalog',
      maxTokens: 'catalog',
    });
  });

  it('catalog 命中但 reasoning:false 时不套乐观 {max:max}', () => {
    const resolved = resolveCustomModelCapabilities(noReasoningCatalog);
    expect(resolved.reasoning).toBe(false);
    expect(resolved.thinkingLevelMap).toBeUndefined();
    expect(resolved.thinkingLevels).toEqual([]);
    expect(resolved.source.reasoning).toBe('catalog');
    expect(resolved.source.thinkingLevel).toBe('catalog');
  });

  it('catalog 未命中保持今日乐观默认，窗口不填假数字', () => {
    const resolved = resolveCustomModelCapabilities(undefined, {});
    expect(resolved.reasoning).toBe(true);
    expect(resolved.thinkingLevelMap).toEqual({ xhigh: 'xhigh', max: 'max' });
    expect(resolved.thinkingLevels).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(resolved.contextWindow).toBeUndefined();
    expect(resolved.maxTokens).toBeUndefined();
    expect(resolved.source).toEqual({
      reasoning: 'default',
      thinkingLevel: 'default',
      contextWindow: 'default',
      maxTokens: 'default',
    });
  });

  it('行覆盖压过 catalog', () => {
    const resolved = resolveCustomModelCapabilities(sonnetCatalog, {
      reasoning: 'off',
      thinkingLevel: 'low',
      contextWindow: 64_000,
      maxTokens: 4_000,
    });
    expect(resolved.reasoning).toBe(false);
    expect(resolved.thinkingLevelMap).toBeUndefined();
    expect(resolved.thinkingLevels).toEqual([]);
    expect(resolved.contextWindow).toBe(64_000);
    expect(resolved.maxTokens).toBe(4_000);
    expect(resolved.source).toEqual({
      reasoning: 'override',
      thinkingLevel: 'override',
      contextWindow: 'override',
      maxTokens: 'override',
    });
  });

  it('只覆盖思考档时 reasoning 仍跟随 catalog', () => {
    const resolved = resolveCustomModelCapabilities(sonnetCatalog, { thinkingLevel: 'high' });
    expect(resolved.reasoning).toBe(true);
    expect(resolved.thinkingLevelMap).toBeUndefined();
    expect(resolved.thinkingLevels).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(resolved.source.reasoning).toBe('catalog');
    expect(resolved.source.thinkingLevel).toBe('override');
    expect(resolved.source.contextWindow).toBe('catalog');
  });

  it('空覆盖跟随 catalog；未命中则跟随乐观默认', () => {
    const followCatalog = resolveCustomModelCapabilities(sonnetCatalog, {
      reasoning: undefined,
      thinkingLevel: undefined,
      contextWindow: undefined,
      maxTokens: undefined,
    });
    expect(followCatalog.source.reasoning).toBe('catalog');
    expect(followCatalog.reasoning).toBe(sonnetCatalog.reasoning);
    expect(followCatalog.thinkingLevelMap).toEqual(sonnetCatalog.thinkingLevelMap);

    const followDefault = resolveCustomModelCapabilities(undefined, {
      reasoning: 'on' as const,
    });
    expect(followDefault.reasoning).toBe(true);
    expect(followDefault.source.reasoning).toBe('override');
    expect(followDefault.thinkingLevelMap).toEqual({ xhigh: 'xhigh', max: 'max' });
    expect(followDefault.source.thinkingLevel).toBe('default');
  });

  it('reasoning:on 覆盖在 catalog 未命中时仍用乐观档', () => {
    const resolved = resolveCustomModelCapabilities(undefined, { reasoning: 'on' });
    expect(resolved.reasoning).toBe(true);
    expect(resolved.thinkingLevelMap).toEqual({ xhigh: 'xhigh', max: 'max' });
    expect(resolved.source.thinkingLevel).toBe('default');
  });
});

describe('thinkingLevelMapForCap', () => {
  it('max 显式声明，high 不声明 max，更低档剔除更高项目档', () => {
    expect(thinkingLevelMapForCap('max')).toEqual({ xhigh: 'xhigh', max: 'max' });
    expect(thinkingLevelMapForCap('xhigh')).toEqual({ xhigh: 'xhigh' });
    expect(thinkingLevelMapForCap('high')).toBeUndefined();
    expect(thinkingLevelMapForCap('medium')).toEqual({ high: null });
    expect(thinkingLevelMapForCap('low')).toEqual({ medium: null, high: null });
    expect(thinkingLevelMapForCap('minimal')).toEqual({ low: null, medium: null, high: null });
  });
});

describe('resolveCustomModelView', () => {
  it('catalog-fallback meta + 行覆盖：覆盖赢，source 可读', () => {
    const view = resolveCustomModelView(
      { reasoning: 'off', contextWindow: 64_000 },
      {
        modelId: 'claude-sonnet-4',
        source: 'catalog-fallback',
        reasoning: true,
        thinkingLevels: ['low', 'medium', 'high', 'max'],
        contextWindow: 200_000,
        maxTokens: 64_000,
      }
    );
    expect(view.reasoning).toBe(false);
    expect(view.source.reasoning).toBe('override');
    expect(view.source.thinkingLevel).toBe('catalog');
    expect(view.contextWindow).toBe(64_000);
    expect(view.source.contextWindow).toBe('override');
    expect(view.maxTokens).toBe(64_000);
    expect(view.source.maxTokens).toBe('catalog');
  });

  it('unknown meta 且无覆盖 → 乐观默认', () => {
    const view = resolveCustomModelView(undefined, {
      modelId: 'relay-foo',
      source: 'unknown',
    });
    expect(view.source.reasoning).toBe('default');
    expect(view.thinkingLevelMap).toEqual({ xhigh: 'xhigh', max: 'max' });
  });
});

describe('positiveFiniteNumber', () => {
  it('非正 / 非有限视为缺失', () => {
    expect(positiveFiniteNumber(128_000)).toBe(128_000);
    expect(positiveFiniteNumber(0)).toBeUndefined();
    expect(positiveFiniteNumber(-1)).toBeUndefined();
    expect(positiveFiniteNumber(Number.NaN)).toBeUndefined();
    expect(positiveFiniteNumber(undefined)).toBeUndefined();
  });
});
