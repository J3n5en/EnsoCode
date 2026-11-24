import { formatReminderClock, type PendingReminderView } from '../reminders';
import type {
  SecretaryDaily,
  SecretaryFollowingView,
  SecretaryScheduleView,
} from '../types/secretary';
import { CONTACT_OUTBOUND_MAX_CHARS, type ContactLang, conversationDeepLink } from './contact';
import { dayKey, parseDayKey, shiftDay } from './daily';

/**
 * 手机上的只读命令：由 Main 直接查面板同一份数据、格式化后回复，
 * 不进秘书会话、不唤醒模型。命令名是 Telegram 规范的小写英文。
 */
export type ContactCommandName =
  | 'status'
  | 'board'
  | 'feed'
  | 'todo'
  | 'schedules'
  | 'memory'
  | 'following'
  | 'last'
  | 'sync'
  | 'help';

/**
 * 只读命令：查面板同一份数据；
 * /last、/sync 与 /following 由联系方式服务自己处理（后两者会改状态）
 */
export type ContactReadCommandName = Exclude<ContactCommandName, 'last' | 'sync' | 'following'>;

export interface ContactCommandSpec {
  name: ContactCommandName;
  /** setMyCommands 里的中文描述 */
  zh: string;
  en: string;
  /** 默认关闭：记忆标题会留在 Telegram 服务器上 */
  gated?: true;
}

export const CONTACT_COMMANDS: readonly ContactCommandSpec[] = [
  {
    name: 'status',
    zh: '进行中的会话，以及需要你处理的',
    en: 'Running sessions and what needs you',
  },
  {
    name: 'board',
    zh: '今天的看板；可带日期，如 /board 2026-05-20 或 yesterday',
    en: "Today's board; optional date",
  },
  { name: 'feed', zh: '最近的动态，底部可翻更早', en: 'Recent activity, with an older button' },
  { name: 'todo', zh: '未完成的待办', en: 'Open todos' },
  { name: 'schedules', zh: '定时任务与下次运行时间', en: 'Scheduled tasks and next run' },
  {
    name: 'following',
    zh: '手机关注的任务；/following clear 全清',
    en: 'Tasks followed from the phone; /following clear drops all',
  },
  {
    name: 'last',
    zh: '回看秘书会话最近一轮；/last 3 看最近三轮',
    en: 'Replay the last round; /last 3 for three',
  },
  {
    name: 'sync',
    zh: '把所有回复同步到手机；/sync off 关掉',
    en: 'Mirror every reply here; /sync off stops it',
  },
  {
    name: 'memory',
    zh: '秘书记得的标题（默认关闭）',
    en: 'Memory titles (off by default)',
    gated: true,
  },
  { name: 'help', zh: '列出所有命令', en: 'List every command' },
];

/** setMyCommands 的入参：命令名不带斜杠，描述用中文 */
export function botCommands(): { command: string; description: string }[] {
  return CONTACT_COMMANDS.map((spec) => ({ command: spec.name, description: spec.zh }));
}

/**
 * 解析一条命令。群里 Telegram 会带 @botname 后缀，一并认。
 * 不认识的返回 null，由调用方决定是提示还是当成普通消息。
 */
