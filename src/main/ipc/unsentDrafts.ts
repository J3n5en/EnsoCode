import { ipcMain } from '@platform';
import { IPC_CHANNELS } from '@shared/types';

/** 报了「有未发送草稿」的 renderer；窗口 / 远端页面关掉即撤 */
const withDraft = new Set<number>();
const watched = new Set<number>();

/** 有输入框里重启后会丢的草稿：不等空闲的自动重启先等 */
export function anyUnsentDraft(): boolean {
  return withDraft.size > 0;
}

export function registerUnsentDraftHandlers(): void {
  ipcMain.on(IPC_CHANNELS.COMPOSER_UNSENT_DRAFT, (event, has: unknown) => {
    if (typeof has !== 'boolean') return;
    const sender = event.sender;
    if (!has) {
      withDraft.delete(sender.id);
      return;
    }
    withDraft.add(sender.id);
    if (watched.has(sender.id)) return;
    watched.add(sender.id);
    sender.once('destroyed', () => {
      withDraft.delete(sender.id);
      watched.delete(sender.id);
    });
  });
}
