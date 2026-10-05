import { describe, expect, it } from 'vitest';
import { parseScheduleText, simpleSchedule, simpleScheduleCron } from './routineSchedule';

describe('simpleSchedule', () => {
  it('识别每天 / 工作日 / 每周几 + 时间，其余返回 undefined', () => {
    expect(simpleSchedule('0 9 * * *')).toEqual({ kind: 'daily', days: [], hour: 9, minute: 0 });
    expect(simpleSchedule('30 18 * * 1-5')).toEqual({
      kind: 'weekdays',
      days: [],
      hour: 18,
      minute: 30,
    });
    expect(simpleSchedule('5 7 * * 1,3,5')).toEqual({
      kind: 'weekly',
      days: [1, 3, 5],
      hour: 7,
      minute: 5,
    });
    expect(simpleSchedule('0 9 * * 7')).toEqual({ kind: 'weekly', days: [0], hour: 9, minute: 0 });
    for (const other of ['0 * * * *', '*/5 9 * * *', '0 9 1 * *', '0 9 * 1 *', 'bad'])
      expect(simpleSchedule(other), other).toBeUndefined();
  });

  it('与 cron 互转往返一致', () => {
    for (const cron of ['0 9 * * *', '30 18 * * 1-5', '5 7 * * 1,3,5', '0 0 * * 0'])
      expect(simpleScheduleCron(simpleSchedule(cron)!)).toBe(cron);
    expect(simpleScheduleCron({ kind: 'weekly', days: [], hour: 9, minute: 0 })).toBeUndefined();
    expect(simpleScheduleCron({ kind: 'daily', days: [], hour: 24, minute: 0 })).toBeUndefined();
  });
});

describe('parseScheduleText', () => {
  it('5 段 cron 原样归一', () => {
    expect(parseScheduleText('  0  9 * * 1-5 ')).toBe('0 9 * * 1-5');
    expect(parseScheduleText('61 * * * *')).toBeUndefined();
  });

  it('中文简单描述', () => {
    expect(parseScheduleText('每天 9:00')).toBe('0 9 * * *');
    expect(parseScheduleText('每天早上9点半')).toBe('30 9 * * *');
    expect(parseScheduleText('每天下午6点')).toBe('0 18 * * *');
    expect(parseScheduleText('工作日 18:30')).toBe('30 18 * * 1-5');
    expect(parseScheduleText('每周一 10:00')).toBe('0 10 * * 1');
    expect(parseScheduleText('每周一、三、五 08:15')).toBe('15 8 * * 1,3,5');
    expect(parseScheduleText('每周日晚上8点')).toBe('0 20 * * 0');
    expect(parseScheduleText('每小时')).toBe('0 * * * *');
  });

  it('英文简单描述', () => {
    expect(parseScheduleText('daily at 9:00')).toBe('0 9 * * *');
    expect(parseScheduleText('every day 6pm')).toBe('0 18 * * *');
    expect(parseScheduleText('Weekdays 09:30')).toBe('30 9 * * 1-5');
    expect(parseScheduleText('every Monday at 10am')).toBe('0 10 * * 1');
    expect(parseScheduleText('every mon, wed and fri at 7:05')).toBe('5 7 * * 1,3,5');
    expect(parseScheduleText('hourly')).toBe('0 * * * *');
    expect(parseScheduleText('12am daily')).toBe('0 0 * * *');
  });

  it('无法识别或时间越界返回 undefined', () => {
    for (const bad of ['', 'sometimes', '每天 25:00', 'daily at 9:75', '每周 10:00', 'every day'])
      expect(parseScheduleText(bad), bad).toBeUndefined();
  });
});
