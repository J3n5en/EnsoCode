import {
  nextPendingReminder,
  type PendingReminderView,
  type SessionReminderSummary,
} from '@shared/reminders';
import { useEffect, useState } from 'react';
import { create } from 'zustand';

const TICK_MS = 30_000;

interface SessionRemindersState {
  /** 根会话 id → 提醒摘要列表；启动全量拉取与增量变更推送均按会话整体替换 */
  byConversation: Record<string, SessionReminderSummary[]>;
  replace: (conversationId: string, reminders: SessionReminderSummary[]) => void;
  replaceAll: (all: Record<string, SessionReminderSummary[]>) => void;
}

export const useSessionRemindersStore = create<SessionRemindersState>((set) => ({
  byConversation: {},
  replace: (conversationId, reminders) =>
    set((state) => {
      const byConversation = { ...state.byConversation };
      if (reminders.length > 0) byConversation[conversationId] = reminders;
      else if (byConversation[conversationId]) delete byConversation[conversationId];
      else return state;
      return { byConversation };
    }),
  replaceAll: (all) => {
    const byConversation: Record<string, SessionReminderSummary[]> = {};
    for (const [id, list] of Object.entries(all)) {
      if (Array.isArray(list) && list.length > 0) byConversation[id] = list;
    }
    set({ byConversation });
  },
}));

/** 订阅单个会话的下一条未到点提醒；只在有提醒时启 30s 刷新定时器以更新剩余时间与过期退出 */
export function usePendingReminder(
  conversationId: string | undefined,
  enabled = true
): { reminder: PendingReminderView | undefined; now: number } {
  const list = useSessionRemindersStore((state) =>
    enabled && conversationId ? state.byConversation[conversationId] : undefined
  );
  const [, setTick] = useState(0);
  const hasItems = Boolean(list && list.length > 0);
  useEffect(() => {
    if (!hasItems) return;
    const timer = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [hasItems]);
  const now = Date.now();
  if (!enabled || !list || list.length === 0) return { reminder: undefined, now };
  return { reminder: nextPendingReminder(list, now), now };
}
