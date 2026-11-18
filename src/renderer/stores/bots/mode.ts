import type { BotEvent } from '@shared/types/botIpc';
import { create } from 'zustand';
import { useBotsStore } from '@/stores/bots';
import { openTarget } from '@/stores/bots/delegations';
import { useSettingsStore } from '@/stores/settings';

export type AppMode = 'code' | 'bot';

const MODE_KEY = 'enso-mode';

interface AppModeState {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
}

export const useAppModeStore = create<AppModeState>()((set) => ({
  mode: localStorage.getItem(MODE_KEY) === 'bot' ? 'bot' : 'code',
  setMode: (mode) => {
    localStorage.setItem(MODE_KEY, mode);
    set({ mode });
  },
}));

/** 实际处于 Bot 模式：开关打开且选了 Bot */
export function isBotModeActive(): boolean {
  return useSettingsStore.getState().botModeEnabled && useAppModeStore.getState().mode === 'bot';
}

export function useBotModeActive(): boolean {
  const enabled = useSettingsStore((s) => s.botModeEnabled);
  const mode = useAppModeStore((s) => s.mode);
  return enabled && mode === 'bot';
}

/** 系统通知点击：切到 Bot 模式并打开对应聊天（委派子会话归到委派所属聊天，找不到则收件箱） */
export async function openBotNotification(event: BotEvent): Promise<void> {
  if (!useSettingsStore.getState().botModeEnabled) return;
  const chatId = typeof event.chatId === 'string' ? event.chatId : undefined;
  const conversationId =
    typeof event.conversationId === 'string' ? event.conversationId : undefined;
  const bots = useBotsStore.getState();
  if (!chatId) await bots.refreshDelegations();
  useAppModeStore.getState().setMode('bot');
  const target = openTarget({ chatId, conversationId }, useBotsStore.getState().delegations);
  if (target.kind === 'chat') {
    const chat = bots.chats.find((item) => item.id === target.chatId);
    if (chat?.kind === 'group') bots.openThread(chat.parentId ?? chat.id, chat.id);
  }
  bots.setView(target);
}

/** Code 会话通知点击：从 Bot 模式切回 Code 视图，选中会话由 sessions store 负责 */
export function showLocalCodeView(): void {
  useAppModeStore.getState().setMode('code');
}
