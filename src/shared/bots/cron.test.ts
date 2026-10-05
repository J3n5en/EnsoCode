import { describe, expect, it } from 'vitest';
import { describeCron, MISSED_RUNS_MAX, missedRuns, nextRun, parseCron } from './cron';

const at = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();
const cron = (expr: string) => {
  const parsed = parseCron(expr);
  if (!parsed) throw new Error(`bad cron ${expr}`);
  return parsed;
};

describe('parseCron', () => {
  it('合法表达式：* , - / 与多余空白', () => {
    const c = cron('  */15  9-17 1,15 * 1-5 ');
    expect(c.minute).toEqual([0, 15, 30, 45]);
    expect(c.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(c.dayOfMonth).toEqual([1, 15]);
    expect(c.month).toHaveLength(12);
    expect(c.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(cron('0 0 * * 1-7/2').dayOfWeek).toEqual([0, 1, 3, 5]);
    expect(cron('5/20 * * * *').minute).toEqual([5, 25, 45]);
  });

  it('周日 0 与 7 等价', () => {
    expect(cron('0 9 * * 7').dayOfWeek).toEqual([0]);
    expect(cron('0 9 * * 0').dayOfWeek).toEqual([0]);
    expect(cron('0 9 * * 5-7').dayOfWeek).toEqual([0, 5, 6]);
  });

  it('非法表达式返回 undefined', () => {
    for (const bad of [
      '',
      '* * * *',
      '* * * * * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * 32 * *',
      '* * * 13 *',
      '* * * * 8',
      '5-1 * * * *',
      '*/0 * * * *',
      '1,,2 * * * *',
      'a * * * *',
      '-1 * * * *',
      '1.5 * * * *',
      '@daily',
    ]) {
      expect(parseCron(bad), bad).toBeUndefined();
    }
  });
});

describe('nextRun', () => {
  it('严格晚于起点，按本地时区', () => {
    const c = cron('0 9 * * *');
    expect(nextRun(c, at(2026, 3, 10, 8, 59))).toBe(at(2026, 3, 10, 9, 0));
    expect(nextRun(c, at(2026, 3, 10, 9, 0))).toBe(at(2026, 3, 11, 9, 0));
    expect(nextRun(c, at(2026, 3, 10, 9, 0) + 30_000)).toBe(at(2026, 3, 11, 9, 0));
  });

  it('跨月、跨年', () => {
    expect(nextRun(cron('30 8 1 * *'), at(2026, 1, 31, 12))).toBe(at(2026, 2, 1, 8, 30));
    expect(nextRun(cron('0 0 1 1 *'), at(2026, 6, 1))).toBe(at(2027, 1, 1));
    expect(nextRun(cron('0 12 31 * *'), at(2026, 4, 1))).toBe(at(2026, 5, 31, 12));
  });

  it('闰年 2/29', () => {
    expect(nextRun(cron('0 0 29 2 *'), at(2025, 3, 1))).toBe(at(2028, 2, 29));
  });

  it('永不触发的日期返回 undefined', () => {
    expect(nextRun(cron('0 0 30 2 *'), at(2026, 1, 1))).toBeUndefined();
  });

  it('周日 0 / 7 都能触发', () => {
    // 2026-03-15 是周日
    expect(nextRun(cron('0 9 * * 7'), at(2026, 3, 10))).toBe(at(2026, 3, 15, 9));
    expect(nextRun(cron('0 9 * * 0'), at(2026, 3, 10))).toBe(at(2026, 3, 15, 9));
  });

  it('日与周同时限定：任一匹配即触发（Vixie）；任一为 * 时按另一个', () => {
    // 2026-03-02 是周一
    const either = cron('0 9 15 * 1');
    expect(nextRun(either, at(2026, 3, 1))).toBe(at(2026, 3, 2, 9));
    expect(nextRun(either, at(2026, 3, 13))).toBe(at(2026, 3, 15, 9));
    expect(nextRun(cron('0 9 * * 1'), at(2026, 3, 3))).toBe(at(2026, 3, 9, 9));
    expect(nextRun(cron('0 9 15 * *'), at(2026, 3, 3))).toBe(at(2026, 3, 15, 9));
    // 日字段以 * 开头：两者同时满足（2026-05-11 是周一且 11 ∈ */10）
    expect(nextRun(cron('0 9 */10 * 1'), at(2026, 3, 3))).toBe(at(2026, 5, 11, 9));
  });

  it('一整年逐次推进：不死循环、严格单调（覆盖 DST 切换）', () => {
    for (const expr of ['*/30 * * * *', '30 2 * * *', '0 1 * * *', '15 * * * 0']) {
      const c = cron(expr);
      let t = at(2026, 1, 1);
      const end = at(2027, 1, 1);
      let steps = 0;
      while (t < end) {
        const next = nextRun(c, t);
        expect(next).toBeDefined();
        expect(next as number).toBeGreaterThan(t);
        t = next as number;
        steps += 1;
      }
      expect(steps).toBeGreaterThan(50);
    }
  });
});

describe('missedRuns', () => {
  it('统计 (lastRunAt, now] 之间的触发次数', () => {
    const c = cron('0 9 * * *');
    expect(missedRuns(c, at(2026, 3, 10, 9), at(2026, 3, 10, 10))).toBe(0);
    expect(missedRuns(c, at(2026, 3, 10, 9), at(2026, 3, 13, 8))).toBe(2);
    expect(missedRuns(c, at(2026, 3, 10, 9), at(2026, 3, 13, 9))).toBe(3);
  });

  it('上限截断到 99；无上次运行或时钟回拨为 0', () => {
    const c = cron('* * * * *');
    expect(missedRuns(c, at(2026, 1, 1), at(2026, 2, 1))).toBe(MISSED_RUNS_MAX);
    expect(MISSED_RUNS_MAX).toBe(99);
    expect(missedRuns(c, undefined, at(2026, 2, 1))).toBe(0);
    expect(missedRuns(c, at(2026, 2, 1), at(2026, 1, 1))).toBe(0);
  });
});

describe('describeCron', () => {
  it('常见形式', () => {
    expect(describeCron('0 9 * * *', 'zh')).toBe('每天 09:00');
    expect(describeCron('0 9 * * *', 'en')).toBe('Every day at 09:00');
    expect(describeCron('5 18 * * 1', 'zh')).toBe('每周一 18:05');
    expect(describeCron('5 18 * * 7', 'en')).toBe('Every Sunday at 18:05');
    expect(describeCron('0 9 * * 1-5', 'zh')).toBe('工作日 09:00');
    expect(describeCron('0 9 * * 1-5', 'en')).toBe('Weekdays at 09:00');
    expect(describeCron('*/10 * * * *', 'zh')).toBe('每 10 分钟');
    expect(describeCron('*/10 * * * *', 'en')).toBe('Every 10 minutes');
    expect(describeCron('* * * * *', 'zh')).toBe('每分钟');
    expect(describeCron('0 * * * *', 'zh')).toBe('每小时 00 分');
    expect(describeCron('30 8 1 * *', 'zh')).toBe('每月 1 日 08:30');
    expect(describeCron('30 8 1 * *', 'en')).toBe('Monthly on day 1 at 08:30');
    expect(describeCron(cron('0 9 * * *'), 'zh')).toBe('每天 09:00');
    expect(describeCron('0 9 * * 1,3,5', 'zh')).toBe('每周一、三、五 09:00');
    expect(describeCron('0 9 * * 0,6', 'en')).toBe('Every Sunday, Saturday at 09:00');
  });

  it('其余回退原文（含非法表达式）', () => {
    expect(describeCron('0 9 1 1 *', 'zh')).toBe('0 9 1 1 *');
    expect(describeCron('0 9,18 * * *', 'en')).toBe('0 9,18 * * *');
    expect(describeCron('nope', 'en')).toBe('nope');
    expect(describeCron('  0  9 * * * ', 'zh')).toBe('每天 09:00');
  });
});
