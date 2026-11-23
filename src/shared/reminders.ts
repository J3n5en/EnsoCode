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
