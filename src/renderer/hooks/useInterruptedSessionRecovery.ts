import { useEffect } from 'react';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { isLeaderRenderer } from '@/lib/rendererRole';
import { useOauthCredentialStore } from '@/stores/oauthCredentials';
import { useSessionsStore } from '@/stores/sessions';
import { interruptedStateOf, shouldMarkInterrupted } from '@/stores/sessions/interrupted';
import { useSettingsStore } from '@/stores/settings';

const READY_TIMEOUT_MS = 30_000;

function waitUntil(check: () => boolean, timeoutMs = READY_TIMEOUT_MS): Promise<boolean> {
  if (check()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer);
      for (const unsub of unsubs) unsub();
      resolve(value);
    };
    const onChange = () => check() && finish(true);
    const unsubs = [
      useSessionsStore.subscribe(onChange),
      useOauthCredentialStore.subscribe(onChange),
      useSettingsStore.subscribe(onChange),
    ];
    const timer = setTimeout(() => finish(check()), timeoutMs);
  });
}

function hydrated(): boolean {
  const credentials = useOauthCredentialStore.getState().snapshot.availability.status;
  return (
    useSessionsStore.persist.hasHydrated() &&
    useSettingsStore.persist.hasHydrated() &&
    credentials !== 'unloaded' &&
    credentials !== 'loading'
  );
}

/**
 * 主窗启动时取走上次应用退出（含安装脚本 pkill）打断的回合，把会话标成 interrupted。
 * 不自动重试：先让用户看到原因，重试按钮就在提示行右侧。
 */
export function useRecoverInterruptedTurns(): void {
  const { t } = useI18n();
  useEffect(() => {
    if (!isLeaderRenderer()) return;
    void (async () => {
      const turns = await window.electronAPI.agent.takeInterruptedTurns().catch(() => []);
      if (turns.length === 0 || !(await waitUntil(hydrated))) return;
      const marked = new Set<string>();
      for (const turn of turns) {
        if (!shouldMarkInterrupted(useSessionsStore.getState().conversations[turn.conversationId]))
          continue;
        marked.add(turn.conversationId);
        useSessionsStore.setState((state) => {
          const conversation = state.conversations[turn.conversationId];
          if (!conversation || conversation.status === 'running') return state;
          return {
            conversations: {
              ...state.conversations,
              [turn.conversationId]: {
                ...conversation,
                status: 'interrupted',
                interrupted: interruptedStateOf(turn),
                error: undefined,
              },
            },
          };
        });
      }
      if (marked.size === 0) return;
      addToast({
        type: 'info',
        title: t('{{count}} conversation(s) interrupted by app exit', { count: marked.size }),
      });
    })();
  }, [t]);
}
