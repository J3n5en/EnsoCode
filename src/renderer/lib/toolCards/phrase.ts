import { parseCron } from '@shared/bots/cron';

const WEEKDAYS_ZH = ['日', '一', '二', '三', '四', '五', '六'] as const;
const WEEKDAYS_EN = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** 解析不到名称时退回的短前缀 */
export function shortId(id: string): string {
  const text = id.trim();
  if (text.length <= 8) return text;
  return `${text.slice(0, 8)}…`;
}

export function displayLabel(id: string | undefined, name: string | undefined): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  return id ? shortId(id) : '';
}

export function formatStamp(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function clock(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}

function allRange(values: readonly number[], min: number, max: number): boolean {
  return values.length === max - min + 1 && values[0] === min && values[values.length - 1] === max;
}

function everyStep(values: readonly number[], max: number): number | undefined {
  if (values.length < 2 || values[0] !== 0) return undefined;
  const step = values[1] - values[0];
  if (step < 1) return undefined;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] - values[index - 1] !== step) return undefined;
  }
  return values[values.length - 1] + step >= max ? step : undefined;
}

function sameNumbers(values: readonly number[], expected: readonly number[]): boolean {
  return (
    values.length === expected.length && values.every((value, index) => value === expected[index])
  );
}

/**
 * 把 5 段 cron 说成人话。只覆盖常见形状，认不出就原样返回，避免编一个错误的频率。
 */
export function cronPhrase(expr: string, locale: 'zh' | 'en'): string {
  const cron = parseCron(expr);
  if (!cron) return expr.trim();
  const daily =
    allRange(cron.dayOfMonth, 1, 31) &&
    allRange(cron.month, 1, 12) &&
    allRange(cron.dayOfWeek, 0, 6);
  if (daily && allRange(cron.hour, 0, 23)) {
    const step = everyStep(cron.minute, 60);
    if (step === 1) return locale === 'zh' ? '每分钟' : 'every minute';
    if (step) return locale === 'zh' ? `每 ${step} 分钟` : `every ${step} minutes`;
  }
  if (cron.minute.length !== 1 || cron.hour.length !== 1 || !allRange(cron.month, 1, 12)) {
    return cron.source;
  }
  const time = clock(cron.hour[0], cron.minute[0]);
  if (daily) return locale === 'zh' ? `每天 ${time}` : `every day at ${time}`;
  if (allRange(cron.dayOfMonth, 1, 31) && sameNumbers(cron.dayOfWeek, [1, 2, 3, 4, 5])) {
    return locale === 'zh' ? `每个工作日 ${time}` : `weekdays at ${time}`;
  }
  if (allRange(cron.dayOfMonth, 1, 31) && cron.dayOfWeek.length === 1) {
    const day = cron.dayOfWeek[0];
    return locale === 'zh'
      ? `每周${WEEKDAYS_ZH[day]} ${time}`
      : `every ${WEEKDAYS_EN[day]} at ${time}`;
  }
  return cron.source;
}
