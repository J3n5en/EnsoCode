import { describe, expect, it } from 'vitest';
import { planReminderWake } from './reminderWake';

describe('planReminderWake', () => {
  it('会话已删除、已归档或已结束：清掉提醒', () => {
    expect(planReminderWake({ row: undefined, alive: false })).toBe('clear');
    expect(planReminderWake({ row: { archived: true }, alive: true })).toBe('clear');
    expect(planReminderWake({ row: {}, alive: true, lifecycle: 'ended' })).toBe('clear');
  });

  it('worker 里活着：直接触发；冷会话：先打开', () => {
    expect(planReminderWake({ row: { archived: false }, alive: true })).toBe('fire');
    expect(planReminderWake({ row: {}, alive: false, lifecycle: 'ready' })).toBe('resume');
  });

  it('会话行丢了但权威注册表里还在：照常打开，不把提醒清掉', () => {
    expect(planReminderWake({ row: null, alive: false, lifecycle: 'ready', known: true })).toBe(
      'resume'
    );
    expect(planReminderWake({ row: null, alive: true, known: true })).toBe('fire');
    expect(planReminderWake({ row: null, alive: false, lifecycle: 'ended', known: true })).toBe(
      'clear'
    );
  });
});
