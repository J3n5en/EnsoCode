import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  ownedByRoot,
  parseReminderFile,
  REMINDER_LABEL_MAX,
  REMINDER_LATE_MS,
  REMINDER_MAX_CHAIN,
  REMINDER_MAX_PER_OWNER,
  REMINDER_MIN_DELAY_MS,
  REMINDER_PROMPT_MAX,
  type ReminderFile,
  rootIdOfReminder,
  type SessionReminder,
} from '@shared/reminders';

/** 到点没被取走的提醒（等 Main 打开会话、等这一轮结束）隔这么久再回调一次 */
export const REMINDER_RETRY_MS = 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

/** 提醒存储：内存 + 原子落盘；单个定时器指向最早的到点时间 */
export class ReminderStore {
  private data: ReminderFile;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryAt: number | undefined;
  private disposed = false;
  /** 加载时就已过点的：重启或 worker 停着期间到点 */
  private readonly lateAtLoad: ReadonlySet<string>;

  constructor(
    private readonly file: string,
    private readonly onTick: () => void,
    private readonly onChange?: (changedRootIds: readonly string[]) => void
  ) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {}
    this.data = parseReminderFile(raw);
    const loadedAt = Date.now();
    this.lateAtLoad = new Set(
      this.data.reminders
        .filter((item) => loadedAt - item.dueAt > REMINDER_LATE_MS)
        .map((item) => item.id)
    );
    this.arm();
  }

  missedWhileDown(id: string): boolean {
    return this.lateAtLoad.has(id);
  }

  list(owner: string): SessionReminder[] {
    return this.data.reminders
      .filter((item) => item.sessionId === owner)
      .sort((a, b) => a.dueAt - b.dueAt);
  }

  /** 根会话自己及其子会话 */
  forRoot(rootId: string): SessionReminder[] {
    return this.data.reminders.filter((item) => ownedByRoot(item.sessionId, rootId));
  }

  due(now: number): SessionReminder[] {
    return this.data.reminders
      .filter((item) => item.dueAt <= now)
      .sort((a, b) => a.dueAt - b.dueAt);
  }

  newId(): string {
    for (;;) {
      const id = `r${randomBytes(4).toString('hex')}`;
      if (!this.data.reminders.some((item) => item.id === id)) return id;
    }
  }

  add(reminder: SessionReminder): void {
    this.data.reminders.push(reminder);
    this.commit([rootIdOfReminder(reminder.sessionId)]);
  }

  cancel(owner: string, id: string): boolean {
    const before = this.data.reminders.length;
    this.data.reminders = this.data.reminders.filter(
      (item) => !(item.sessionId === owner && item.id === id)
    );
    if (this.data.reminders.length === before) return false;
    this.commit([rootIdOfReminder(owner)]);
    return true;
  }

  cancelAll(owner: string): number {
    const before = this.data.reminders.length;
    this.data.reminders = this.data.reminders.filter((item) => item.sessionId !== owner);
    const removed = before - this.data.reminders.length;
    if (removed > 0) this.commit([rootIdOfReminder(owner)]);
    return removed;
  }

  /** 根会话及其所有子会话的提醒和链计数 */
  clear(rootId: string): void {
    const before = this.data.reminders.length;
    this.data.reminders = this.data.reminders.filter(
      (item) => !ownedByRoot(item.sessionId, rootId)
    );
    const chains = Object.keys(this.data.chains).filter((key) => ownedByRoot(key, rootId));
    for (const key of chains) delete this.data.chains[key];
    if (this.data.reminders.length !== before || chains.length > 0) {
      this.commit(this.data.reminders.length !== before ? [rootId] : []);
    }
  }

  /** 先从存储删再交出：保证只投递一次 */
  take(id: string): SessionReminder | undefined {
    const found = this.data.reminders.find((item) => item.id === id);
    if (!found) return undefined;
    this.data.reminders = this.data.reminders.filter((item) => item !== found);
    this.commit([rootIdOfReminder(found.sessionId)]);
    return found;
  }

  chain(owner: string): number {
    return this.data.chains[owner] ?? 0;
  }

  setChain(owner: string, count: number): void {
    if (this.data.chains[owner] === count) return;
    this.data.chains[owner] = count;
    this.commit();
  }

  resetChain(owner: string): void {
    if (this.data.chains[owner] === undefined) return;
    delete this.data.chains[owner];
    this.commit();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private commit(changedRootIds: readonly string[] = []): void {
    this.save();
    this.arm();
    if (changedRootIds.length > 0) this.onChange?.(changedRootIds);
  }

  private save(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.file);
    } catch (error) {
      console.warn('[reminder] failed to persist reminders:', error);
    }
  }

  private arm(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed) return;
    if (this.data.reminders.length === 0) {
      this.retryAt = undefined;
      return;
    }
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    for (const item of this.data.reminders)
      next = Math.min(next, item.dueAt > now ? item.dueAt : (this.retryAt ?? now));
    this.timer = setTimeout(() => this.tick(), Math.min(Math.max(0, next - now), MAX_TIMER_MS));
    this.timer.unref?.();
  }

  private tick(): void {
    this.timer = undefined;
    this.retryAt = Date.now() + REMINDER_RETRY_MS;
    try {
      this.onTick();
    } finally {
      this.arm();
    }
  }
}

