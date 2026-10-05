import type { BotChat } from '@shared/types/bot';
import { describe, expect, it } from 'vitest';
import { ROUTINE_PRESETS, routineDraftIssue, routineTargets, schedulePreview } from './routines';

const chat = (over: Partial<BotChat>): BotChat => ({
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
  ...over,
});

describe('ROUTINE_PRESETS', () => {
  it('常用预设都是合法 cron，描述符合预期', () => {
    expect(ROUTINE_PRESETS.map((cron) => schedulePreview(cron, 'zh', 0)?.description)).toEqual([
      '每天 09:00',
      '工作日 09:00',
      '每周一 09:00',
      '每小时 00 分',
    ]);
  });
});

describe('schedulePreview', () => {
  it('给出描述与下次运行时间（本地时区）', () => {
    const now = new Date(2026, 9, 5, 10, 30).getTime();
    expect(schedulePreview(' 0  9 * * * ', 'zh', now)).toEqual({
      source: '0 9 * * *',
      description: '每天 09:00',
      next: new Date(2026, 9, 6, 9, 0).getTime(),
    });
  });
  it('非法表达式返回 undefined', () => {
    expect(schedulePreview('61 * * * *', 'zh', 0)).toBeUndefined();
    expect(schedulePreview('', 'zh', 0)).toBeUndefined();
  });
});

describe('routineTargets', () => {
  it('只列该成员所在且未归档的聊天，私聊在前', () => {
    const chats = [
      chat({ id: 'g1', kind: 'group', members: ['b1', 'b2'] }),
      chat({ id: 'd1' }),
      chat({ id: 'd2', members: ['b2'] }),
      chat({ id: 'g2', kind: 'group', members: ['b1'], archivedAt: 5 }),
    ];
    expect(routineTargets(chats, 'b1').map((item) => item.id)).toEqual(['d1', 'g1']);
  });
});

describe('routineDraftIssue', () => {
  const draft = { title: 't', prompt: 'p', schedule: '0 9 * * *', chatId: 'c1' };
  it('依次检查标题、提示词、时间表、目标聊天', () => {
    expect(routineDraftIssue(draft)).toBeNull();
    expect(routineDraftIssue({ ...draft, title: ' ' })).toBe('title');
    expect(routineDraftIssue({ ...draft, prompt: '' })).toBe('prompt');
    expect(routineDraftIssue({ ...draft, schedule: 'x' })).toBe('schedule');
    expect(routineDraftIssue({ ...draft, chatId: '' })).toBe('chat');
  });
});
