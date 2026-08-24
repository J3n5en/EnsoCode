import { describe, expect, it } from 'vitest';
import { applyAgentEvent, emptyProjection, type SessionProjection } from './reducer';

const base: SessionProjection = { ...emptyProjection };

describe('applyAgentEvent', () => {
  it('seq 过期的事件被丢弃，投影不回退', () => {
    const advanced = applyAgentEvent(base, 's1', {
      type: 'status',
      sessionId: 's1',
      seq: 5,
      status: 'running',
    });
    const stale = applyAgentEvent(advanced, 's1', {
      type: 'status',
      sessionId: 's1',
      seq: 3,
      status: 'idle',
    });
    expect(stale).toBe(advanced);
  });

  it('其它会话的事件不影响本会话投影', () => {
    const next = applyAgentEvent(base, 's1', {
      type: 'status',
      sessionId: 's2',
      seq: 1,
      status: 'running',
    });
    expect(next).toBe(base);
  });

  it('message-upsert 按 index 幂等写入，可越界追加', () => {
    const first = applyAgentEvent(base, 's1', {
      type: 'message-upsert',
      sessionId: 's1',
      seq: 1,
      index: 0,
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    });
    const updated = applyAgentEvent(first, 's1', {
      type: 'message-upsert',
      sessionId: 's1',
      seq: 2,
      index: 0,
      message: { role: 'user', content: [{ type: 'text', text: 'hi!' }] },
    });
    expect(updated.messages).toHaveLength(1);
    expect(updated.messages[0].content).toEqual([{ type: 'text', text: 'hi!' }]);
  });

  it('turn-failed 记录错误并进入 failed', () => {
    const next = applyAgentEvent(base, 's1', {
      type: 'turn-failed',
      sessionId: 's1',
      seq: 1,
      error: 'boom',
    });
    expect(next.status).toBe('failed');
    expect(next.error).toBe('boom');
  });

  it('worker-exited 无 seq 门槛，任何时刻都把会话标 failed', () => {
    const next = applyAgentEvent(base, 's1', { type: 'worker-exited' });
    expect(next.status).toBe('failed');
  });
});
