import { describe, expect, it } from 'vitest';
import {
  formatReminderClock,
  formatReminderRemaining,
  formatReminderTooltip,
  hasPendingReminder,
  nextPendingReminder,
  parseReminderFile,
  REMINDER_OVERDUE_GRACE_MS,
  remindersOf,
  type SessionReminder,
} from './reminders';

const reminder = (overrides: Partial<SessionReminder> = {}): SessionReminder => ({
  id: 'r0000000a',
  sessionId: 'root',
  dueAt: 1_000,
  createdAt: 0,
  prompt: 'check CI',
  ifIdle: true,
  chain: 1,
  ...overrides,
});

describe('parseReminderFile', () => {
  it('坏文件返回空表，不抛', () => {
    for (const value of [null, 'x', 1, [], { version: 2 }, { version: 1, reminders: 'x' }]) {
      expect(parseReminderFile(value)).toEqual({ version: 1, reminders: [], chains: {} });
    }
  });

  it('脏条目逐条丢弃，合法的保留；重复 id 只留第一条', () => {
    const good = reminder();
    const parsed = parseReminderFile({
      version: 1,
      reminders: [
        good,
        { ...good, id: 'bad' },
        { ...good, id: 'r0000000b', sessionId: '' },
        { ...good, id: 'r0000000c', dueAt: 'soon' },
        { ...good, id: 'r0000000d', prompt: '' },
        { ...good, id: 'r0000000e', ifIdle: 'yes' },
        { ...good, id: 'r0000000f', chain: 0 },
        { ...good, id: 'r00000010', label: 'x'.repeat(81) },
        { ...good, prompt: 'dup' },
        reminder({ id: 'r00000011', sessionId: 'root::cw-a', label: 'ci' }),
      ],
      chains: { root: 2, bad: -1, worse: 'x' },
    });
    expect(parsed.reminders.map((item) => item.id)).toEqual(['r0000000a', 'r00000011']);
    expect(parsed.reminders[1]).toMatchObject({ label: 'ci', sessionId: 'root::cw-a' });
    expect(parsed.chains).toEqual({ root: 2 });
  });
});

describe('remindersOf', () => {
  it('只取根会话自己和它的子会话，按到点时间排序', () => {
    const file = parseReminderFile({
      version: 1,
      reminders: [
        reminder({ id: 'r00000001', dueAt: 3 }),
        reminder({ id: 'r00000002', sessionId: 'root::cw-a', dueAt: 1 }),
        reminder({ id: 'r00000003', sessionId: 'root2', dueAt: 2 }),
        reminder({ id: 'r00000004', sessionId: 'other::root', dueAt: 2 }),
      ],
      chains: {},
    });
    expect(remindersOf(file, 'root').map((item) => item.id)).toEqual(['r00000002', 'r00000001']);
  });
});

describe('hasPendingReminder', () => {
  it('未到点或到点不足宽限期算在等；过期超过宽限期不算', () => {
    expect(hasPendingReminder([], 0)).toBe(false);
    expect(hasPendingReminder([reminder({ dueAt: 10_000 })], 0)).toBe(true);
    expect(hasPendingReminder([reminder({ dueAt: 0 })], REMINDER_OVERDUE_GRACE_MS - 1)).toBe(true);
    expect(hasPendingReminder([reminder({ dueAt: 0 })], REMINDER_OVERDUE_GRACE_MS + 1)).toBe(false);
  });
});

describe('nextPendingReminder 与展示格式化', () => {
  const t = (key: string, params?: Record<string, string | number>) =>
    params ? key.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(params[k] ?? '')) : key;

  it('返回最早一条仍在等的提醒并统计未过期总数，过期项被过滤', () => {
    const now = new Date(2026, 4, 1, 14, 20, 0).getTime();
    const first = reminder({
      id: 'r00000002',
      dueAt: now + 3 * 60_000,
      label: '检查 Beta #153',
    });
    const second = reminder({ id: 'r00000003', dueAt: now + 10 * 60_000, label: '第二条' });
    const expired = reminder({
      id: 'r00000004',
      dueAt: now - REMINDER_OVERDUE_GRACE_MS - 1,
      label: '过期',
    });
    const view = nextPendingReminder([second, expired, first], now);
    expect(view).toEqual({
      id: 'r00000002',
      dueAt: first.dueAt,
      label: '检查 Beta #153',
      count: 2,
    });
    expect(formatReminderClock(first.dueAt)).toBe('14:23');
    expect(formatReminderRemaining(first.dueAt, now, t)).toBe('in 3m');
    expect(formatReminderTooltip(view!, now, t)).toBe(
      'Waiting for reminder · 14:23 (in 3m) — 检查 Beta #153 — 2 reminders'
    );
    expect(nextPendingReminder([expired], now)).toBeUndefined();
  });
});