export function parseContactCommand(
  text: string
): { name: ContactCommandName; arg: string } | null {
  const match = /^\/([A-Za-z][A-Za-z0-9_]{0,31})(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const name = match[1].toLowerCase();
  const arg = (match[2] ?? '').trim();
  if (name === 'start') return { name: 'help', arg };
  const known = CONTACT_COMMANDS.find((spec) => spec.name === name);
  return known ? { name: known.name, arg } : null;
}

/** /help 与欢迎消息里的命令清单 */
export function commandListText(lang: ContactLang, allowMemory: boolean): string {
  return CONTACT_COMMANDS.filter((spec) => !spec.gated || allowMemory)
    .map((spec) => `/${spec.name} — ${lang === 'zh' ? spec.zh : spec.en}`)
    .join('\n');
}

/** Telegram 的 HTML 模式只认这三个实体，正文里的特殊字符一律转义 */
import { escapeHtml } from './telegramHtml';

export { escapeHtml };

/** 一行里放得下的正文：压成一行并截断，避免一条进度把整条消息撑爆 */
export function shortText(text: string | undefined, max = 90): string {
  const flat = (text ?? '').replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * 按行拼到上限为止：整行丢弃，不会把 HTML 标签或实体切两半。
 * 超了就在末尾说明还有多少行没显示。
 */
export function fitLines(lines: readonly string[], lang: ContactLang): string {
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    const next = size + line.length + (kept.length > 0 ? 1 : 0);
    if (next > CONTACT_OUTBOUND_MAX_CHARS - 24) {
      const rest = lines.length - kept.length;
      kept.push(lang === 'zh' ? `…还有 ${rest} 行没显示` : `…${rest} more lines`);
      break;
    }
    kept.push(line);
    size = next;
  }
  return kept.join('\n');
}

/** 跑了多久：手机上一眼能读的粗粒度 */
export function formatElapsed(ms: number, lang: ContactLang): string {
  const zh = lang === 'zh';
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return zh ? '刚刚' : 'just now';
  if (minutes < 60) return zh ? `${minutes} 分钟` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    if (rest === 0) return zh ? `${hours} 小时` : `${hours}h`;
    return zh ? `${hours} 小时 ${rest} 分` : `${hours}h ${rest}m`;
  }
  return zh ? `${Math.floor(hours / 24)} 天` : `${Math.floor(hours / 24)}d`;
}

