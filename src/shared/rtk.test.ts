import { describe, expect, it } from 'vitest';
import { parseRtkToolStats } from './rtk';

describe('RTK 统计白名单', () => {
  const stats = {
    status: 'compressed',
    originalCommand: 'git status',
    rewrittenCommand: 'rtk git status',
    inputTokens: 120,
    outputTokens: 20,
  };

  it('保留真实计数并剥离内部环境与任意字段', () => {
    const parsed = parseRtkToolStats({ ...stats, env: { secret: 'key' }, dbPath: '/private' });
    expect(parsed).toEqual(stats);
    expect(parsed).not.toBe(stats);
  });

  it('未提供统计的旁路保持未知，不伪造零计数', () => {
    expect(
      parseRtkToolStats({ status: 'bypassed', originalCommand: 'Get-Process', reason: 'native' })
    ).toEqual({ status: 'bypassed', originalCommand: 'Get-Process', reason: 'native' });
  });

  it.each([
    null,
    [],
    'bad',
    {},
    { ...stats, status: 'other' },
    { ...stats, inputTokens: -1 },
    { ...stats, outputTokens: NaN },
    { ...stats, inputTokens: Infinity },
    { ...stats, outputTokens: 1.5 },
    { ...stats, inputTokens: undefined },
    { ...stats, reason: {} },
    { ...stats, originalCommand: 4 },
  ])('脏输入不崩也不传到界面: %j', (value) => {
    expect(parseRtkToolStats(value)).toBeUndefined();
  });

  it('超长命令和原因明确截断', () => {
    const parsed = parseRtkToolStats({
      ...stats,
      originalCommand: 'x'.repeat(20_000),
      reason: 'y'.repeat(2_000),
    });
    expect(parsed?.originalCommand.length).toBeLessThan(20_000);
    expect(parsed?.originalCommand.endsWith('…')).toBe(true);
    expect(parsed?.reason?.length).toBeLessThan(2_000);
  });
});
