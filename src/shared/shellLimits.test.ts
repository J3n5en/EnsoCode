import { describe, expect, it } from 'vitest';
import { resolveShellLimits, SHELL_LIMITS } from './shellLimits';

describe('resolveShellLimits', () => {
  it('缺省 / 脏输入回落到默认常量', () => {
    expect(resolveShellLimits(undefined)).toEqual(SHELL_LIMITS);
    expect(resolveShellLimits(null)).toEqual(SHELL_LIMITS);
    expect(resolveShellLimits('x')).toEqual(SHELL_LIMITS);
    expect(resolveShellLimits([1, 2])).toEqual(SHELL_LIMITS);
  });

  it('只接受正的有限数，坏值逐项回落', () => {
    const limits = resolveShellLimits({
      yieldDefaultMs: 30_000,
      yieldBuildMs: -1,
      yieldServerMs: Number.NaN,
      taskWaitMaxMs: '5000',
      maxTasks: 12.7,
      unknownKey: 1,
    });
    expect(limits.yieldDefaultMs).toBe(30_000);
    expect(limits.yieldBuildMs).toBe(SHELL_LIMITS.yieldBuildMs);
    expect(limits.yieldServerMs).toBe(SHELL_LIMITS.yieldServerMs);
    expect(limits.taskWaitMaxMs).toBe(SHELL_LIMITS.taskWaitMaxMs);
    expect(limits.maxTasks).toBe(12);
    expect(limits).not.toHaveProperty('unknownKey');
  });

  it('超出 setTimeout 上限的毫秒值被拒绝', () => {
    expect(resolveShellLimits({ yieldBuildMs: 3_000_000_000 }).yieldBuildMs).toBe(
      SHELL_LIMITS.yieldBuildMs
    );
  });

  it('默认值与裁决一致', () => {
    expect(SHELL_LIMITS).toMatchObject({
      yieldDefaultMs: 45_000,
      yieldBuildMs: 180_000,
      yieldServerMs: 10_000,
      taskWaitMaxMs: 30_000,
      maxTasks: 20,
      logMaxBytes: 256 * 1024 * 1024,
      killGraceMs: 5_000,
    });
  });
});