/** 本地时间：手机上要能直接对上钟点，不带时区缩写 */
export function formatClock(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export type ContactBadge =
  | 'running'
  | 'waiting'
  | 'background'
  | 'reminder'
  | 'persistent'
  | 'subagent'
  | 'continuing'
  | 'interrupted'
  | 'stalled'
  | 'idle'
  | 'failed';

/** 与侧栏「进行中」列表同一套徽标文案 */
const BADGE_TEXT: Record<ContactLang, Record<ContactBadge, string>> = {
  zh: {
    running: '运行中',
    waiting: '等你回答',
    background: '等后台任务',
    reminder: '等提醒',
    persistent: '有常驻服务',
    subagent: '等子代理',
    continuing: '续跑中',
    interrupted: '已中断',
    stalled: '已停住',
    idle: '空闲',
    failed: '失败',
  },
  en: {
    running: 'Running',
    waiting: 'Waiting for you',
    background: 'Waiting on a background task',
    reminder: 'Waiting for reminder',
    persistent: 'Service running',
    subagent: 'Waiting on subagent',
    continuing: 'Continuing',
    interrupted: 'Interrupted',
    stalled: 'Stalled, no activity',
    idle: 'Idle',
    failed: 'Failed',
  },
};

export function badgeText(lang: ContactLang, badge: ContactBadge): string {
  return BADGE_TEXT[lang][badge];
}

/**
 * 侧栏「进行中」列表与手机 /status 共用的判定：
 * 出错、等你、在跑优先；空闲时再看是不是在等后台任务或还要续跑。
 */
export function sessionBadge(card: {
  state: string;
  /** 这一轮的结果：被应用退出打断的会话不是「进行中」，看板与手机都显示已中断 */
  result?: string;
  backgroundRunning?: boolean;
  backgroundPersistent?: boolean;
  subagents?: readonly { agentId: string; runId: string; title?: string; elapsedMs: number }[];
  pendingReminder?: Pick<PendingReminderView, 'dueAt' | 'label'>;
  continuing?: boolean;
  /** 巡检判定停住：会话还挂着但已经不动了，比「在跑」「续跑中」更该说 */
  stalled?: boolean;
}): ContactBadge {
  if (card.result === 'interrupted') return 'interrupted';
  if (card.state === 'error') return 'failed';
  if (card.state === 'waiting') return 'waiting';
  if (card.stalled) return 'stalled';
  if (card.subagents && card.subagents.length > 0) return 'subagent';
  if (card.state === 'running') return 'running';
  if (card.backgroundRunning) return 'background';
  if (card.pendingReminder) return 'reminder';
  // 常驻服务不会自己结束，和「等后台任务」分开说，免得看起来像还在干活
  if (card.backgroundPersistent) return 'persistent';
  if (card.continuing) return 'continuing';
  return 'idle';
}

/** 看板与动态的标签是共享常量，面板靠 i18n 翻，手机上在这里翻 */
const LABEL_ZH: Record<string, string> = {
  'Goal complete': '完成',
  'Turn ended': '一轮结束',
  'Goal blocked': '目标受阻',
  'Waiting for you': '等你回答',
  Stalled: '停滞',
  Interrupted: '已中断',
  Failed: '失败',
  Started: '开始',
  Idle: '空闲',
  'Not started': '未开始',
  Queued: '排队中',
  'In progress': '进行中',
  'Waiting on a background task': '等后台任务',
  'Waiting for reminder': '等提醒',
  'Waiting for your confirmation': '等你确认',
  'Waiting for dependencies': '等依赖',
  'Dispatch problem': '派发出问题',
  'Secretary saw this': '秘书看到了',
  Added: '新增',
  Done: '完成',
};

export function labelText(lang: ContactLang, label: string): string {
  return lang === 'zh' ? (LABEL_ZH[label] ?? label) : label;
}

export interface ContactStatusRow {
  title: string;
  projectName: string;
  badge: ContactBadge;
  pendingReminder?: PendingReminderView;
  since: number;
  lastText?: string;
  conversationId: string;
}

function linkedTitle(row: { title: string; conversationId?: string }): string {
  const title = escapeHtml(row.title.trim() || '未命名');
  if (!row.conversationId) return title;
  return `<a href="${conversationDeepLink(row.conversationId)}">${title}</a>`;
}

function statusBlock(lang: ContactLang, row: ContactStatusRow, now: number): string[] {
  const badgeLabel =
    row.badge === 'reminder' && row.pendingReminder
      ? `${badgeText(lang, 'reminder')} · ${formatReminderClock(row.pendingReminder.dueAt)}`
      : badgeText(lang, row.badge);
  const meta = [badgeLabel, formatElapsed(now - row.since, lang)];
  const project = row.projectName ? ` · ${escapeHtml(row.projectName)}` : '';
  const lines = [`▸ ${linkedTitle(row)}${project}`, `   ${meta.join(' · ')}`];
  const last = shortText(row.lastText);
  if (last) lines.push(`   ${escapeHtml(last)}`);
  return lines;
}

/** /status：进行中 + 需要你处理，两块分开列 */
export function formatStatusMessage(
  lang: ContactLang,
  input: {
    running: readonly ContactStatusRow[];
    needsYou: readonly ContactStatusRow[];
    now: number;
  }
): string {
  const zh = lang === 'zh';
  const lines: string[] = [];
  if (input.running.length === 0 && input.needsYou.length === 0) {
    return zh
      ? '现在没有在跑的会话，也没有等你处理的。'
      : 'Nothing is running and nothing needs you.';
  }
  if (input.running.length > 0) {
    lines.push(`<b>${zh ? '进行中' : 'Running'} ${input.running.length}</b>`);
    for (const row of input.running) lines.push(...statusBlock(lang, row, input.now));
  }
  if (input.needsYou.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`<b>${zh ? '需要你处理' : 'Needs you'} ${input.needsYou.length}</b>`);
    for (const row of input.needsYou) lines.push(...statusBlock(lang, row, input.now));
  }
  return fitLines(lines, lang);
}

/** /board 的日期参数：今天、昨天、或 YYYY-MM-DD */
export function parseBoardDay(arg: string, now: number): string | null {
  const value = arg.trim().toLowerCase();
  const today = dayKey(now);
  if (value === '' || value === 'today' || value === '今天') return today;
  if (value === 'yesterday' || value === '昨天') return shiftDay(today, -1);
  return parseDayKey(value);
}

