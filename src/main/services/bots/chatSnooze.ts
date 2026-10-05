import { dueSnoozes, nextSnoozeAt } from '../../../shared/bots/chatFlags';
import type { BotChat } from '../../../shared/types/bot';
import type { BotChatStore } from './chatStore';

/** setTimeout 上限约 24.8 天；远期提醒分段等待 */
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;

/** 稍后提醒：单个定时器指向最早的提醒，到点取消搁置并回调 */
export class ChatSnoozeTimer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly deps: {
      chats: Pick<BotChatStore, 'list' | 'update'>;
      onDue: (chat: BotChat) => void;
    }
  ) {}

  refresh(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed) return;
    const next = nextSnoozeAt(this.deps.chats.list());
    if (next === undefined) return;
    this.timer = setTimeout(
      () => this.fire(),
      Math.min(MAX_WAIT_MS, Math.max(0, next - Date.now()))
    );
    this.timer.unref?.();
  }

  private fire(): void {
    this.timer = undefined;
    if (this.disposed) return;
    for (const chat of dueSnoozes(this.deps.chats.list(), Date.now())) {
      const woke = this.deps.chats.update(chat.id, (draft) => {
        delete draft.snoozedUntil;
        delete draft.settledAt;
        return draft;
      });
      if (woke) this.deps.onDue(woke);
    }
    this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
