import { describeCron } from '@shared/bots/cron';
import {
  badDayText,
  type ContactBadge,
  type ContactFeedRow,
  type ContactReadCommandName,
  type ContactStatusRow,
  type ContactTodoRow,
  commandListText,
  formatBoardMessage,
  formatFeedMessage,
  formatMemoryMessage,
  formatSchedulesMessage,
  formatStatusMessage,
  formatTodoMessage,
  memoryDisabledText,
  parseBoardDay,
  sessionBadge,
} from '@shared/secretary/commands';
import type { ContactLang } from '@shared/secretary/contact';
import type { FeedCursor, FeedQuery } from '@shared/secretary/feed';
import type {
  SecretaryBoard,
  SecretaryBoardTodo,
  SecretaryCard,
  SecretaryDaily,
  SecretaryScheduleView,
} from '@shared/types/secretary';

type SessionCard = Extract<SecretaryCard, { kind: 'session' }>;

export interface ContactCommandPorts {
  lang(): ContactLang;
  now(): number;
  /** /memory 的开关：默认关闭 */
  allowMemory(): boolean;
  board(): Promise<SecretaryBoard>;
  daily(day: string): Promise<SecretaryDaily>;
  feed(query: FeedQuery): Promise<{ events: ContactFeedRow[]; hasMore: boolean }>;
  schedules(): Promise<(SecretaryScheduleView & { human?: string })[]>;
  /** 只取标题与总数：正文一律不出手机 */
  memories(): Promise<{ titles: string[]; total: number }>;
}

export interface ContactCommandReply {
  text: string;
  /** 有下一页时给游标，由调用方换成按钮 */
  next?: FeedCursor;
}

/** 侧栏徽标与手机同一口径：状态先看实时，再看后台任务与续跑 */
export function badgeOf(card: SessionCard): ContactBadge {
  return sessionBadge({ ...card, stalled: card.stalled !== undefined });
}

function statusRow(card: SessionCard): ContactStatusRow {
  return {
    title: card.title,
    projectName: card.projectName,
    badge: badgeOf(card),
    ...(card.pendingReminder ? { pendingReminder: card.pendingReminder } : {}),
    since: card.stateSince,
    ...(card.lastText ? { lastText: card.lastText } : {}),
    conversationId: card.conversationId,
  };
}

function todoRow(todo: SecretaryBoardTodo): ContactTodoRow {
  return {
    text: todo.text,
    ...(todo.phase ? { phase: todo.phase } : {}),
    ...(todo.projectName ? { projectName: todo.projectName } : {}),
  };
}

/**
 * 手机上的只读命令。全部由 Main 查面板同一份数据后格式化，
 * 不进秘书会话、不唤醒模型，也不提供任何写操作。
 */
export function createContactCommands(ports: ContactCommandPorts) {
  const lang = (): ContactLang => ports.lang();

  async function status(): Promise<ContactCommandReply> {
    const board = await ports.board();
    const running = board.running
      .filter((card): card is SessionCard => card.kind === 'session')
      .map(statusRow);
    const needsYou = board.needsYou
      .filter((card): card is SessionCard => card.kind === 'session')
      .map(statusRow);
    return {
      text: formatStatusMessage(lang(), { running, needsYou, now: ports.now() }),
    };
  }

  async function board(arg: string): Promise<ContactCommandReply> {
    const day = parseBoardDay(arg, ports.now());
    if (!day) return { text: badDayText(lang()) };
    return { text: formatBoardMessage(lang(), await ports.daily(day)) };
  }

  async function feed(before?: FeedCursor): Promise<ContactCommandReply> {
    const page = await ports.feed(before ? { before, limit: 10 } : { limit: 10 });
    const last = page.events.at(-1);
    return {
      text: formatFeedMessage(lang(), { events: page.events, hasMore: page.hasMore }),
      ...(page.hasMore && last ? { next: { at: last.at, id: last.id } } : {}),
    };
  }

  async function todo(): Promise<ContactCommandReply> {
    const board = await ports.board();
    return { text: formatTodoMessage(lang(), board.todos.map(todoRow)) };
  }

  async function schedules(): Promise<ContactCommandReply> {
    const list = await ports.schedules();
    return {
      text: formatSchedulesMessage(lang(), {
        schedules: list.map((schedule) => ({
          ...schedule,
          human: schedule.cron ? describeCron(schedule.cron, lang()) : schedule.at,
        })),
        now: ports.now(),
      }),
    };
  }

  async function memory(): Promise<ContactCommandReply> {
    if (!ports.allowMemory()) return { text: memoryDisabledText(lang()) };
    const { titles, total } = await ports.memories();
    return { text: formatMemoryMessage(lang(), { titles, total }) };
  }

  async function help(): Promise<ContactCommandReply> {
    const head =
      lang() === 'zh'
        ? '这些命令只读，直接查面板的数据：'
        : 'Read-only commands over the same data as the panel:';
    return { text: `${head}\n${commandListText(lang(), ports.allowMemory())}` };
  }

  return {
    /** 翻页也走这里：同一个 /feed，只是带上了游标 */
    async run(name: ContactReadCommandName, arg: string): Promise<ContactCommandReply> {
      if (name === 'status') return status();
      if (name === 'board') return board(arg);
      if (name === 'feed') return feed();
      if (name === 'todo') return todo();
      if (name === 'schedules') return schedules();
      if (name === 'memory') return memory();
      return help();
    },
    feedPage: (before: FeedCursor) => feed(before),
  };
}

export type ContactCommands = ReturnType<typeof createContactCommands>;
