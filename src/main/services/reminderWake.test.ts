import { describe, expect, it } from 'vitest';
import { planReminderWake, reminderResumeFromAuthority } from './reminderWake';

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

  it('会话行丢了：按权威注册表拼恢复请求，缺模型、会话文件或 cwd 就不猜', () => {
    const authority = {
      lifecycle: 'ready',
      sessionFile: '/data/sessions/s.jsonl',
      selection: { providerId: 'pv-A', modelId: 'm1' },
    };
    expect(reminderResumeFromAuthority({ sessionId: 's', authority, cwd: '/workspace' })).toEqual({
      sessionId: 's',
      providerId: 'pv-A',
      modelId: 'm1',
      cwd: '/workspace',
      resumeFile: '/data/sessions/s.jsonl',
    });
    expect(reminderResumeFromAuthority({ sessionId: 's', cwd: '/workspace' })).toBeNull();
    expect(reminderResumeFromAuthority({ sessionId: 's', authority, cwd: null })).toBeNull();
    expect(
      reminderResumeFromAuthority({
        sessionId: 's',
        authority: { ...authority, lifecycle: 'ended' },
        cwd: '/workspace',
      })
    ).toBeNull();
    expect(
      reminderResumeFromAuthority({
        sessionId: 's',
        authority: { ...authority, bot: { botId: 'b' } },
        cwd: '/workspace',
      })
    ).toBeNull();
    expect(
      reminderResumeFromAuthority({
        sessionId: 's',
        authority: { ...authority, selection: undefined },
        cwd: '/workspace',
      })
    ).toBeNull();
  });
});
