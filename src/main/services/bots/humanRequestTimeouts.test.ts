import type { AgentWorkerEvent, SessionIdentity } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { HumanRequestTimeouts } from './humanRequestTimeouts';

const TEN_MIN = 600_000;
const identity: SessionIdentity = { sessionId: 's1', generation: 'g1' };

const approval = (requestId: string, expiresAt?: number, phase?: 'reviewing') =>
  ({
    type: 'approval-request',
    identity,
    seq: 1,
    request: {
      requestId,
      tool: 'bash',
      kind: 'command',
      summary: 'ls',
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(phase ? { phase } : {}),
    },
  }) as AgentWorkerEvent;
const ask = (requestId: string, expiresAt: number) =>
  ({
    type: 'ask-request',
    identity,
    seq: 1,
    ask: { requestId, question: 'q', expiresAt },
  }) as AgentWorkerEvent;

const make = (start = 1_000) => {
  let now = start;
  const fired: string[] = [];
  const timeouts = new HumanRequestTimeouts({
    now: () => now,
    expire: (id, kind, requestId) => fired.push(`${id.sessionId}:${kind}:${requestId}`),
  });
  return { timeouts, fired, advance: (ms: number) => (now += ms), at: (t: number) => (now = t) };
};

describe('HumanRequestTimeouts', () => {
  it('到 expiresAt 才按超时处理，且只处理一次', () => {
    const { timeouts, fired, advance } = make();
    timeouts.observe(approval('r1', 1_000 + TEN_MIN));
    timeouts.observe(ask('q1', 1_000 + TEN_MIN));
    advance(TEN_MIN - 1);
    timeouts.check();
    expect(fired).toEqual([]);
    advance(1);
    timeouts.check();
    timeouts.check();
    expect(fired).toEqual(['s1:approval:r1', 's1:ask:q1']);
  });

  it('休眠醒来已过期的卡片立即按超时处理，不重新计时', () => {
    const { timeouts, fired, advance } = make();
    timeouts.observe(approval('r1', 1_000 + TEN_MIN));
    advance(3 * TEN_MIN);
    timeouts.check();
    expect(fired).toEqual(['s1:approval:r1']);
  });

  it('以 Main 首次看到的时间为上限：worker 给的截止时间偏晚也不超过 10 分钟', () => {
    const { timeouts, fired, advance } = make();
    timeouts.observe(approval('r1', 1_000 + 5 * TEN_MIN));
    advance(TEN_MIN);
    timeouts.check();
    expect(fired).toEqual(['s1:approval:r1']);
  });

  it('已处理的、代审中的、未开启超时的都不计时', () => {
    const { timeouts, fired, advance } = make();
    timeouts.observe(approval('r1', 1_000 + TEN_MIN));
    timeouts.observe({
      type: 'approval-resolved',
      identity,
      seq: 2,
      requestId: 'r1',
    } as AgentWorkerEvent);
    timeouts.observe(ask('q1', 1_000 + TEN_MIN));
    timeouts.observe({
      type: 'ask-resolved',
      identity,
      seq: 3,
      requestId: 'q1',
    } as AgentWorkerEvent);
    timeouts.observe(approval('r2', 1_000 + TEN_MIN, 'reviewing'));
    timeouts.observe(approval('r3'));
    advance(2 * TEN_MIN);
    timeouts.check();
    expect(fired).toEqual([]);
  });

  it('同一请求重复上报不重新计时', () => {
    const { timeouts, fired, advance } = make();
    timeouts.observe(approval('r1', 1_000 + TEN_MIN));
    advance(TEN_MIN - 10);
    timeouts.observe(approval('r1', 1_000 + TEN_MIN + TEN_MIN));
    advance(10);
    timeouts.check();
    expect(fired).toEqual(['s1:approval:r1']);
  });

  it('expire 抛错（会话已不在）不影响其余卡片', () => {
    let now = 0;
    const fired: string[] = [];
    const timeouts = new HumanRequestTimeouts({
      now: () => now,
      expire: (_id, _kind, requestId) => {
        if (requestId === 'r1') throw new Error('stale');
        fired.push(requestId);
      },
    });
    timeouts.observe(approval('r1', TEN_MIN));
    timeouts.observe(approval('r2', TEN_MIN));
    now = TEN_MIN;
    timeouts.check();
    expect(fired).toEqual(['r2']);
  });
});

describe('HumanRequestTimeouts worker 退出', () => {
  it('worker 退出后清空，不再对旧卡片发超时', () => {
    const { timeouts, fired, advance } = make();
    timeouts.observe(approval('r1', 1_000 + TEN_MIN));
    timeouts.observe({ type: 'worker-exited' });
    advance(TEN_MIN);
    timeouts.check();
    expect(fired).toEqual([]);
  });
});