const DURATION_RE =
  /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)?$/i;

/** "90s" / "5m" / "2h"，裸数字按秒 */
export function parseReminderDelay(value: string): number | undefined {
  const match = DURATION_RE.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase()[0];
  const ms = amount * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000);
  return Number.isFinite(ms) ? Math.round(ms) : undefined;
}

export function formatReminderDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 120) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hours ${rest} minutes` : `${hours} hours`;
}

/** 本地时区的 ISO 时间（带偏移） */
export function localIso(ms: number): string {
  const date = new Date(ms);
  const offset = -date.getTimezoneOffset();
  const pad = (value: number) => String(Math.floor(Math.abs(value))).padStart(2, '0');
  const local = new Date(ms + offset * 60_000).toISOString().slice(0, 19);
  return `${local}${offset >= 0 ? '+' : '-'}${pad(offset / 60)}:${pad(offset % 60)}`;
}

type Params = Record<string, unknown>;

function normalizeRemindArgs(raw: unknown): Params {
  const args: Params = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  if (typeof args.in === 'number') args.in = String(args.in);
  for (const key of ['in', 'at', 'label'] as const)
    if (typeof args[key] === 'string') args[key] = (args[key] as string).trim();
  if (args.ifIdle === 'true') args.ifIdle = true;
  else if (args.ifIdle === 'false') args.ifIdle = false;
  return args;
}

const text = (value: string) => ({
  content: [{ type: 'text' as const, text: value }],
  details: undefined,
});

export interface ReminderToolOptions {
  /** 子代理为 Run 持有上限 */
  maxDelayMs: number;
  now?: () => number;
  /** 返回拒绝理由时不能定提醒（如子代理不在 Run 里） */
  unavailable?: () => string | undefined;
}

export function createReminderTools(
  store: ReminderStore,
  ownerId: string,
  options: ReminderToolOptions
): ToolDefinition[] {
  const now = options.now ?? (() => Date.now());
  const maxText = formatReminderDuration(options.maxDelayMs);
  const limits =
    `Limits: at most ${REMINDER_MAX_PER_OWNER} pending reminders; ` +
    `between ${REMINDER_MIN_DELAY_MS / 1000} seconds and ${maxText} away; ` +
    `at most ${REMINDER_MAX_CHAIN} reminders in a row set from reminder-triggered turns; ` +
    `prompt up to ${REMINDER_PROMPT_MAX} characters.`;
  const remind: ToolDefinition = {
    name: 'remind_me',
    label: 'Remind me',
    description:
      'Set a reminder for yourself: at the due time this session is woken with a new turn that carries your prompt. ' +
      'When waiting for CI, a deploy, a review or any external result, prefer remind_me and then end your turn — ' +
      'do not keep a background task alive just to wait (sleep N; ..., gh pr checks --watch, polling loops). ' +
      `Pass either \`in\` (e.g. "90s", "5m", "2h"; a bare number means seconds) or \`at\` (ISO time), not both. ${limits}`,
    promptSnippet:
      'remind_me: wake this session later with your own prompt (instead of sleep/--watch waits)',
    parameters: {
      type: 'object',
      properties: {
        in: {
          type: 'string',
          description: 'Delay from now, e.g. "90s", "5m", "2h"; bare number = seconds',
        },
        at: { type: 'string', description: 'Due time as an ISO 8601 timestamp' },
        prompt: {
          type: 'string',
          description: 'What to do when woken; write it so your future self can act on it directly',
        },
        label: { type: 'string', description: `Short label (max ${REMINDER_LABEL_MAX} chars)` },
        ifIdle: {
          type: 'boolean',
          description:
            'Default true: if a turn is running at the due time, wait until it ends. false: deliver into the running turn',
        },
      },
      required: ['prompt'],
    } as unknown as ToolDefinition['parameters'],
    prepareArguments: normalizeRemindArgs as unknown as ToolDefinition['prepareArguments'],
    async execute(_id, params) {
      const args = normalizeRemindArgs(params);
      const blocked = options.unavailable?.();
      if (blocked) throw new Error(blocked);
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (!prompt)
        throw new Error('prompt is required: write what to do when the reminder is due.');
      if (prompt.length > REMINDER_PROMPT_MAX)
        throw new Error(`prompt is too long (max ${REMINDER_PROMPT_MAX} characters).`);
      const label = args.label;
      if (label !== undefined && typeof label !== 'string')
        throw new Error('label must be a string.');
      if (typeof label === 'string' && label.length > REMINDER_LABEL_MAX)
        throw new Error(`label is too long (max ${REMINDER_LABEL_MAX} characters).`);
      if (args.ifIdle !== undefined && typeof args.ifIdle !== 'boolean')
        throw new Error('ifIdle must be a boolean.');
      const hasIn = args.in !== undefined && args.in !== '';
      const hasAt = args.at !== undefined && args.at !== '';
      if (hasIn === hasAt) throw new Error('Pass exactly one of `in` or `at`.');
      const current = now();
      let delay: number | undefined;
      if (hasIn) {
        delay = typeof args.in === 'string' ? parseReminderDelay(args.in) : undefined;
        if (delay === undefined)
          throw new Error('`in` must look like "90s", "5m" or "2h" (a bare number means seconds).');
      } else {
        const at = typeof args.at === 'string' ? Date.parse(args.at) : Number.NaN;
        if (!Number.isFinite(at)) throw new Error('`at` must be an ISO 8601 timestamp.');
        delay = at - current;
      }
      if (delay < REMINDER_MIN_DELAY_MS)
        throw new Error(
          `A reminder must be at least ${REMINDER_MIN_DELAY_MS / 1000} seconds away.`
        );
      if (delay > options.maxDelayMs)
        throw new Error(
          `A reminder can be at most ${maxText} away here.` +
            (ownerId.includes('::') ? ' A subagent Run waits at most that long.' : '')
        );
      const pending = store.list(ownerId).length;
      if (pending >= REMINDER_MAX_PER_OWNER)
        throw new Error(
          `You already have ${pending} pending reminders (at most ${REMINDER_MAX_PER_OWNER}). Cancel one with reminder_cancel first.`
        );
      const chain = store.chain(ownerId) + 1;
      if (chain > REMINDER_MAX_CHAIN)
        throw new Error(
          `Reminders have already re-armed themselves ${REMINDER_MAX_CHAIN} times in a row without any other input. ` +
            'Stop waiting: report the current state instead.'
        );
      const reminder: SessionReminder = {
        id: store.newId(),
        sessionId: ownerId,
        dueAt: current + delay,
        createdAt: current,
        prompt,
        ...(label ? { label } : {}),
        ifIdle: args.ifIdle !== false,
        chain,
      };
      store.add(reminder);
      return text(
        `Reminder ${reminder.id} set for ${localIso(reminder.dueAt)} (in ${formatReminderDuration(delay)}). ` +
          `${pending + 1} pending. You will be woken with a new turn carrying your prompt; end this turn now instead of waiting.`
      );
    },
  };
  const list: ToolDefinition = {
    name: 'reminder_list',
    label: 'Reminder list',
    description: 'List your pending reminders (set with remind_me).',
    promptSnippet: 'reminder_list: list your pending reminders',
    parameters: { type: 'object', properties: {} } as unknown as ToolDefinition['parameters'],
    async execute() {
      const items = store.list(ownerId);
      if (items.length === 0) return text('No pending reminders.');
      const current = now();
      return text(
        items
          .map(
            (item) =>
              `- ${item.id}${item.label ? ` [${item.label}]` : ''} due ${localIso(item.dueAt)} ` +
              `(${item.dueAt > current ? `in ${formatReminderDuration(item.dueAt - current)}` : 'due now'})` +
              `${item.ifIdle ? '' : ', ifIdle=false'}`
          )
          .join('\n')
      );
    },
  };
  const cancel: ToolDefinition = {
    name: 'reminder_cancel',
    label: 'Reminder cancel',
    description: 'Cancel one of your pending reminders by id, or all of them with id "all".',
    promptSnippet: 'reminder_cancel: cancel a pending reminder by id (or "all")',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Reminder id, or "all"' } },
      required: ['id'],
    } as unknown as ToolDefinition['parameters'],
    async execute(_id, params) {
      const id = String((params as Params).id ?? '').trim();
      if (!id) throw new Error('id is required.');
      if (id === 'all') return text(`Cancelled ${store.cancelAll(ownerId)} reminder(s).`);
      if (store.cancel(ownerId, id)) return text(`Cancelled ${id}.`);
      return text(
        `Reminder ${id} not found. Pending: [${store
          .list(ownerId)
          .map((item) => item.id)
          .join(', ')}]`
      );
    },
  };
  return [remind, list, cancel];
}

/** 到点注入的文本：标明是自己用 remind_me 定的，原样附上 prompt */
export function reminderNotice(reminder: SessionReminder, deliveredLateAt?: number): string {
  const late =
    deliveredLateAt === undefined
      ? ''
      : ` It came due while EnsoCode was restarting or not running, so it is delivered late (now ${localIso(deliveredLateAt)}).`;
  return [
    `Reminder ${reminder.id}${reminder.label ? ` "${reminder.label}"` : ''} is due: you set it yourself with remind_me ` +
      `at ${localIso(reminder.createdAt)}, due ${localIso(reminder.dueAt)}.${late} Your note:`,
    reminder.prompt,
  ].join('\n');
}
