import type { BotEvent } from '@shared/types/botIpc';
import { create } from 'zustand';
import { useBotsStore } from '@/stores/bots';
import { openTarget } from '@/stores/bots/delegations';
import { useRemoteNodesStore } from '@/stores/remoteNodes';
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

/** 实际处于 Bot 模式：开关打开、停在本机、且选了 Bot */
export function isBotModeActive(): boolean {
  return (
    useSettingsStore.getState().botModeEnabled &&
    useRemoteNodesStore.getState().activeNodeId === 'local' &&
    useAppModeStore.getState().mode === 'bot'
  );
}

export function useBotModeActive(): boolean {
  const enabled = useSettingsStore((s) => s.botModeEnabled);
  const local = useRemoteNodesStore((s) => s.activeNodeId === 'local');
  const mode = useAppModeStore((s) => s.mode);
  return enabled && local && mode === 'bot';
}

/** 系统通知点击：切回本机 Bot 模式并打开对应聊天（委派子会话归到委派所属聊天，找不到则收件箱） */
export async function openBotNotification(event: BotEvent): Promise<void> {
  if (!useSettingsStore.getState().botModeEnabled) return;
  const chatId = typeof event.chatId === 'string' ? event.chatId : undefined;
  const conversationId =
    typeof event.conversationId === 'string' ? event.conversationId : undefined;
  const bots = useBotsStore.getState();
  if (!chatId) await bots.refreshDelegations();
  if (useRemoteNodesStore.getState().activeNodeId !== 'local')
    useRemoteNodesStore.getState().switchNode('local');
  useAppModeStore.getState().setMode('bot');
  bots.setView(openTarget({ chatId, conversationId }, useBotsStore.getState().delegations));
}
