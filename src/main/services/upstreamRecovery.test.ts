import { describe, expect, it, vi } from 'vitest';
import {
  createUpstreamRecoveryService,
  reseatUpstreamWaiters,
  UpstreamHealthGate,
  type UpstreamWakeEvent,
} from './upstreamRecovery';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('UpstreamHealthGate', () => {
  it('allows only one probing waiter per degraded provider while others wait', () => {
    const gate = new UpstreamHealthGate({ random: () => 0.5 });
    const t0 = 1_700_000_000_000;

    const r1 = gate.reportFailure(
      { id: 's1', kind: 'session', provider: 'openai', errorKind: 'transient', lastError: '503' },
      t0
    );
    const r2 = gate.reportFailure(
      { id: 's2', kind: 'session', provider: 'openai', errorKind: 'transient', lastError: '503' },
      t0 + 100
    );
    const r3 = gate.reportFailure(
      {
        id: 'sub1',
        kind: 'subagent',
        provider: 'openai',
        errorKind: 'transient',
        lastError: '503',
      },
      t0 + 200
    );

    expect(r1.action).toBe('wait');
    expect(r2.action).toBe('wait');
    expect(r3.action).toBe('wait');

    // 到点时 3 个 waiter 都到期，但同一 provider 只放 1 个探测
    const due1 = gate.takeDue(t0 + MIN + 500);
    expect(due1).toHaveLength(1);
    expect(due1[0]!.waiter.id).toBe('s1');
    expect(due1[0]!.reason).toBe('probe');

    // 探针尚未返回结果前，再推进时间也不放第二个
    expect(gate.takeDue(t0 + 2 * MIN)).toHaveLength(0);

    const snap = gate.snapshot('openai');
    expect(snap?.state).toBe('probing');
    expect(snap?.probingWaiterId).toBe('s1');
    expect(snap?.waitingCount).toBe(3);
  });

  it('returns to degraded and backs off further when probe fails', () => {
    const gate = new UpstreamHealthGate({ random: () => 0 });
    const t0 = 1_700_000_000_000;

    gate.reportFailure(
      { id: 's1', kind: 'session', provider: 'openai', errorKind: 'transient', lastError: '503' },
      t0
    );
    gate.reportFailure(
      { id: 's2', kind: 'session', provider: 'openai', errorKind: 'transient', lastError: '503' },
      t0 + 1000
    );

    const [probe] = gate.takeDue(t0 + MIN);
    expect(probe?.waiter.id).toBe('s1');

    // 探针失败：attempt 递增到 2（下次退避 2 分钟），provider 回到 degraded
    const failed = gate.reportFailure(
      { id: 's1', kind: 'session', provider: 'openai', errorKind: 'transient', lastError: '503' },
      t0 + MIN + 500
    );
    expect(failed.action).toBe('wait');
    if (failed.action === 'wait') {
      expect(failed.waiter.attempt).toBe(2);
      expect(failed.waiter.nextAt).toBe(t0 + MIN + 500 + 2 * MIN);
    }
    expect(gate.snapshot('openai')?.state).toBe('degraded');
    expect(gate.snapshot('openai')?.probingWaiterId).toBeUndefined();

    // 此时 s2 已到点（t0+1000+1m），下一轮可由 s2 做探测
    const [nextProbe] = gate.takeDue(t0 + MIN + 1500);
    expect(nextProbe?.waiter.id).toBe('s2');
  });

  it('wakes remaining waiters with bounded concurrency and jitter after provider recovers', () => {
    const gate = new UpstreamHealthGate({
      wakeConcurrency: 2,
      wakeBaseJitterMs: 1000,
      wakeStaggerMs: 3000,
      random: () => 0.5, // jitter = 500ms
    });
    const t0 = 1_700_000_000_000;

    for (const id of ['s1', 's2', 's3', 's4', 's5']) {
      gate.reportFailure(
        { id, kind: 'session', provider: 'p1', errorKind: 'transient', lastError: '503' },
        t0
      );
    }

    const [probe] = gate.takeDue(t0 + MIN);
    expect(probe?.waiter.id).toBe('s1');

    // 探针成功：provider 回到 ok，剩余 4 个 waiter 被排进 2 批（每批 2 个，错开 3000ms）
    const recoveredAt = t0 + MIN + 200;
    gate.reportSuccess('p1', 's1', recoveredAt);
    expect(gate.snapshot('p1')).toBeUndefined();

    // 恢复瞬间先不炸出全部（有抖动延迟 500ms）
    expect(gate.takeDue(recoveredAt)).toHaveLength(0);

    // 第 1 批（+500ms）只放 2 个
    const batch1 = gate.takeDue(recoveredAt + 500);
    expect(batch1.map((x) => x.waiter.id)).toEqual(['s2', 's3']);
    expect(batch1.every((x) => x.reason === 'recovered')).toBe(true);

    // 还没到第 2 批
    expect(gate.takeDue(recoveredAt + 2000)).toHaveLength(0);

    // 第 2 批（+3500ms）放最后 2 个
    const batch2 = gate.takeDue(recoveredAt + 3500);
    expect(batch2.map((x) => x.waiter.id)).toEqual(['s4', 's5']);
    expect(gate.allWaiters()).toHaveLength(0);
  });

  it('keeps different providers isolated', () => {
    const gate = new UpstreamHealthGate({ random: () => 0 });
    const t0 = 1_700_000_000_000;

    gate.reportFailure(
      { id: 'a1', kind: 'session', provider: 'provA', errorKind: 'transient', lastError: '503' },
      t0
    );
    gate.reportFailure(
      { id: 'b1', kind: 'session', provider: 'provB', errorKind: 'transient', lastError: '502' },
      t0
    );

    const due = gate.takeDue(t0 + MIN);
    expect(due.map((x) => x.waiter.id).sort()).toEqual(['a1', 'b1']);

    gate.reportSuccess('provA', 'a1', t0 + MIN + 100);
    expect(gate.snapshot('provA')).toBeUndefined();
    expect(gate.snapshot('provB')?.state).toBe('probing');
  });

  it('never wakes a cancelled waiter even after provider recovers, and frees probe slot', () => {
    const gate = new UpstreamHealthGate({ random: () => 0 });
    const t0 = 1_700_000_000_000;

    gate.reportFailure(
      { id: 's1', kind: 'session', provider: 'p1', errorKind: 'transient', lastError: '503' },
      t0
    );
    gate.reportFailure(
      { id: 's2', kind: 'session', provider: 'p1', errorKind: 'transient', lastError: '503' },
      t0
    );

    const [probe] = gate.takeDue(t0 + MIN);
    expect(probe?.waiter.id).toBe('s1');

    // 手动停止 s1：释放探针槽位，s2 立刻可以顶上探测
    expect(gate.cancel('s1')).toBe(true);
    expect(gate.snapshot('p1')?.probingWaiterId).toBeUndefined();

    const [probe2] = gate.takeDue(t0 + MIN + 10);
    expect(probe2?.waiter.id).toBe('s2');

    // 手动停止 s2，随后同 provider 其他会话成功，s1 和 s2 都绝不再被唤醒
    expect(gate.cancel('s2')).toBe(true);
    gate.reportSuccess('p1', 'other', t0 + MIN + 50);
    expect(gate.takeDue(t0 + 10 * MIN)).toHaveLength(0);
  });

  it('returns exhausted when total retry window is exceeded', () => {
    const gate = new UpstreamHealthGate({ random: () => 0 });
    const t0 = 1_700_000_000_000;

    gate.reportFailure(
      { id: 's1', kind: 'session', provider: 'p1', errorKind: 'transient', lastError: '503' },
      t0
    );
    const res = gate.reportFailure(
      { id: 's1', kind: 'session', provider: 'p1', errorKind: 'transient', lastError: '503' },
      t0 + 6 * HOUR
    );
    expect(res.action).toBe('exhausted');
    expect(gate.getWaiter('s1')).toBeUndefined();
  });

  it('allows manual retryNow to immediately release a waiting session', () => {
    const gate = new UpstreamHealthGate({ random: () => 0 });
    const t0 = 1_700_000_000_000;

    gate.reportFailure(
      { id: 's1', kind: 'session', provider: 'p1', errorKind: 'transient', lastError: '503' },
      t0
    );
    const manual = gate.retryNow('s1', t0 + 5_000);
    expect(manual?.reason).toBe('manual');
    expect(manual?.waiter.id).toBe('s1');
    expect(gate.snapshot('p1')?.state).toBe('probing');
    expect(gate.snapshot('p1')?.probingWaiterId).toBe('s1');
  });

  it('requeue 把无人接住的 probe 按原退避进度放回队列并释放 probe 槽位', () => {
    const gate = new UpstreamHealthGate({ random: () => 0 });
    const t0 = 1_700_000_000_000;

    gate.reportFailure(
      { id: 's1', kind: 'session', provider: 'p1', errorKind: 'transient', lastError: '503' },
      t0
    );
    gate.reportFailure(
      { id: 's2', kind: 'session', provider: 'p1', errorKind: 'transient', lastError: '503' },
      t0
    );

    const [probe] = gate.takeDue(t0 + MIN);
    expect(probe?.waiter.id).toBe('s1');
    // probe 期间同 provider 其他 waiter 顶不上来
    expect(gate.takeDue(t0 + MIN + 100)).toHaveLength(0);

    // 探测从未真正发生（worker 死了）：重排后槽位释放、退避进度沿用（attempt=1 -> 下次 2 分钟）
    expect(gate.requeue(probe!.waiter, t0 + MIN + 100)).toBe(true);
    expect(gate.snapshot('p1')?.probingWaiterId).toBeUndefined();
    const waiter = gate.getWaiter('s1');
    expect(waiter?.since).toBe(t0);
    expect(waiter?.attempt).toBe(1);
    expect(waiter?.nextAt).toBe(t0 + MIN + 100 + MIN);

    // 已到点的 s2 现在可以顶上探测
    const [probe2] = gate.takeDue(t0 + MIN + 200);
    expect(probe2?.waiter.id).toBe('s2');
  });

  it('requeue 拒绝重复登记仍在闸门里的 waiter，provider 已恢复（无降级桶）时不收留', () => {
    const gate = new UpstreamHealthGate({ random: () => 0 });
    const t0 = 1_700_000_000_000;

    gate.reportFailure(
      { id: 's1', kind: 'session', provider: 'p1', errorKind: 'transient', lastError: '503' },
      t0
    );
    expect(
      gate.requeue(
        {
          id: 's1',
          kind: 'session',
          provider: 'p1',
          errorKind: 'transient',
          attempt: 1,
          since: t0,
          nextAt: t0,
          lastError: '503',
        },
        t0
      )
    ).toBe(false);

    // provider 恢复后桶没了：recovered 队列掉出的 waiter 不放回
    const [probe] = gate.takeDue(t0 + MIN);
    gate.reportSuccess('p1', 's1', t0 + MIN);
    expect(gate.requeue({ ...probe!.waiter, id: 's9' }, t0 + MIN + 1)).toBe(false);
  });
});