export type SyncAction = 'on' | 'off' | 'status';

/** /sync 的参数：不带就是查状态；只认 on/off（也认 开/关） */
export function parseSyncArg(arg: string): SyncAction | null {
  const value = arg.trim().toLowerCase();
  if (!value) return 'status';
  if (value === 'on' || value === '开') return 'on';
  if (value === 'off' || value === '关') return 'off';
  return null;
}

/** /sync 的回复：开、关、查状态都走这一条 */
export function formatSyncMessage(lang: ContactLang, on: boolean): string {
  const zh = lang === 'zh';
  if (on) {
    return zh
      ? '🔔 已打开同步：秘书会话里每一轮回复都会发到这里，静默回合只发一行摘要。发 /sync off 关掉。'
      : '🔔 Sync is on: every reply in the secretary conversation comes here, silent turns as a one-line summary. Send /sync off to stop.';
  }
  return zh
    ? '🔕 同步已关闭：只发完成、失败、需要你这类里程碑。发 /sync on 打开。'
    : '🔕 Sync is off: only milestones go out. Send /sync on to mirror every reply.';
}

export function syncUsageText(lang: ContactLang): string {
  return lang === 'zh'
    ? '用法：/sync 看状态，/sync on 打开，/sync off 关闭。'
    : 'Usage: /sync shows the state, /sync on turns it on, /sync off turns it off.';
}

/** /following 的参数：不带参数是列表，clear 全清，cancel <序号> 取消一项 */
export type FollowingArg =
  | { action: 'list' }
  | { action: 'clear' }
  | { action: 'cancel'; index: number };

export function parseFollowingArg(arg: string): FollowingArg | null {
  const text = arg.trim().toLowerCase();
  if (!text) return { action: 'list' };
  if (text === 'clear' || text === 'all' || text === '全清' || text === '清空') {
    return { action: 'clear' };
  }
  const match = /^(?:cancel|drop|取消)\s*#?(\d{1,3})$/u.exec(text);
  if (!match) return null;
  const index = Number(match[1]);
  return index >= 1 ? { action: 'cancel', index } : null;
}

export function followKindLabel(lang: ContactLang, kind: SecretaryFollowingView['kind']): string {
  if (kind === 'schedule') return lang === 'zh' ? '定时' : 'scheduled';
  return lang === 'zh' ? '会话' : 'session';
}

export function followingEmptyText(lang: ContactLang): string {
  return lang === 'zh'
    ? '手机还没有关注的任务。从手机派活或加定时之后，结果会一直跟到这里，完成或失败推一次就结束。'
    : 'Nothing is followed yet. Dispatch or schedule something from the phone and its result keeps coming here until it finishes or fails once.';
}

export function followingUsageText(lang: ContactLang): string {
  return lang === 'zh'
    ? '用法：/following 看列表，/following cancel 2 取消一项，/following clear 全清。'
    : 'Usage: /following lists them, /following cancel 2 drops one, /following clear drops all.';
}

/** /following：手机关注的任务，序号与按钮一一对应 */
export function formatFollowingMessage(
  lang: ContactLang,
  input: { items: readonly SecretaryFollowingView[]; now: number }
): string {
  if (input.items.length === 0) return followingEmptyText(lang);
  const zh = lang === 'zh';
  const lines = [`<b>${zh ? '手机关注' : 'Following'} ${input.items.length}</b>`];
  for (const [index, item] of input.items.entries()) {
    const kind = followKindLabel(lang, item.kind);
    const summary = escapeHtml(shortText(item.summary, 60)) || item.id;
    lines.push(
      `${index + 1}. ▸ ${kind} · ${summary} · ${formatElapsed(input.now - item.at, lang)}`
    );
  }
  lines.push(
    zh
      ? '点按钮取消；/following clear 全清。完成或失败推过一次就自动结束。'
      : 'Tap a button to drop one; /following clear drops all. A follow ends after one done or failed push.'
  );
  return fitLines(lines, lang);
}

