import type { BotChat } from '../types/bot';

export interface ChatFlagsInput {
  pinned?: boolean;
  settled?: boolean;
  /** null = 取消提醒（仍保持搁置） */
  snoozedUntil?: number | null;
  /** null = 清除手动顺序 */
  pinOrder?: number | null;
}

const unsettle = (chat: BotChat) => {
  delete chat.settledAt;
  delete chat.snoozedUntil;
};
const settle = (chat: BotChat, now: number) => {
  chat.settledAt ??= now;
  chat.pinned = false;
  delete chat.pinOrder;
};

/** 置顶 / 搁置 / 稍后提醒 / 置顶顺序：搁置与置顶互斥，提醒隐含搁置 */
export function applyChatFlags(chat: BotChat, input: ChatFlagsInput, now: number): BotChat {
  const next: BotChat = { ...chat };
  if (input.pinned === true) {
    next.pinned = true;
    unsettle(next);
  } else if (input.pinned === false) {
    next.pinned = false;
    delete next.pinOrder;
  }
  if (input.pinOrder === null) delete next.pinOrder;
  else if (input.pinOrder !== undefined && next.pinned) next.pinOrder = input.pinOrder;
  if (input.settled === true) settle(next, now);
  else if (input.settled === false) unsettle(next);
  if (input.snoozedUntil === null) delete next.snoozedUntil;
  else if (input.snoozedUntil !== undefined) {
    settle(next, now);
    next.snoozedUntil = input.snoozedUntil;
  }
  return next;
}

/** 有新消息：已搁置的聊天回到进行中；无需改动返回 undefined */
export function wakeOnActivity(chat: BotChat): BotChat | undefined {
  if (chat.settledAt === undefined && chat.snoozedUntil === undefined) return undefined;
  const next = { ...chat };
  unsettle(next);
  return next;
}

const snoozed = (chat: BotChat): chat is BotChat & { snoozedUntil: number } =>
  chat.snoozedUntil !== undefined && chat.archivedAt === undefined;

export function dueSnoozes(chats: readonly BotChat[], now: number): BotChat[] {
  return chats.filter((chat) => snoozed(chat) && chat.snoozedUntil <= now);
}

export function nextSnoozeAt(chats: readonly BotChat[]): number | undefined {
  const times = chats.filter(snoozed).map((chat) => chat.snoozedUntil);
  return times.length > 0 ? Math.min(...times) : undefined;
}
