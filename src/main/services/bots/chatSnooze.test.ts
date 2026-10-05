import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotChat } from '../../../shared/types/bot';
import { ChatSnoozeTimer } from './chatSnooze';
import { BotChatStore } from './chatStore';

let root: string;
let chats: BotChatStore;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  root = mkdtempSync(join(tmpdir(), 'chat-snooze-'));
  chats = new BotChatStore(root);
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

const direct = (botId: string, snoozedUntil?: number) => {
  const chat = chats.create({
    kind: 'direct',
    title: '',
    members: [botId],
    bossBotId: null,
    workspace: { kind: 'member-home' },
  })!;
  return chats.update(chat.id, (draft) =>
    snoozedUntil === undefined ? draft : { ...draft, settledAt: 1, snoozedUntil }
  )!;
};

it('wakes snoozed chats when due (including ones overdue at start) and re-arms for the next', async () => {
  const overdue = direct('11111111-1111-4111-8111-111111111111', 999_000);
  const later = direct('22222222-2222-4222-8222-222222222222', 1_060_000);
  direct('33333333-3333-4333-8333-333333333333');
  const due: BotChat[] = [];
  const timer = new ChatSnoozeTimer({ chats, onDue: (chat) => due.push(chat) });
  timer.refresh();
  await vi.advanceTimersByTimeAsync(0);
  expect(due.map((chat) => chat.id)).toEqual([overdue.id]);
  expect(chats.get(overdue.id)?.settledAt).toBeUndefined();
  expect(chats.get(overdue.id)?.snoozedUntil).toBeUndefined();
  await vi.advanceTimersByTimeAsync(59_000);
  expect(due).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(due.map((chat) => chat.id)).toEqual([overdue.id, later.id]);
  timer.dispose();
});

it('stops after dispose', async () => {
  direct('11111111-1111-4111-8111-111111111111', 1_010_000);
  const onDue = vi.fn();
  const timer = new ChatSnoozeTimer({ chats, onDue });
  timer.refresh();
  timer.dispose();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(onDue).not.toHaveBeenCalled();
});
