import { useEffect } from 'react';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { isLeaderRenderer } from '@/lib/rendererRole';
import { resumeInterruptedSessions } from '@/lib/resumeInterrupted';
import { useOauthCredentialStore } from '@/stores/oauthCredentials';
import { useSessionsStore } from '@/stores/sessions';
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

/** 主窗启动时取走上次更新重启打断的会话，从断点续跑 */
export function useResumeInterruptedByUpdate(): void {
  const { t } = useI18n();
  useEffect(() => {
    if (!isLeaderRenderer()) return;
    void (async () => {
      const ids = await window.electronAPI.updater.takeInterruptedSessions().catch(() => []);
      if (ids.length === 0 || !(await waitUntil(hydrated))) return;
      const sessions = useSessionsStore.getState;
      const resumed = await resumeInterruptedSessions(ids, {
        conversation: (id) => sessions().conversations[id],
        resume: (id) => sessions().resumeConversation(id),
        retry: (id) => window.electronAPI.agent.retry(id, { unfinishedOnly: true }),
        waitUntil,
      });
      if (resumed.length === 0) return;
      addToast({
        type: 'info',
        title: t('Continued {{count}} conversation(s) interrupted by the update', {
          count: resumed.length,
        }),
      });
    })();
  }, [t]);
}
