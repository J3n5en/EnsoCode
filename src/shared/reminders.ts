/** 会话给自己定的提醒：worker 写、Main 只读（巡检、秘书、唤醒闸门） */
export interface SessionReminder {
  id: string;
  /** 拥有者：根会话 id 或子会话 id（含 '::'） */
  sessionId: string;
  dueAt: number;
  createdAt: number;
  prompt: string;
  label?: string;
  /** 会话正在跑时推迟到这一轮结束 */
  ifIdle: boolean;
  /** 连续由提醒触发的轮里再定提醒的次数，从 1 起 */
  chain: number;
}

/** 推送给界面与秘书看板的轻量提醒摘要（不含完整 prompt） */
export interface SessionReminderSummary {
  id: string;
  dueAt: number;
  label?: string;
}

/** 下一条未到点（或宽限期内）提醒，供侧栏、GoalBar、秘书看板与工作台复用 */
export interface PendingReminderView extends SessionReminderSummary {
  /** 同一会话挂着多条未到点提醒时的总数 */
  count: number;
}

export interface ReminderFile {
  version: 1;
  reminders: SessionReminder[];
  chains: Record<string, number>;
}

export const REMINDERS_FILE = 'reminders.json';
export const REMINDER_MAX_PER_OWNER = 5;
export const REMINDER_MIN_DELAY_MS = 30_000;
export const REMINDER_MAX_DELAY_MS = 24 * 3_600_000;
export const REMINDER_MAX_CHAIN = 24;
export const REMINDER_PROMPT_MAX = 4000;
export const REMINDER_LABEL_MAX = 80;
/** 到点后这么久还没被叫醒，巡检恢复正常判定 */
export const REMINDER_OVERDUE_GRACE_MS = 2 * 60_000;
/** worker 加载时已过点超过这么久：重启或 worker 停着期间到点，通知里标明延迟 */
export const REMINDER_LATE_MS = 60_000;
/** worker 意外退出后为提醒重新拉起的最短间隔，防崩溃循环 */
export const REMINDER_REVIVE_MIN_MS = 60_000;

/** worker 意外退出后多久为提醒拉起它：最早的到点时间，至少隔 REMINDER_REVIVE_MIN_MS；没有提醒不拉起 */
export function reminderReviveDelay(dueAts: readonly number[], now: number): number | undefined {
  if (dueAts.length === 0) return undefined;
  return Math.max(REMINDER_REVIVE_MIN_MS, Math.min(...dueAts) - now);
}

const ID_RE = /^r[0-9a-f]{8}$/;

const emptyFile = (): ReminderFile => ({ version: 1, reminders: [], chains: {} });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function parseReminder(value: unknown): SessionReminder | null {
  if (!isRecord(value)) return null;
  const { id, sessionId, dueAt, createdAt, prompt, label, ifIdle, chain } = value;
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  if (typeof sessionId !== 'string' || !sessionId) return null;
  if (!isTime(dueAt) || !isTime(createdAt)) return null;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > REMINDER_PROMPT_MAX)
    return null;
  if (label !== undefined && (typeof label !== 'string' || label.length > REMINDER_LABEL_MAX))
    return null;
  if (typeof ifIdle !== 'boolean') return null;
  if (typeof chain !== 'number' || !Number.isInteger(chain) || chain < 1) return null;
  return {
    id,
    sessionId,
    dueAt,
    createdAt,
    prompt,
    ...(label ? { label } : {}),
    ifIdle,
    chain,
  };
}

/** 坏文件返回空表，脏条目逐条丢弃，不抛 */
export function parseReminderFile(value: unknown): ReminderFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.reminders))
    return emptyFile();
  const seen = new Set<string>();
  const reminders: SessionReminder[] = [];
  for (const item of value.reminders) {
    const parsed = parseReminder(item);
    if (!parsed || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    reminders.push(parsed);
  }
  const chains: Record<string, number> = {};
  if (isRecord(value.chains))
    for (const [key, count] of Object.entries(value.chains))
      if (key && typeof count === 'number' && Number.isInteger(count) && count > 0)
        chains[key] = count;
  return { version: 1, reminders, chains };
}

