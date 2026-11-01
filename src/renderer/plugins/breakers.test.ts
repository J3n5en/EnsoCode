import { describe, expect, it } from 'vitest';
import { newInterceptBreakers } from './breakers';

const plugin = (id: string, breakers?: { event: string; until: number }[]) => ({
  id,
  name: id.toUpperCase(),
  ...(breakers ? { interceptBreakers: breakers } : {}),
});

describe('拦截熔断提示', () => {
  it('只报新出现的熔断，同一次熔断不重复提示', () => {
    const seen = new Set<string>();
    const first = newInterceptBreakers([plugin('a.b', [{ event: 'tool_call', until: 10 }])], seen);
    expect(first).toEqual([{ pluginName: 'A.B', event: 'tool_call' }]);
    expect(
      newInterceptBreakers([plugin('a.b', [{ event: 'tool_call', until: 10 }])], seen)
    ).toEqual([]);
    expect(
      newInterceptBreakers([plugin('a.b', [{ event: 'tool_call', until: 99 }])], seen)
    ).toEqual([{ pluginName: 'A.B', event: 'tool_call' }]);
  });

  it('恢复后从已见集合里移除', () => {
    const seen = new Set<string>();
    newInterceptBreakers([plugin('a.b', [{ event: 'input', until: 10 }])], seen);
    newInterceptBreakers([plugin('a.b')], seen);
    expect(seen.size).toBe(0);
  });
});
