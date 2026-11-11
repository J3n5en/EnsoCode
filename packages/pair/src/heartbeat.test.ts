import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachHeartbeat, VISIBILITY_PROBE_MS } from './heartbeat';

class FakeWs extends EventTarget {
  readyState = 1;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
}

describe('attachHeartbeat RTT', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });
  afterEach(() => vi.useRealTimers());

  it('pong 回报从 ping 发出起的往返时延', () => {
    const ws = new FakeWs();
    const rtts: number[] = [];
    attachHeartbeat(
      ws as unknown as WebSocket,
      () => {},
      (ms) => rtts.push(ms)
    );
    expect(ws.sent).toEqual(['ping']);

    vi.setSystemTime(1_048);
    ws.dispatchEvent(Object.assign(new Event('message'), { data: 'pong' }));
    expect(rtts).toEqual([48]);
  });

  it('业务帧不算 RTT', () => {
    const ws = new FakeWs();
    const rtts: number[] = [];
    attachHeartbeat(
      ws as unknown as WebSocket,
      () => {},
      (ms) => rtts.push(ms)
    );
    vi.setSystemTime(1_020);
    ws.dispatchEvent(Object.assign(new Event('message'), { data: new ArrayBuffer(4) }));
    expect(rtts).toEqual([]);
  });
});

describe('attachHeartbeat 周期探测容错', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('单次超时不 onDead，立刻再探一次', () => {
    const ws = new FakeWs();
    const onDead = vi.fn();
    attachHeartbeat(ws as unknown as WebSocket, onDead);
    expect(ws.sent).toEqual(['ping']);

    vi.advanceTimersByTime(8_000);
    expect(onDead).not.toHaveBeenCalled();
    expect(ws.sent).toEqual(['ping', 'ping']);
  });

  it('连续两次超时才 onDead', () => {
    const ws = new FakeWs();
    const onDead = vi.fn();
    attachHeartbeat(ws as unknown as WebSocket, onDead);

    vi.advanceTimersByTime(8_000);
    expect(onDead).not.toHaveBeenCalled();
    vi.advanceTimersByTime(8_000);
    expect(onDead).toHaveBeenCalledOnce();
  });

  it('中途来一条业务帧清零超时计数', () => {
    const ws = new FakeWs();
    const onDead = vi.fn();
    attachHeartbeat(ws as unknown as WebSocket, onDead);

    vi.advanceTimersByTime(8_000);
    expect(onDead).not.toHaveBeenCalled();
    ws.dispatchEvent(Object.assign(new Event('message'), { data: new ArrayBuffer(4) }));
    // 下一周期的第一次超时也不该判死：计数已清零，不是「再加一次就满 2」
    vi.advanceTimersByTime(7_000);
    vi.advanceTimersByTime(8_000);
    expect(onDead).not.toHaveBeenCalled();

    vi.advanceTimersByTime(8_000);
    expect(onDead).toHaveBeenCalledOnce();
  });

  it('手动 probe 仍单次超时就判死', () => {
    const ws = new FakeWs();
    const onDead = vi.fn();
    const hb = attachHeartbeat(ws as unknown as WebSocket, onDead);
    hb.probe(VISIBILITY_PROBE_MS);

    vi.advanceTimersByTime(VISIBILITY_PROBE_MS);
    expect(onDead).toHaveBeenCalledOnce();
  });

  it('stop() 之后不再触发 onDead', () => {
    const ws = new FakeWs();
    const onDead = vi.fn();
    const hb = attachHeartbeat(ws as unknown as WebSocket, onDead);
    hb.stop();

    vi.advanceTimersByTime(30_000);
    expect(onDead).not.toHaveBeenCalled();
    expect(ws.sent).toEqual(['ping']);
  });
});
