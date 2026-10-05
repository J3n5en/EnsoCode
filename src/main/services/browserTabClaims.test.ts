import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserTabClaims, browserTabBusyMessage } from './browserTabClaims';

const alice = { sessionId: 's-alice', name: 'Alice' };
const bob = { sessionId: 's-bob', name: 'Bob' };
const bobChild = { sessionId: 's-bob-delegated', name: 'Bob' };

describe('BrowserTabClaims', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lets the first member hold a tab and rejects others immediately', () => {
    const claims = new BrowserTabClaims();
    expect(claims.claim('t1', alice)).toEqual({ ok: true, tookOver: false });
    expect(claims.claim('t1', bob)).toEqual({ ok: false, holder: alice });
    expect(claims.claim('t1', alice)).toEqual({ ok: true, tookOver: false });
    expect(claims.holder('t1')).toEqual(alice);
  });

  it('lets different members hold different tabs at the same time', () => {
    const claims = new BrowserTabClaims();
    expect(claims.claim('t1', alice).ok).toBe(true);
    expect(claims.claim('t2', bob).ok).toBe(true);
    expect(claims.pointer(alice.sessionId)).toBe('t1');
    expect(claims.pointer(bob.sessionId)).toBe('t2');
  });

  it('treats a delegated session as its own holder', () => {
    const claims = new BrowserTabClaims();
    claims.claim('t1', bob);
    expect(claims.claim('t1', bobChild)).toEqual({ ok: false, holder: bob });
    claims.release(bob.sessionId);
    expect(claims.claim('t1', bobChild).ok).toBe(true);
    expect(claims.claim('t1', bob)).toEqual({ ok: false, holder: bobChild });
  });

  it('releases every tab of a session when its turn ends but keeps its pointer', () => {
    const changed = vi.fn();
    const claims = new BrowserTabClaims({ onChange: changed });
    claims.claim('t1', alice);
    claims.claim('t2', alice);
    changed.mockClear();
    claims.release(alice.sessionId);
    expect(claims.holder('t1')).toBeUndefined();
    expect(claims.holder('t2')).toBeUndefined();
    expect(changed.mock.calls.map(([tab]) => tab).sort()).toEqual(['t1', 't2']);
    expect(claims.pointer(alice.sessionId)).toBe('t2');
    expect(claims.claim('t1', bob).ok).toBe(true);
  });

  it('releases a claim after it sits idle, and activity pushes the deadline', () => {
    const changed = vi.fn();
    const claims = new BrowserTabClaims({ idleMs: 1000, onChange: changed });
    claims.claim('t1', alice);
    vi.advanceTimersByTime(800);
    claims.claim('t1', alice);
    vi.advanceTimersByTime(800);
    expect(claims.holder('t1')).toEqual(alice);
    changed.mockClear();
    vi.advanceTimersByTime(300);
    expect(claims.holder('t1')).toBeUndefined();
    expect(changed).toHaveBeenCalledWith('t1');
    expect(claims.claim('t1', bob).ok).toBe(true);
  });

  it('does not let a released claim expire into someone else later', () => {
    const claims = new BrowserTabClaims({ idleMs: 1000 });
    claims.claim('t1', alice);
    claims.release(alice.sessionId);
    claims.claim('t1', bob);
    vi.advanceTimersByTime(600);
    claims.claim('t1', bob);
    vi.advanceTimersByTime(600);
    expect(claims.holder('t1')).toEqual(bob);
  });

  it('clears the claim when the tab closes and tells the holder once', () => {
    const claims = new BrowserTabClaims();
    claims.claim('t1', alice);
    claims.closeTab('t1');
    expect(claims.holder('t1')).toBeUndefined();
    expect(claims.takeClosed(alice.sessionId)).toBe(true);
    expect(claims.takeClosed(alice.sessionId)).toBe(false);
    expect(claims.pointer(alice.sessionId)).toBeUndefined();
    expect(claims.claim('t1', bob).ok).toBe(true);
  });

  it('tells the holder on its next action after the user took over, only once', () => {
    const claims = new BrowserTabClaims();
    claims.claim('t1', alice);
    claims.userTookOver('t1');
    expect(claims.holder('t1')).toEqual(alice);
    expect(claims.claim('t1', bob)).toEqual({ ok: false, holder: alice });
    expect(claims.claim('t1', alice)).toEqual({ ok: true, tookOver: true });
    expect(claims.claim('t1', alice)).toEqual({ ok: true, tookOver: false });
  });

  it('ignores a user takeover on a tab nobody holds', () => {
    const claims = new BrowserTabClaims();
    claims.userTookOver('t1');
    expect(claims.claim('t1', alice)).toEqual({ ok: true, tookOver: false });
  });

  it('points a member at a tab without claiming it', () => {
    const claims = new BrowserTabClaims();
    claims.claim('t1', bob);
    claims.point(alice.sessionId, 't1');
    expect(claims.pointer(alice.sessionId)).toBe('t1');
    expect(claims.holder('t1')).toEqual(bob);
  });

  it('forgets a finished session entirely', () => {
    const claims = new BrowserTabClaims();
    claims.claim('t1', alice);
    claims.forget(alice.sessionId);
    expect(claims.holder('t1')).toBeUndefined();
    expect(claims.pointer(alice.sessionId)).toBeUndefined();
  });
});

describe('browserTabBusyMessage', () => {
  it('names the holder and offers a way out', () => {
    const message = browserTabBusyMessage('Alice');
    expect(message).toContain('Alice');
    expect(message).toMatch(/new tab/i);
    expect(message).toMatch(/later/i);
  });
});