const DAILY_GROUP_LABEL: Record<ContactLang, Record<string, string>> = {
  zh: {
    running: '进行中',
    needsYou: '需要你',
    done: '完成',
    failed: '失败',
    todos: '待办',
    changes: '设置变更',
  },
  en: {
    running: 'Running',
    needsYou: 'Needs you',
    done: 'Done',
    failed: 'Failed',
    todos: 'Todos',
    changes: 'Changes',
  },
};

/** /board：一行统计，再按列列卡片标题 */
export function formatBoardMessage(
  lang: ContactLang,
  daily: SecretaryDaily,
  options: { perGroup?: number } = {}
): string {
  const zh = lang === 'zh';
  const perGroup = options.perGroup ?? 8;
  const counts = daily.counts;
  const head = zh
    ? `<b>${daily.day}${daily.today ? '（今天）' : ''}</b>`
    : `<b>${daily.day}${daily.today ? ' (today)' : ''}</b>`;
  const stats = zh
    ? `派出 ${counts.dispatched} · 完成 ${counts.completed}${counts.completedEarlier > 0 ? `（含之前派出或接手的 ${counts.completedEarlier}）` : ''} · 失败 ${counts.failed} · 需要你 ${counts.needsYou}`
    : `dispatched ${counts.dispatched} · done ${counts.completed}${counts.completedEarlier > 0 ? ` (${counts.completedEarlier} earlier or taken over)` : ''} · failed ${counts.failed} · needs you ${counts.needsYou}`;
  const lines = [head, stats];
  if (daily.groups.length === 0) {
    lines.push(zh ? '这一天没有记录。' : 'No records for this day.');
    return fitLines(lines, lang);
  }
  for (const group of daily.groups) {
    lines.push('');
    lines.push(`<b>${DAILY_GROUP_LABEL[lang][group.key] ?? group.key} ${group.items.length}</b>`);
    for (const item of group.items.slice(0, perGroup)) {
      const link = linkedTitle({
        title: shortText(item.title || item.id, 70),
        ...(item.conversationId ? { conversationId: item.conversationId } : {}),
      });
      const label = item.label ? ` · ${escapeHtml(labelText(lang, item.label))}` : '';
      const project = item.projectName ? ` · ${escapeHtml(item.projectName)}` : '';
      lines.push(`▸ ${link}${project}${label}`);
    }
    if (group.items.length > perGroup) {
      const rest = group.items.length - perGroup;
      lines.push(zh ? `…还有 ${rest} 条` : `…${rest} more`);
    }
  }
  return fitLines(lines, lang);
}

export interface ContactFeedRow {
  id: string;
  at: number;
  title: string;
  projectName: string;
  label: string;
  detail?: string;
  conversationId?: string;
}

/** /feed：最近几条动态，新的在前 */
export function formatFeedMessage(
  lang: ContactLang,
  input: { events: readonly ContactFeedRow[]; hasMore: boolean }
): string {
  const zh = lang === 'zh';
  if (input.events.length === 0) return zh ? '还没有动态。' : 'No activity yet.';
  const lines = [`<b>${zh ? '最近动态' : 'Recent activity'}</b>`];
  for (const event of input.events) {
    const time = formatClock(event.at);
    const project = event.projectName ? ` · ${escapeHtml(event.projectName)}` : '';
    lines.push(
      `▸ ${time} ${linkedTitle(event)}${project} · ${escapeHtml(labelText(lang, event.label))}`
    );
    const detail = shortText(event.detail, 70);
    if (detail) lines.push(`   ${escapeHtml(detail)}`);
  }
  if (input.hasMore) {
    lines.push('');
    lines.push(zh ? '点下面的按钮看更早的。' : 'Tap below for older.');
  }
  return fitLines(lines, lang);
}

export interface ContactTodoRow {
  text: string;
  phase?: string;
  projectName?: string;
}

