import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElevationBroker } from './broker';

afterEach(() => {
  vi.useRealTimers();
});

function make(canPresent = true) {
  const changes: number[] = [];
  const broker = new ElevationBroker({
    canPresent: () => canPresent,
    changed: (views) => changes.push(views.length),
    timeoutMs: 1000,
  });
  return { broker, changes };
}

const req = (sudoPid = 10, helperPid = 11) => ({ command: 'id -u', sudoPid, helperPid });

describe('ElevationBroker', () => {
  it('请求进入待批列表，应答口令后出列', async () => {
    const { broker, changes } = make();
    const { id, outcome } = broker.request(req());
    expect(broker.list()).toEqual([
      { id, command: 'id -u', retry: false, expiresAt: expect.any(Number) },
    ]);
    expect(broker.answer(id as string, 'pw')).toBe(true);
    await expect(outcome).resolves.toEqual({ kind: 'password', password: 'pw' });
    expect(broker.list()).toEqual([]);
    expect(changes).toEqual([1, 0]);
  });

  it('只认第一个应答', async () => {
    const { broker } = make();
    const { id, outcome } = broker.request(req());
    expect(broker.answer(id as string, null)).toBe(true);
    expect(broker.answer(id as string, 'pw')).toBe(false);
    await expect(outcome).resolves.toEqual({ kind: 'declined' });
  });

  it('超时作废', async () => {
    vi.useFakeTimers();
    const { broker } = make();
    const { outcome } = broker.request(req());
    vi.advanceTimersByTime(1000);
    await expect(outcome).resolves.toEqual({ kind: 'timeout' });
    expect(broker.list()).toEqual([]);
  });

  it('没有可输入口令的界面时立即返回 unavailable，不进列表', async () => {
    const { broker, changes } = make(false);
    const { id, outcome } = broker.request(req());
    expect(id).toBeNull();
    await expect(outcome).resolves.toEqual({ kind: 'unavailable' });
    expect(changes).toEqual([]);
  });

  it('同一 sudo 或 helper 重复来要：两边都拒绝', async () => {
    const { broker } = make();
    const first = broker.request(req(10, 11));
    const second = broker.request(req(20, 11));
    await expect(first.outcome).resolves.toEqual({ kind: 'declined' });
    await expect(second.outcome).resolves.toEqual({ kind: 'declined' });
    expect(broker.list()).toEqual([]);
  });

  it('同一 sudo 交过口令后又来要，标记为重试', async () => {
    const { broker } = make();
    const first = broker.request(req(10, 11));
    broker.answer(first.id as string, 'wrong');
    await first.outcome;
    broker.request(req(10, 12));
    expect(broker.list()[0]?.retry).toBe(true);
    broker.request(req(30, 31));
    expect(broker.list()[1]?.retry).toBe(false);
  });

  it('cancel 与 declineAll 按拒绝收尾', async () => {
    const { broker } = make();
    const a = broker.request(req(1, 2));
    const b = broker.request(req(3, 4));
    broker.cancel(a.id as string);
    await expect(a.outcome).resolves.toEqual({ kind: 'declined' });
    broker.declineAll();
    await expect(b.outcome).resolves.toEqual({ kind: 'declined' });
    expect(broker.list()).toEqual([]);
  });
});
