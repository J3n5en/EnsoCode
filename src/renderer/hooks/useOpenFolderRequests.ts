import { useEffect } from 'react';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { isLeaderRenderer } from '@/lib/rendererRole';
import { showLocalCodeView } from '@/stores/bots/mode';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

const READY_TIMEOUT_MS = 30_000;

let openFolderChain: Promise<void> = Promise.resolve();

function waitUntil(check: () => boolean, timeoutMs = READY_TIMEOUT_MS): Promise<boolean> {
  if (check()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer);
      for (const unsub of unsubs) unsub();
      resolve(value);
    };
    const onChange = () => check() && finish(true);
    const unsubs = [useSessionsStore.subscribe(onChange), useSettingsStore.subscribe(onChange)];
    const timer = setTimeout(() => finish(check()), timeoutMs);
  });
}

function hydrated(): boolean {
  return useSessionsStore.persist.hasHydrated() && useSettingsStore.persist.hasHydrated();
}

export function useOpenFolderRequests(): void {
  const { t } = useI18n();
  useEffect(() => {
    if (!isLeaderRenderer()) return;
    const drain = (): void => {
      openFolderChain = openFolderChain
        .then(async () => {
          if (!(await waitUntil(hydrated))) return;
          const folders = await window.electronAPI.window.takeOpenFolders().catch(() => []);
          for (const folder of folders) {
            try {
              const project = await useSettingsStore.getState().addProject(folder);
              if (!project) {
                addToast({ type: 'error', title: t('Failed to add project') });
                continue;
              }
              const id = await useSessionsStore.getState().newConversation(project.id);
              if (!id) {
                addToast({ type: 'error', title: t('Failed to add project') });
                continue;
              }
              showLocalCodeView();
            } catch (error) {
              addToast({
                type: 'error',
                title: t('Failed to add project'),
                description: error instanceof Error ? error.message : String(error),
              });
            }
          }
        })
        .catch(() => undefined);
    };
    const unsubscribe = window.electronAPI.window.onOpenFolderRequested(drain);
    drain();
    return unsubscribe;
  }, [t]);
}
