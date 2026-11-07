import { describe, expect, it } from 'vitest';
import {
  AUTO_RESTART_IDLE_MS,
  anyWindowFocused,
  countCatalogIdleBlocks,
  countPersistedQueuedMessages,
  countQueuedMessages,
  idleDurationMs,
  isAutoRestartBlocked,
  isTurnRestartBlocked,
  mergeIdleRestartBlocks,
  nextIdleSince,
  persistedConversations,
  remainingIdleMs,
  shouldAutoRestartForUpdate,
} from './idleRestart';

const ready = {
  enabled: true,
  downloaded: true,
  agentBusy: false,
  queuedCount: 0,
  pendingAskCount: 0,
  pendingApprovalCount: 0,
  windowFocused: false,
  idleForMs: AUTO_RESTART_IDLE_MS,
};

describe('shouldAutoRestartForUpdate', () => {
  it('用户要求的「回合结束后重启」不看窗口焦点，只看回合、排队、提问与审批', () => {
    const focused = { ...ready, windowFocused: true };
    expect(isTurnRestartBlocked(focused)).toBe(false);
    for (const blocked of [
      { agentBusy: true },
      { queuedCount: 1 },
      { pendingAskCount: 1 },
      { pendingApprovalCount: 1 },
    ]) {
      expect(isTurnRestartBlocked({ ...ready, ...blocked })).toBe(true);
    }
  });

  it('空闲连续满 5 分钟才装', () => {
    expect(shouldAutoRestartForUpdate(ready)).toBe(true);
    expect(shouldAutoRestartForUpdate({ ...ready, idleForMs: AUTO_RESTART_IDLE_MS - 1 })).toBe(
      false
    );
  });

  it('开关关或包没下好不装', () => {
    expect(shouldAutoRestartForUpdate({ ...ready, enabled: false })).toBe(false);
    expect(shouldAutoRestartForUpdate({ ...ready, downloaded: false })).toBe(false);
  });

  it('running、队列、ask、审批、窗口焦点都挡', () => {
    expect(isAutoRestartBlocked({ ...ready, agentBusy: true })).toBe(true);
    expect(isAutoRestartBlocked({ ...ready, queuedCount: 1 })).toBe(true);
    expect(isAutoRestartBlocked({ ...ready, pendingAskCount: 1 })).toBe(true);
    expect(isAutoRestartBlocked({ ...ready, pendingApprovalCount: 1 })).toBe(true);
    expect(isAutoRestartBlocked({ ...ready, windowFocused: true })).toBe(true);
    expect(shouldAutoRestartForUpdate({ ...ready, queuedCount: 1 })).toBe(false);
    expect(shouldAutoRestartForUpdate({ ...ready, windowFocused: true })).toBe(false);
  });

  it('queuedMessages 按条数计', () => {
    expect(countQueuedMessages([{ id: 'a' }])).toBe(1);
    expect(countQueuedMessages(undefined)).toBe(0);
  });

  it('catalog 与盘上队列都能计数', () => {
    expect(
      countCatalogIdleBlocks([
        { queued: [{ id: 'a' }], pendingAskCount: 1, pendingApprovalCount: 2 },
        { queued: [{ id: 'b' }, { id: 'c' }] },
      ])
    ).toEqual({ queuedCount: 3, pendingAskCount: 1, pendingApprovalCount: 2 });
    expect(
      countPersistedQueuedMessages({
        a: { queuedMessages: [{ id: '1' }] },
        b: { queuedMessages: [] },
      })
    ).toBe(1);
    expect(
      persistedConversations({
        'enso-conversations': { state: { conversations: { a: { queuedMessages: [1] } } } },
      })
    ).toEqual({ a: { queuedMessages: [1] } });
  });

  it('忙态打断连续空闲，恢复后从头计', () => {
    expect(nextIdleSince(10, true, 20)).toBeNull();
    expect(nextIdleSince(null, false, 30)).toBe(30);
    expect(nextIdleSince(30, false, 40)).toBe(30);
    expect(idleDurationMs(null, 40)).toBe(0);
    expect(idleDurationMs(30, 40)).toBe(10);
    expect(remainingIdleMs(null, 40)).toBeNull();
    expect(remainingIdleMs(0, AUTO_RESTART_IDLE_MS - 10)).toBe(10);
    expect(remainingIdleMs(0, AUTO_RESTART_IDLE_MS)).toBe(0);
  });

  it('多源忙态取最大，不把同一队列加两遍', () => {
    expect(
      mergeIdleRestartBlocks(
        { queuedCount: 2, pendingAskCount: 0, pendingApprovalCount: 1 },
        { queuedCount: 1, pendingAskCount: 3, pendingApprovalCount: 0 }
      )
    ).toEqual({ queuedCount: 2, pendingAskCount: 3, pendingApprovalCount: 1 });
    expect(mergeIdleRestartBlocks()).toEqual({
      queuedCount: 0,
      pendingAskCount: 0,
      pendingApprovalCount: 0,
    });
  });

  it('任一未销毁窗口聚焦即挡住', () => {
    expect(
      anyWindowFocused([
        { isDestroyed: () => true, isFocused: () => true },
        { isDestroyed: () => false, isFocused: () => false },
      ])
    ).toBe(false);
    expect(anyWindowFocused([{ isDestroyed: () => false, isFocused: () => true }])).toBe(true);
  });
});
