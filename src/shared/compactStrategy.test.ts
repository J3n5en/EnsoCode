import { describe, expect, it } from 'vitest';
import { parseCompactStrategy, resolveCompactStrategy } from './compactStrategy';

describe('compact strategy compatibility', () => {
  it('显式策略优先于 legacy smart bool', () => {
    expect(resolveCompactStrategy('standard', true)).toBe('standard');
    expect(resolveCompactStrategy('continuous-memory', true)).toBe('continuous-memory');
    expect(resolveCompactStrategy('smart', false)).toBe('smart');
  });

  it('缺少或非法显式策略时兼容旧 bool', () => {
    expect(resolveCompactStrategy(undefined, true)).toBe('smart');
    expect(resolveCompactStrategy(undefined, false)).toBe('standard');
    expect(resolveCompactStrategy('invalid', true)).toBe('smart');
  });

  it('只解析三个互斥值', () => {
    expect(parseCompactStrategy('continuous-memory')).toBe('continuous-memory');
    expect(parseCompactStrategy('plugin')).toBeNull();
  });
});