export const ownedByRoot = (sessionId: string, rootId: string): boolean =>
  sessionId === rootId || sessionId.startsWith(`${rootId}::`);

/** 子会话 id（root::child）归到所属根会话 id */
export function rootIdOfReminder(sessionId: string): string {
  const sep = sessionId.indexOf('::');
  return sep === -1 ? sessionId : sessionId.slice(0, sep);
}

export function toReminderSummary(
  item: Pick<SessionReminder, 'id' | 'dueAt' | 'label'>
): SessionReminderSummary {
  return {
    id: item.id,
    dueAt: item.dueAt,
    ...(item.label ? { label: item.label } : {}),
  };
}

/** 根会话自己及其子会话的提醒，按到点时间排序 */
export function remindersOf(file: ReminderFile, rootId: string): SessionReminder[] {
  return file.reminders
    .filter((item) => ownedByRoot(item.sessionId, rootId))
    .sort((a, b) => a.dueAt - b.dueAt);
}

/** 还在等提醒：没到点，或到点不久（叫醒在路上） */
export function hasPendingReminder(
  reminders: readonly Pick<SessionReminder, 'dueAt'>[],
  now: number
): boolean {
  return reminders.some((item) => item.dueAt > now - REMINDER_OVERDUE_GRACE_MS);
}

/** 过滤出未超时宽限期的提醒，按到点时间升序 */
export function pendingRemindersOf<T extends Pick<SessionReminder, 'id' | 'dueAt' | 'label'>>(
  reminders: readonly T[],
  now: number
): T[] {
  return reminders
    .filter((item) => item.dueAt > now - REMINDER_OVERDUE_GRACE_MS)
    .sort((a, b) => a.dueAt - b.dueAt);
}

/** 取最早一条仍在等的提醒；全部超时或为空返回 undefined */
export function nextPendingReminder(
  reminders: readonly Pick<SessionReminder, 'id' | 'dueAt' | 'label'>[],
  now: number
): PendingReminderView | undefined {
  const pending = pendingRemindersOf(reminders, now);
  const first = pending[0];
  if (!first) return undefined;
  return {
    ...toReminderSummary(first),
    count: pending.length,
  };
}

/** 本地 24h 钟点（HH:MM），与上游恢复重试时间同一格式 */
export function formatReminderClock(at: number): string {
  const date = new Date(at);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export type ReminderTranslate = (key: string, params?: Record<string, string | number>) => string;

/** 剩余时间短语（用于悬停提示） */
export function formatReminderRemaining(dueAt: number, now: number, t: ReminderTranslate): string {
  const diffMs = dueAt - now;
  if (diffMs <= 0) return t('due now');
  if (diffMs < 60_000) return t('<1m');
  const totalMinutes = Math.ceil(diffMs / 60_000);
  if (totalMinutes < 60) return t('in {{minutes}}m', { minutes: totalMinutes });
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0
    ? t('in {{hours}}h {{minutes}}m', { hours, minutes })
    : t('in {{hours}}h', { hours });
}

/** 悬停提示：钟点 + 剩余时间 + 完整 label（多条时附总数） */
export function formatReminderTooltip(
  reminder: PendingReminderView,
  now: number,
  t: ReminderTranslate
): string {
  const head = `${t('Waiting for reminder · {{time}}', {
    time: formatReminderClock(reminder.dueAt),
  })} (${formatReminderRemaining(reminder.dueAt, now, t)})`;
  const parts = [head];
  if (reminder.label) parts.push(reminder.label);
  if (reminder.count > 1) parts.push(t('{{count}} reminders', { count: reminder.count }));
  return parts.join(' — ');
}
