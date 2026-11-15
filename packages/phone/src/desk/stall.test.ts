import { describe, expect, it } from 'vitest';
import { needsRehello, stallDelay } from './stall';

describe('stallDelay', () => {
  it('waits the full window after the latest activity', () => {
    expect(stallDelay(10_000, 8_000, 9_000, 5_000)).toBe(7_000);
  });

  it('keeps waiting while data is still arriving', () => {
    // 缺口出现很久了，但 1 秒前还在收分片：不算丢帧
    expect(stallDelay(30_000, 8_000, 29_000, 1_000)).toBe(7_000);
  });

  it('reports a stall once nothing arrived for the window', () => {
    expect(stallDelay(30_000, 8_000, 20_000, 1_000)).toBe(0);
  });
});

describe('needsRehello', () => {
  it('hello 久无 rpc-ready 且链路静默：重新 hello', () => {
    expect(needsRehello(10_000, { ready: false, helloAt: 0 }, 0)).toBe(true);
  });

  it('刚 hello 或还在收数据：继续等', () => {
    expect(needsRehello(2_000, { ready: false, helloAt: 0 }, 0)).toBe(false);
    expect(needsRehello(10_000, { ready: false, helloAt: 0 }, 9_000)).toBe(false);
  });

  it('已就绪：只有未决请求在静默链路上挂太久才重新 hello', () => {
    expect(needsRehello(60_000, { ready: true, helloAt: 0 }, 0)).toBe(false);
    expect(needsRehello(60_000, { ready: true, helloAt: 0, pendingAt: 50_000 }, 0)).toBe(false);
    expect(needsRehello(60_000, { ready: true, helloAt: 0, pendingAt: 30_000 }, 0)).toBe(true);
    expect(needsRehello(60_000, { ready: true, helloAt: 0, pendingAt: 30_000 }, 55_000)).toBe(
      false
    );
  });
});
