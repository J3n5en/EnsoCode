import { describe, expect, it } from 'vitest';
import type { BotChat } from '../types/bot';
import { applyChatFlags, dueSnoozes, nextSnoozeAt, wakeOnActivity } from './chatFlags';

const chat = (patch: Partial<BotChat> = {}): BotChat => ({
  id: 'c1',
  kind: 'direct',
  title: '',
  members: ['b1'],
  bossBotId: null,
  workspace: { kind: 'member-home' },
  routing: { mode: 'boss', maxHops: 4, maxTurnsPerBot: 2 },
  pinned: false,
  sessions: {},
  createdAt: 1,
  updatedAt: 1,
  version: 1,
  ...patch,
});

describe('applyChatFlags', () => {
  it('settling a pinned chat unpins it and clears its pin order', () => {
    const next = applyChatFlags(chat({ pinned: true, pinOrder: 2 }), { settled: true }, 100);
    expect(next).toMatchObject({ pinned: false, settledAt: 100 });
    expect(next.pinOrder).toBeUndefined();
  });

  it('snoozing settles until the reminder; un-settling drops the reminder', () => {
    const snoozed = applyChatFlags(chat({ pinned: true }), { snoozedUntil: 500 }, 100);
    expect(snoozed).toMatchObject({ pinned: false, settledAt: 100, snoozedUntil: 500 });
    const resumed = applyChatFlags(snoozed, { settled: false }, 200);
    expect(resumed.settledAt).toBeUndefined();
    expect(resumed.snoozedUntil).toBeUndefined();
    expect(applyChatFlags(snoozed, { snoozedUntil: null }, 200)).toMatchObject({
      settledAt: 100,
    });
    expect(applyChatFlags(snoozed, { snoozedUntil: null }, 200).snoozedUntil).toBeUndefined();
  });

  it('pinning a settled chat brings it back and keeps an explicit order only while pinned', () => {
    const pinned = applyChatFlags(
      chat({ settledAt: 5, snoozedUntil: 9 }),
      { pinned: true, pinOrder: 3 },
      10
    );
    expect(pinned).toMatchObject({ pinned: true, pinOrder: 3 });
    expect(pinned.settledAt).toBeUndefined();
    expect(pinned.snoozedUntil).toBeUndefined();
    expect(applyChatFlags(chat(), { pinOrder: 1 }, 10).pinOrder).toBeUndefined();
    expect(applyChatFlags(pinned, { pinned: false }, 10).pinOrder).toBeUndefined();
    expect(applyChatFlags(pinned, { pinOrder: null }, 10).pinOrder).toBeUndefined();
  });
});

describe('snooze and activity', () => {
  it('wakes settled chats on new activity and leaves others untouched', () => {
    const settled = chat({ settledAt: 5, snoozedUntil: 50 });
    const woke = wakeOnActivity(settled);
    expect(woke?.settledAt).toBeUndefined();
    expect(woke?.snoozedUntil).toBeUndefined();
    expect(wakeOnActivity(chat())).toBeUndefined();
  });

  it('finds due reminders and the next wake-up, ignoring archived chats', () => {
    const list = [
      chat({ id: 'a', snoozedUntil: 100 }),
      chat({ id: 'b', snoozedUntil: 300 }),
      chat({ id: 'c', snoozedUntil: 50, archivedAt: 1 }),
      chat({ id: 'd' }),
    ];
    expect(dueSnoozes(list, 100).map((item) => item.id)).toEqual(['a']);
    expect(nextSnoozeAt(list)).toBe(100);
    expect(nextSnoozeAt([chat()])).toBeUndefined();
  });
});
