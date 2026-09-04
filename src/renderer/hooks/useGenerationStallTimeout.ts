import { useEffect } from 'react';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { useSessionsStore } from '@/stores/sessions';
import { nextStallWatchAction, shouldAbortStalledGeneration } from '@/stores/sessions/stallTimeout';
import { useSettingsStore } from '@/stores/settings';

export function useGenerationStallTimeout(): void {
  const minutes = useSettingsStore((state) => state.generationStallTimeoutMin);
  const { t } = useI18n();
  useEffect(() => {
    if (minutes <= 0) return;
    const aborting = new Set<string>();
    const pendingRetry = new Set<string>();
    const attempts = new Map<string, number>();
    const timer = setInterval(() => {
      const timeoutMs = minutes * 60_000;
      const now = Date.now();
      const sessions = useSessionsStore.getState();
      for (const conversation of Object.values(sessions.conversations)) {
        if (conversation.status === 'running' && conversation.lastOutputAt) {
          attempts.delete(conversation.id);
        }
        const action = nextStallWatchAction({
          shouldAbort: shouldAbortStalledGeneration({
            status: conversation.status,
            spawning: conversation.spawning,
            lastOutputAt: conversation.lastOutputAt,
            runStartedAt: conversation.runStartedAt,
            now,
            timeoutMs,
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
          addToast({
            type: 'warning',
            title: t('No output for {{minutes}} minutes — retrying', { minutes }),
          });
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
          addToast({
            type: 'warning',
            title: t('Stopped after repeated stalls'),
          });
        }
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [minutes, t]);
}
