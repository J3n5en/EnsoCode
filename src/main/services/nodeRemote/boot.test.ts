import { describe, expect, it } from 'vitest';
import { waitUntil } from './boot';

describe('waitUntil', () => {
  it('probe 变真即返回 true', async () => {
    let calls = 0;
    const ok = await waitUntil(async () => ++calls >= 3, { timeoutMs: 1000, intervalMs: 1 });
    expect(ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('超时仍为假返回 false（宿主 renderer 没挂上）', async () => {
    expect(await waitUntil(async () => false, { timeoutMs: 30, intervalMs: 5 })).toBe(false);
  });

  it('probe 抛错按未就绪处理，之后成功仍返回 true', async () => {
    let calls = 0;
    const probe = async () => {
      calls += 1;
      if (calls < 2) throw new Error('page navigating');
      return true;
    };
    expect(await waitUntil(probe, { timeoutMs: 1000, intervalMs: 1 })).toBe(true);
  });
});
