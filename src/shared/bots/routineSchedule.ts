import { parseCron } from './cron';

/** UI 简单选择器能表达的调度：每天 / 工作日 / 每周几 + 时间 */
export interface SimpleSchedule {
  kind: 'daily' | 'weekdays' | 'weekly';
  /** weekly 用，0 = 周日，升序 */
  days: number[];
  hour: number;
  minute: number;
}

export function simpleSchedule(expr: string): SimpleSchedule | undefined {
  const cron = parseCron(expr);
  if (!cron) return undefined;
  const [min, hour, dom, month, dow] = cron.source.split(' ');
  if (!/^\d+$/u.test(min) || !/^\d+$/u.test(hour) || dom !== '*' || month !== '*') return undefined;
  const time = { hour: cron.hour[0], minute: cron.minute[0] };
  if (dow === '*') return { kind: 'daily', days: [], ...time };
  if (dow === '1-5') return { kind: 'weekdays', days: [], ...time };
  if (!/^\d+(,\d+)*$/u.test(dow)) return undefined;
  const days = [...new Set(cron.dayOfWeek.map((day) => day % 7))].sort((a, b) => a - b);
  return { kind: 'weekly', days, ...time };
}

export function simpleScheduleCron(schedule: SimpleSchedule): string | undefined {
  const { kind, hour, minute } = schedule;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return undefined;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  const days = [...new Set(schedule.days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (kind === 'weekly' && !days.length) return undefined;
  const dow = kind === 'daily' ? '*' : kind === 'weekdays' ? '1-5' : days.sort().join(',');
  return `${minute} ${hour} * * ${dow}`;
}

const ZH_DAYS: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const EN_DAYS =
  /\b(sun|mon|tue|wed|thu|fri|sat)(?:day|s|sdays?|nesdays?|rsdays?|urdays?|days)?\b/gu;
const EN_INDEX = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** 时间：9:30 / 09:30 / 9点 / 9点半 / 9am / 6:30pm；中文早上 / 下午 / 晚上修正 12 小时制 */
function parseTime(text: string): { hour: number; minute: number } | undefined {
  const en = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/u.exec(text);
  const colon = /(\d{1,2})[:：](\d{2})/u.exec(text);
  const zh = /(\d{1,2})\s*[点時时](?:\s*(半|(\d{1,2})\s*分?))?/u.exec(text);
  let hour: number;
  let minute: number;
  if (en) {
    hour = Number(en[1]);
    minute = en[2] ? Number(en[2]) : 0;
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (en[3] === 'pm' ? 12 : 0);
  } else if (colon) {
    hour = Number(colon[1]);
    minute = Number(colon[2]);
  } else if (zh) {
    hour = Number(zh[1]);
    minute = zh[2] === '半' ? 30 : zh[3] ? Number(zh[3]) : 0;
  } else return undefined;
  if (!en && /下午|晚上|傍晚|夜里/u.test(text) && hour >= 1 && hour < 12) hour += 12;
  if (!en && /凌晨|半夜/u.test(text) && hour === 12) hour = 0;
  return hour <= 23 && minute <= 59 ? { hour, minute } : undefined;
}

/** 成员工具 routine_propose 的 schedule：5 段 cron 或简单描述（中英），无法识别返回 undefined */
export function parseScheduleText(raw: string): string | undefined {
  const text = raw.trim().toLowerCase();
  if (!text) return undefined;
  const cron = parseCron(text);
  if (cron) return cron.source;
  if (/^(hourly|every hour|每小时|每个小时)$/u.test(text)) return '0 * * * *';
  const time = parseTime(text);
  if (!time) return undefined;
  const at = (dow: string) => `${time.minute} ${time.hour} * * ${dow}`;
  if (/工作日|weekdays?\b/u.test(text)) return at('1-5');
  const zhWeek =
    /(?:每周|每星期|每礼拜|周|星期)([一二三四五六日天](?:[、,，和及\s]*(?:周|星期)?[一二三四五六日天])*)/u.exec(
      text
    );
  if (zhWeek) {
    const days = [...zhWeek[1].matchAll(/[一二三四五六日天]/gu)].map((m) => ZH_DAYS[m[0]]);
    return simpleScheduleCron({ kind: 'weekly', days, ...time });
  }
  const enDays = [...text.matchAll(EN_DAYS)].map((m) => EN_INDEX.indexOf(m[1]));
  if (enDays.length) return simpleScheduleCron({ kind: 'weekly', days: enDays, ...time });
  if (/每天|每日|天天|\bdaily\b|every\s*day/u.test(text)) return at('*');
  return undefined;
}