/** /todo：进行中与待办分开，problem 的标一下 */
export function formatTodoMessage(lang: ContactLang, todos: readonly ContactTodoRow[]): string {
  const zh = lang === 'zh';
  const active = todos.filter((todo) => todo.phase === 'active');
  const open = todos.filter((todo) => todo.phase !== 'active');
  if (active.length === 0 && open.length === 0) {
    return zh ? '没有未完成的待办。' : 'No open todos.';
  }
  const lines: string[] = [];
  const block = (label: string, items: readonly ContactTodoRow[]): void => {
    if (items.length === 0) return;
    if (lines.length > 0) lines.push('');
    lines.push(`<b>${label} ${items.length}</b>`);
    for (const todo of items) {
      const mark = todo.phase === 'problem' ? ' ⚠' : '';
      const project = todo.projectName ? ` · ${escapeHtml(todo.projectName)}` : '';
      lines.push(`▸ ${escapeHtml(shortText(todo.text, 70))}${project}${mark}`);
    }
  };
  block(zh ? '进行中' : 'Active', active);
  block(zh ? '待办' : 'To do', open);
  return fitLines(lines, lang);
}

/** /schedules：名称、人话周期、下次运行 */
export function formatSchedulesMessage(
  lang: ContactLang,
  input: {
    schedules: readonly (SecretaryScheduleView & { human?: string })[];
    now: number;
  }
): string {
  const zh = lang === 'zh';
  if (input.schedules.length === 0) return zh ? '没有定时任务。' : 'No scheduled tasks.';
  const lines = [`<b>${zh ? '定时任务' : 'Scheduled'} ${input.schedules.length}</b>`];
  for (const schedule of input.schedules) {
    const when = schedule.human ?? schedule.cron ?? schedule.at ?? '';
    const next =
      schedule.nextRunAt !== undefined
        ? zh
          ? `下次 ${formatClock(schedule.nextRunAt)}`
          : `next ${formatClock(schedule.nextRunAt)}`
        : zh
          ? '下次时间未定'
          : 'next run unknown';
    lines.push(`▸ ${escapeHtml(shortText(schedule.name, 50))} · ${escapeHtml(when)} · ${next}`);
  }
  return fitLines(lines, lang);
}

/** /memory：只给标题，正文一律不出手机 */
export function formatMemoryMessage(
  lang: ContactLang,
  input: { titles: readonly string[]; total: number }
): string {
  const zh = lang === 'zh';
  if (input.titles.length === 0) return zh ? '秘书记得的还不多。' : 'Nothing saved yet.';
  const lines = [`<b>${zh ? '秘书记得' : 'Remembered'} ${input.total}</b>`];
  for (const title of input.titles) lines.push(`▸ ${escapeHtml(shortText(title, 70))}`);
  if (input.total > input.titles.length) {
    const rest = input.total - input.titles.length;
    lines.push(zh ? `…还有 ${rest} 条` : `…${rest} more`);
  }
  lines.push(zh ? '只显示标题；正文留在应用里。' : 'Titles only; the full text stays in the app.');
  return fitLines(lines, lang);
}

/** /memory 关闭时的回复 */
export function memoryDisabledText(lang: ContactLang): string {
  return lang === 'zh'
    ? '记忆标题默认不在 Telegram 显示。要看得在应用的「联系方式」页打开开关。'
    : 'Memory titles are hidden on Telegram by default. Turn it on in the app under Contacts.';
}

/** 不认识的命令：给个清单，不要静默 */
export function unknownCommandText(lang: ContactLang, allowMemory: boolean): string {
  const head = lang === 'zh' ? '没有这个命令。可用的有：' : 'Unknown command. Available:';
  return `${head}\n${commandListText(lang, allowMemory)}`;
}

/** /board 日期写错时的提示 */
export function badDayText(lang: ContactLang): string {
  return lang === 'zh'
    ? '日期看不懂。用 /board 2026-05-20 或 /board yesterday。'
    : 'Unrecognized date. Use /board 2026-05-20 or /board yesterday.';
}
