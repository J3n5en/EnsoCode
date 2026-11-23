import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BulkWindow } from './bulkWindow';

describe('BulkWindow', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('passes everything through until the browser starts acking (old shells)', () => {
    const sent: string[] = [];
    const win = new BulkWindow<string>((item) => sent.push(item), { windowBytes: 10 });
    win.push('a', 8);
    win.push('b', 8);
    win.push('c', 8);
    expect(sent).toEqual(['a', 'b', 'c']);
  });

  it('keeps at most a window of unacked bytes in flight once acks arrive', () => {
    const sent: string[] = [];
    const win = new BulkWindow<string>((item) => sent.push(item), { windowBytes: 10 });
    win.ack(0);
    win.push('a', 6);
    win.push('b', 6);
    win.push('c', 6);
    expect(sent).toEqual(['a', 'b']);
    win.ack(1);
    expect(sent).toEqual(['a', 'b']);
    win.ack(6);
    expect(sent).toEqual(['a', 'b', 'c']);
  });

  it('treats a smaller cumulative count as a new page', () => {
    const sent: string[] = [];
    const win = new BulkWindow<string>((item) => sent.push(item), { windowBytes: 10 });
    win.ack(1000);
    win.push('a', 6);
    win.push('b', 6);
    win.push('c', 6);
    win.ack(12);
    expect(sent).toEqual(['a', 'b', 'c']);
  });

  it('drops queued frames when the link goes down (host replays on resume)', () => {
    const sent: string[] = [];
    const win = new BulkWindow<string>((item) => sent.push(item), { windowBytes: 10 });
    win.ack(0);
    win.push('a', 10);
    win.push('b', 10);
    win.reset();
    win.push('c', 10);
    expect(sent).toEqual(['a', 'c']);
  });

  it('does not stall forever when acks are lost', () => {
    const sent: string[] = [];
    const win = new BulkWindow<string>((item) => sent.push(item), {
      windowBytes: 10,
      stallMs: 1000,
    });
    win.ack(0);
    win.push('a', 10);
    win.push('b', 10);
    expect(sent).toEqual(['a']);
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual(['a', 'b']);
  });

  it('zero-delta acks do not reset the stall timer', () => {
    const sent: string[] = [];
    const win = new BulkWindow<string>((item) => sent.push(item), {
      windowBytes: 10,
      stallMs: 1000,
    });
    win.ack(0);
    win.push('a', 10);
    win.push('b', 10);
    vi.advanceTimersByTime(600);
    win.ack(0);
    vi.advanceTimersByTime(400);
    expect(sent).toEqual(['a', 'b']);
  });

  it('dropGroup evicts stale queued parts before re-enqueuing a retry', () => {
    const sent: string[] = [];
    const win = new BulkWindow<string>((item) => sent.push(item), { windowBytes: 10 });
    win.ack(0);
    win.push('a', 10, 'g1');
    win.push('b-old-0', 5, 'g2');
    win.push('b-old-1', 5, 'g2');
    win.push('c', 5, 'g3');

    win.dropGroup('g2');
    win.push('b-new-0', 5, 'g2');
    win.push('b-new-1', 5, 'g2');

    win.ack(10);
    win.ack(20);
    expect(sent).toEqual(['a', 'c', 'b-new-0', 'b-new-1']);
  });

  it('unblock releases a stalled window without disturbing an active transfer', () => {
    const sent: string[] = [];
    const win = new BulkWindow<string>((item) => sent.push(item), {
      windowBytes: 10,
      stallMs: 15_000,
    });
    win.ack(0);
    win.push('a', 10);
    expect(sent).toEqual(['a']);

    // 刚发出不久，不应提前解锁
    vi.advanceTimersByTime(500);
    win.unblock(2000);
    win.push('b', 10);
    expect(sent).toEqual(['a']);

    // 超过阈值仍无进度（即使收到 delta=0 的 ack），unblock 立即放行
    vi.advanceTimersByTime(1600);
    win.ack(0);
    win.unblock(2000);
    expect(sent).toEqual(['a', 'b']);
  });

  it('unblock does nothing while real acks are still advancing', () => {
    const sent: string[] = [];
    const win = new BulkWindow<string>((item) => sent.push(item), {
      windowBytes: 10,
      stallMs: 15_000,
    });
    win.ack(0);
    win.push('a', 6);
    win.push('b', 6);
    win.push('c', 6);
    expect(sent).toEqual(['a', 'b']);
    vi.advanceTimersByTime(1500);
    win.ack(1);
    vi.advanceTimersByTime(1000);
    win.unblock(2000);
    expect(sent).toEqual(['a', 'b']);
  });

  it('unblock does not prematurely release a fresh burst after small unacked residue', () => {
    const sent: string[] = [];
    const win = new BulkWindow<string>((item) => sent.push(item), {
      windowBytes: 10,
      stallMs: 15_000,
    });
    win.ack(0);
    // 先发一个未满窗的小分片（模拟 < ACK_STEP 未触发 ack），几秒后才来大帧填满窗口
    win.push('tiny', 3);
    expect(sent).toEqual(['tiny']);
    vi.advanceTimersByTime(5_000);

    win.push('burst-0', 4);
    win.push('burst-1', 4);
    win.push('burst-2', 4);
    expect(sent).toEqual(['tiny', 'burst-0', 'burst-1']);

    // 刚发出 100ms，不能因为 5 秒前的 tiny 误判窗口停滞而提前解锁
    vi.advanceTimersByTime(100);
    win.unblock(2_000);
    expect(sent).toEqual(['tiny', 'burst-0', 'burst-1']);
  });

  it('unblock clears stale partial inflight residue so subsequent bursts get a full window', () => {
    const sent: string[] = [];
    const win = new BulkWindow<string>((item) => sent.push(item), {
      windowBytes: 10,
      stallMs: 15_000,
    });
    win.ack(0);
    win.push('lost', 8);
    expect(sent).toEqual(['lost']);

    vi.advanceTimersByTime(2_500);
    win.unblock(2_000);
    win.push('next-0', 5);
    win.push('next-1', 5);
    expect(sent).toEqual(['lost', 'next-0', 'next-1']);
  });

  it('dropPrefix removes only matching slot parts and preserves other slots and assets', () => {
    const sent: string[] = [];
    const win = new BulkWindow<string>((item) => sent.push(item), {
      windowBytes: 10,
      stallMs: 15_000,
    });
    win.ack(0);
    win.push('in-flight', 10, 'rpc:c1:1');
    win.push('c1-stale-1', 5, 'rpc:c1:1');
    win.push('c1-stale-2', 5, 'rpc:c1:2');
    win.push('c2-keep', 5, 'rpc:c2:1');
    win.push('asset-keep', 5, 'asset:9');

    vi.advanceTimersByTime(2_500);
    win.dropPrefix('rpc:c1:');
    win.unblock(2_000);

    expect(sent).toEqual(['in-flight', 'c2-keep', 'asset-keep']);
  });
});
