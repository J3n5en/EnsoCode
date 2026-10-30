import { describe, expect, it } from 'vitest';
import { LeaseTable } from './leaseTable';

const never = new AbortController().signal;

describe('LeaseTable', () => {
  it('不同 key 可并行持有；同一 owner 重复申请幂等', async () => {
    const table = new LeaseTable({ waitMs: 50 });
    await table.acquire('a', ['app:1'], never);
    await table.acquire('b', ['app:2'], never);
    await table.acquire('a', ['app:1'], never);
    expect(table.holder('app:1')).toBe('a');
    expect(table.holder('app:2')).toBe('b');
  });

  it('同 key 串行：释放后等待者拿到', async () => {
    const table = new LeaseTable({ waitMs: 1000 });
    await table.acquire('a', ['app:1'], never);
    let got = false;
    const waiting = table.acquire('b', ['app:1'], never).then(() => {
      got = true;
    });
    await Promise.resolve();
    expect(got).toBe(false);
    table.releaseOwner('a');
    await waiting;
    expect(table.holder('app:1')).toBe('b');
  });

  it('等待超时报忙，并带上占用对象的名字', async () => {
    const table = new LeaseTable({ waitMs: 20 });
    await table.acquire('a', ['app:1'], never);
    await expect(table.acquire('b', ['app:1'], never, { 'app:1': 'TextEdit' })).rejects.toThrow(
      /TextEdit/
    );
    expect(table.holder('app:1')).toBe('a');
  });

  it('互相等待立即报死锁，不必等到超时', async () => {
    const table = new LeaseTable({ waitMs: 60_000 });
    await table.acquire('a', ['app:1'], never);
    await table.acquire('b', ['app:2'], never);
    const aWaits = table.acquire('a', ['app:2'], never);
    await expect(table.acquire('b', ['app:1'], never)).rejects.toMatchObject({
      code: 'lease-deadlock',
    });
    table.releaseOwner('b');
    await aWaits;
    expect(table.holder('app:2')).toBe('a');
  });

  it('中止等待：抛出中止，不留下等待边', async () => {
    const table = new LeaseTable({ waitMs: 30 });
    await table.acquire('a', ['app:1'], never);
    const controller = new AbortController();
    const waiting = table.acquire('b', ['app:1'], controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow(/aborted/);
    await table.acquire('b', ['app:2'], never);
    await expect(table.acquire('a', ['app:2'], never)).rejects.toMatchObject({
      code: 'lease-busy',
    });
  });

  it('多 key 一次申请：全部拿到才算持有；任一失败不保留本次新拿的 key', async () => {
    const table = new LeaseTable({ waitMs: 20 });
    await table.acquire('a', ['app:2'], never);
    await expect(table.acquire('b', ['fg', 'app:2'], never)).rejects.toThrow();
    expect(table.holder('fg')).toBeUndefined();
  });

  it('releaseOwner 释放该 owner 的全部 key', async () => {
    const table = new LeaseTable({ waitMs: 20 });
    await table.acquire('a', ['fg', 'app:1'], never);
    table.releaseOwner('a');
    expect(table.holder('fg')).toBeUndefined();
    expect(table.holder('app:1')).toBeUndefined();
  });
});
