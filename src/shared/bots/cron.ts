/** 5 段 cron（分 时 日 月 周），按本地时区计算；周日 0 / 7 等价，日与周同时限定按 Vixie 语义取并集。 */
export interface CronSchedule {
  /** 归一后的原文（空白折叠） */
  source: string;
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  /** 0 = 周日 */
  dayOfWeek: number[];
  /** 字段以 * 开头：Vixie 用它决定日 / 周是交集还是并集 */
  domStar: boolean;
  dowStar: boolean;
}

export const MISSED_RUNS_MAX = 99;

const FIELD_BOUNDS: readonly [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
// 永不触发的组合（如 2/30）在这么多次跳步内必然放弃；覆盖闰年需要的 8 年跨度
const MAX_STEPS = 50_000;

function parseNumber(text: string, min: number, max: number): number | undefined {
  if (!/^\d+$/u.test(text)) return undefined;
  const n = Number(text);
  return n >= min && n <= max ? n : undefined;
}

function parseField(field: string, min: number, max: number): number[] | undefined {
  const values = new Set<number>();
  for (const item of field.split(',')) {
    const [range, stepText, extra] = item.split('/');
    if (extra !== undefined) return undefined;
    const step = stepText === undefined ? 1 : parseNumber(stepText, 1, max);
    if (step === undefined) return undefined;
    let lo: number | undefined;
    let hi: number | undefined;
    if (range === '*') {
      lo = min;
      hi = max;
    } else {
      const [a, b, more] = range.split('-');
      if (more !== undefined) return undefined;
      lo = parseNumber(a, min, max);
      // `a/n` 等价于 `a-max/n`
      hi = b === undefined ? (stepText === undefined ? lo : max) : parseNumber(b, min, max);
    }
    if (lo === undefined || hi === undefined || lo > hi) return undefined;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

export function parseCron(expr: string): CronSchedule | undefined {
  const fields = expr.trim().split(/\s+/u);
  if (fields.length !== 5) return undefined;
  const parsed = fields.map((field, i) => parseField(field, ...FIELD_BOUNDS[i]));
  if (parsed.some((values) => values === undefined)) return undefined;
  const [minute, hour, dayOfMonth, month, dow] = parsed as number[][];
  return {
    source: fields.join(' '),
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek: [...new Set(dow.map((d) => d % 7))].sort((a, b) => a - b),
    domStar: fields[2].startsWith('*'),
    dowStar: fields[4].startsWith('*'),
  };
}

function dayMatches(cron: CronSchedule, date: Date): boolean {
  const dom = cron.dayOfMonth.includes(date.getDate());
  const dow = cron.dayOfWeek.includes(date.getDay());
  return cron.domStar || cron.dowStar ? dom && dow : dom || dow;
}

/** 严格晚于 afterMs 的下一次触发（毫秒，分钟对齐）；永不触发返回 undefined。 */
export function nextRun(cron: CronSchedule, afterMs: number): number | undefined {
  let t = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const d = new Date(t);
    let next: number;
    if (!cron.month.includes(d.getMonth() + 1)) {
      next = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    } else if (!dayMatches(cron, d)) {
      next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    } else if (!cron.hour.includes(d.getHours())) {
      // 绝对时间推进到下一个整点：DST 切换时本地时钟会跳，但时间轴单调
      next = t - d.getMinutes() * MINUTE_MS + HOUR_MS;
    } else if (!cron.minute.includes(d.getMinutes())) {
      next = t + MINUTE_MS;
    } else {
      return t;
    }
    t = Math.max(next, t + MINUTE_MS);
  }
  return undefined;
}

/** (lastRunAt, now] 之间应触发而未触发的次数，截断到 MISSED_RUNS_MAX。 */
export function missedRuns(cron: CronSchedule, lastRunAt: number | undefined, now: number): number {
  if (lastRunAt === undefined) return 0;
  let count = 0;
  let t = nextRun(cron, lastRunAt);
  while (t !== undefined && t <= now && count < MISSED_RUNS_MAX) {
    count += 1;
    t = nextRun(cron, t);
  }
  return count;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ZH_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const EN_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** UI 文案：常见形式给自然语言，其余回退原文。 */
export function describeCron(cron: CronSchedule | string, lang: 'zh' | 'en'): string {
  const parsed = typeof cron === 'string' ? parseCron(cron) : cron;
  if (!parsed) return String(cron);
  const [min, hour, dom, month, dow] = parsed.source.split(' ');
  const zh = lang === 'zh';
  if (month !== '*') return parsed.source;
  const every = /^\*\/(\d+)$/u.exec(min);
  if (hour === '*' && dom === '*' && dow === '*') {
    if (min === '*') return zh ? '每分钟' : 'Every minute';
    if (every) return zh ? `每 ${every[1]} 分钟` : `Every ${every[1]} minutes`;
    if (parsed.minute.length === 1 && /^\d+$/u.test(min)) {
      const m = pad(parsed.minute[0]);
      return zh ? `每小时 ${m} 分` : `Every hour at :${m}`;
    }
    return parsed.source;
  }
  if (!/^\d+$/u.test(min) || !/^\d+$/u.test(hour)) return parsed.source;
  const time = `${pad(parsed.hour[0])}:${pad(parsed.minute[0])}`;
  if (dom === '*' && dow === '*') return zh ? `每天 ${time}` : `Every day at ${time}`;
  if (dom === '*' && dow === '1-5') return zh ? `工作日 ${time}` : `Weekdays at ${time}`;
  if (dom === '*' && /^\d+(,\d+)*$/u.test(dow)) {
    const days = [...new Set(parsed.dayOfWeek.map((day) => day % 7))].sort((a, b) => a - b);
    return zh
      ? `每周${days.map((day) => ZH_WEEKDAYS[day]).join('、')} ${time}`
      : `Every ${days.map((day) => EN_WEEKDAYS[day]).join(', ')} at ${time}`;
  }
  if (dow === '*' && /^\d+$/u.test(dom)) {
    const day = parsed.dayOfMonth[0];
    return zh ? `每月 ${day} 日 ${time}` : `Monthly on day ${day} at ${time}`;
  }
  return parsed.source;
}
