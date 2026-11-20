import { describe, expect, it } from 'vitest';
import { gapResyncDelay, needsRehello, stallDelay } from './stall';

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

  it('大帧一直在传也不能无限等：未决请求挂满上限就重新 hello', () => {
    expect(needsRehello(100_000, { ready: true, helloAt: 0, pendingAt: 30_000 }, 99_000)).toBe(
      true
    );
    expect(needsRehello(100_000, { ready: true, helloAt: 50_000, pendingAt: 30_000 }, 99_000)).toBe(
      false
    );
  });
});

describe('gapResyncDelay', () => {
  it('缺口出现后大帧静默一段时间即补发', () => {
    expect(gapResyncDelay(10_000, 0, 0)).toBe(0);
    expect(gapResyncDelay(5_000, 0, 0)).toBe(3_000);
  });

  it('大帧还在传：继续等', () => {
    expect(gapResyncDelay(12_000, 0, 11_000)).toBe(7_000);
  });

  it('大帧持续不断也有上限，不会永久卡在缺口', () => {
    expect(gapResyncDelay(20_000, 0, 19_999)).toBe(0);
    expect(gapResyncDelay(18_000, 0, 17_000)).toBe(2_000);
  });

  it('链路刚切换（换中继、换通道）附近出现的缺口很快补发', () => {
    expect(gapResyncDelay(11_500, 10_000, 0, 9_500)).toBe(0);
    expect(gapResyncDelay(11_000, 10_000, 0, 9_500)).toBe(500);
    // 大帧还在传仍然等
    expect(gapResyncDelay(11_500, 10_000, 11_400, 9_500)).toBe(1_400);
    // 离切换很久的缺口按常规窗口
    expect(gapResyncDelay(11_500, 10_000, 0, 1_000)).toBe(6_500);
  });
});

describe('needsRehello 链路切换', () => {
  it('切换附近发出的请求挂了几秒没回就重新 hello', () => {
    const slot = { ready: true, helloAt: 10_000, pendingAt: 9_800 };
    expect(needsRehello(12_000, slot, 0, 10_000)).toBe(false);
    expect(needsRehello(13_000, slot, 0, 10_000)).toBe(true);
    expect(needsRehello(13_000, slot, 0)).toBe(false);
  });
});