describe('reseatUpstreamWaiters 重启重注册', () => {
  const retryOf = (over: Record<string, unknown> = {}) => ({
    reason: 'upstream',
    kind: 'transient',
    provider: 'anthropic',
    attempt: 2,
    since: 1_700_000_000_000,
    at: 1_700_000_060_000,
    lastError: '503 No available accounts',
    ...over,
  });

  it('磁盘上 waiting(upstream) 的会话重进闸门，沿用 since/attempt；超窗与非 waiting 不登记', () => {
    vi.useFakeTimers();
    try {
      const start = 1_700_000_000_000 + 30_000;
      vi.setSystemTime(start);
      const wakes: UpstreamWakeEvent[] = [];
      const service = createUpstreamRecoveryService({
        now: () => Date.now(),
        random: () => 0,
        onWake: (event) => {
          wakes.push(event);
        },
      });

      const rows = {
        s1: { driver: 'main', goal: { text: 'g', status: 'waiting', retry: retryOf() } },
        // active 目标不登记
        s2: { driver: 'main', goal: { text: 'g', status: 'active' } },
        // 已超 6h 窗口的不登记
        s3: {
          driver: 'main',
          goal: {
            text: 'g',
            status: 'waiting',
            retry: retryOf({ since: start - 7 * 60 * 60_000 }),
          },
        },
        // 没有 goal 的行不登记
        s4: { driver: 'main' },
      };

      const count = reseatUpstreamWaiters(service, rows, start);
      expect(count).toBe(1);

      const waiter = service.getWaiter('s1');
      expect(waiter).toBeDefined();
      expect(waiter?.since).toBe(1_700_000_000_000);
      expect(waiter?.attempt).toBe(2);
      expect(service.getWaiter('s2')).toBeUndefined();
      expect(service.getWaiter('s3')).toBeUndefined();

      // attempt=2 -> 退避 2 分钟，到点真正唤醒
      vi.advanceTimersByTime(2 * MIN);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.waiter.id).toBe('s1');

      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createUpstreamRecoveryService', () => {
  it('schedules timers, emits health snapshots, and invokes wake callback on due and recovery', () => {
    vi.useFakeTimers();
    try {
      const start = 1_700_000_000_000;
      vi.setSystemTime(start);
      const wakes: UpstreamWakeEvent[] = [];
      const changes: number[] = [];

      const service = createUpstreamRecoveryService({
        now: () => Date.now(),
        random: () => 0,
        wakeConcurrency: 2,
        wakeBaseJitterMs: 500,
        wakeStaggerMs: 2000,
        onWake: (event) => {
          wakes.push(event);
        },
        onHealthChange: (snaps) => changes.push(snaps.length),
      });

      service.reportFailure({
        id: 's1',
        kind: 'session',
        provider: 'p1',
        errorKind: 'transient',
        lastError: '503 No available accounts',
      });
      service.reportFailure({
        id: 's2',
        kind: 'session',
        provider: 'p1',
        errorKind: 'transient',
        lastError: '503 No available accounts',
      });

      expect(service.snapshots()).toHaveLength(1);
      expect(changes.length).toBeGreaterThan(0);

      // 推进 1 分钟：只唤醒 1 个探测者
      vi.advanceTimersByTime(MIN);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.waiter.id).toBe('s1');

      // 探测成功：s2 很快被限流唤醒
      service.reportSuccess('p1', 's1');
      expect(service.snapshots()).toHaveLength(0);
      vi.advanceTimersByTime(100);
      expect(wakes).toHaveLength(2);
      expect(wakes[1]!.waiter.id).toBe('s2');
      expect(wakes[1]!.reason).toBe('recovered');

      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('onWake 返回 false 时按原退避进度重排 waiter，倒计时到点再次唤醒而不是消失', () => {
    vi.useFakeTimers();
    try {
      const start = 1_700_000_000_000;
      vi.setSystemTime(start);
      const wakes: UpstreamWakeEvent[] = [];
      // 第一次唤醒无人接住（返回 false），第二次接住
      let catchCount = 0;
      const service = createUpstreamRecoveryService({
        now: () => Date.now(),
        random: () => 0,
        onWake: (event) => {
          wakes.push(event);
          catchCount += 1;
          return catchCount >= 2;
        },
      });

      service.reportFailure({
        id: 's1',
        kind: 'session',
        provider: 'p1',
        errorKind: 'transient',
        lastError: '503 No available accounts',
      });

      // 到点唤醒：无人接住 -> 重排，waiter 仍在闸门里
      vi.advanceTimersByTime(MIN);
      expect(wakes).toHaveLength(1);
      expect(service.getWaiter('s1')).toBeDefined();
      expect(service.snapshots()).toHaveLength(1);

      // 下一个退避点到：再次唤醒（attempt=2 -> 2 分钟）
      vi.advanceTimersByTime(2 * MIN);
      expect(wakes).toHaveLength(2);
      expect(wakes[1]!.waiter.id).toBe('s1');

      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('onWake 返回 true/void 时不重排：已接管的 waiter 就此离开闸门', () => {
    vi.useFakeTimers();
    try {
      const start = 1_700_000_000_000;
      vi.setSystemTime(start);
      const wakes: UpstreamWakeEvent[] = [];
      const service = createUpstreamRecoveryService({
        now: () => Date.now(),
        random: () => 0,
        onWake: (event) => {
          wakes.push(event);
          return true;
        },
      });

      service.reportFailure({
        id: 's1',
        kind: 'session',
        provider: 'p1',
        errorKind: 'transient',
        lastError: '503',
      });
      vi.advanceTimersByTime(MIN);
      expect(wakes).toHaveLength(1);
      vi.advanceTimersByTime(10 * MIN);
      expect(wakes).toHaveLength(1);

      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
