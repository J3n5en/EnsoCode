import {
  hasLiveGenerationWork,
  nextStallWatchAction,
  shiftHeartbeatsAfterResume,
  shouldAbortStalledGeneration,
  stallHeartbeatAt,
  stallLiveWorkFlags,
} from '@shared/stallTimeout';
import { useEffect, useRef } from 'react';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { isLeaderRenderer } from '@/lib/rendererRole';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

export function useGenerationStallTimeout(): void {
  const minutes = useSettingsStore((state) => state.generationStallTimeoutMin);
  const { t } = useI18n();
  const resumeSubscribed = useRef(false);
  useEffect(() => {
    if (!resumeSubscribed.current) {
      resumeSubscribed.current = true;
      window.electronAPI.app.onSystemResumed(() => {
        resetGenerationHeartbeatsAfterResume();
      });
    }
    if (minutes <= 0) return;
    const aborting = new Set<string>();
    const pendingRetry = new Set<string>();
    const attempts = new Map<string, number>();
    const timer = setInterval(() => {
      if (!isLeaderRenderer()) return;
      const timeoutMs = minutes * 60_000;
      const now = Date.now();
      const sessions = useSessionsStore.getState();
      for (const conversation of Object.values(sessions.conversations)) {
        if (conversation.status === 'running' && conversation.lastOutputAt) {
          attempts.delete(conversation.id);
        }
        const spawningCoworker = (conversation.coworkerIds ?? []).some((id) => {
          const child = sessions.conversations[id];
          return Boolean(child?.spawning);
        });
        const action = nextStallWatchAction({
          shouldAbort: shouldAbortStalledGeneration({
            status: conversation.status,
            spawning: conversation.spawning,
            lastOutputAt: stallHeartbeatAt(conversation, sessions.conversations),
            now,
            timeoutMs,
            hasLiveWork: hasLiveGenerationWork({
              ...stallLiveWorkFlags(conversation),
              spawningCoworker,
            }),
          }),
          status: conversation.status,
          spawning: conversation.spawning,
          pendingRetry: pendingRetry.has(conversation.id),
          attempts: attempts.get(conversation.id) ?? 0,
        });
        if (action === 'abort') {
          if (aborting.has(conversation.id)) continue;
          aborting.add(conversation.id);
          pendingRetry.add(conversation.id);
          void window.electronAPI.agent.abort(conversation.id).finally(() => {
            aborting.delete(conversation.id);
          });
          addToast(
            stallWarningToast(
              conversation,
              t('No output for {{minutes}} minutes — retrying', { minutes })
            )
          );
          continue;
        }
        if (action === 'retry') {
          pendingRetry.delete(conversation.id);
          attempts.set(conversation.id, (attempts.get(conversation.id) ?? 0) + 1);
          sessions.retry(conversation.id);
          continue;
        }
        if (action === 'give-up') {
          pendingRetry.delete(conversation.id);
          attempts.delete(conversation.id);
          addToast(stallWarningToast(conversation, t('Stopped after repeated stalls')));
        }
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [minutes, t]);
}

function stallWarningToast(
  conversation: { title: string; coworkerName?: string },
  message: string
) {
  const sessionTitle = (conversation.coworkerName || conversation.title).split('\n')[0].trim();
  return sessionTitle
    ? { type: 'warning' as const, title: sessionTitle, description: message }
    : { type: 'warning' as const, title: message };
}

/** 唤醒重置：运行中会话的 lastOutputAt 平推到唤醒时刻，重新计一个完整超时窗口 */
function resetGenerationHeartbeatsAfterResume(): void {
  const now = Date.now();
  useSessionsStore.setState((state) => {
    const shifted = shiftHeartbeatsAfterResume(state.conversations, now);
    if (Object.keys(shifted).length === 0) return state;
    const conversations = { ...state.conversations };
    for (const [id, heartbeat] of Object.entries(shifted)) {
      const current = conversations[id];
      if (!current) continue;
      conversations[id] = { ...current, ...heartbeat };
    }
    return { ...state, conversations };
  });
}
