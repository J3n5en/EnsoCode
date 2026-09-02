import { describe, expect, it } from 'vitest';
import { clampProjectThinkingLevel, supportedProjectThinkingLevels } from './modelThinking';

describe('supportedProjectThinkingLevels', () => {
  it('reasoning:false 明确不支持任何项目档', () => {
    expect(supportedProjectThinkingLevels({ reasoning: false })).toEqual([]);
    expect(
      supportedProjectThinkingLevels({ reasoning: false, thinkingLevelMap: { max: 'max' } })
    ).toEqual([]);
  });

  it('无 thinkingLevelMap 时只有默认档（xhigh/max 未显式声明）', () => {
    expect(supportedProjectThinkingLevels({ reasoning: true })).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);
  });

  it('thinkingLevelMap 声明 max 后仍不含未声明的 xhigh', () => {
    expect(
      supportedProjectThinkingLevels({ reasoning: true, thinkingLevelMap: { max: 'max' } })
    ).toEqual(['minimal', 'low', 'medium', 'high', 'max']);
  });

  it('thinkingLevelMap 同时声明 xhigh/max 后六档全开', () => {
    expect(
      supportedProjectThinkingLevels({
        reasoning: true,
        thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
      })
    ).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('thinkingLevelMap 里 null 明确剔除该档，xhigh/max 仍需显式声明', () => {
    expect(
      supportedProjectThinkingLevels({ reasoning: true, thinkingLevelMap: { medium: null } })
    ).toEqual(['minimal', 'low', 'high']);
    expect(
      supportedProjectThinkingLevels({
        reasoning: true,
        thinkingLevelMap: { medium: null, max: 'max' },
      })
    ).toEqual(['minimal', 'low', 'high', 'max']);
  });
});

describe('clampProjectThinkingLevel', () => {
  it('向上无可用档时向下落到最近支持档', () => {
    expect(clampProjectThinkingLevel('max', ['low', 'medium', 'high'])).toBe('high');
  });

  it('当前档不支持时优先向上', () => {
    expect(clampProjectThinkingLevel('medium', ['high', 'max'])).toBe('high');
  });

  it('supported 为 undefined 时未知不加限制', () => {
    expect(clampProjectThinkingLevel('max', undefined)).toBe('max');
  });
});
