import { create } from 'zustand';
import { useSecretaryStore } from './secretary';
import { useSessionsStore } from './sessions';

/** 「后台任务」总览：占主区，切到任意会话时关闭 */
interface BackgroundTasksViewState {
  open: boolean;
  idleOnly: boolean;
}

export const useBackgroundTasksView = create<BackgroundTasksViewState>(() => ({
  open: false,
  idleOnly: false,
}));

export function openBackgroundTasks(idleOnly = false): void {
  useSecretaryStore.getState().closeWelcome();
  useBackgroundTasksView.setState({ open: true, idleOnly });
}

export function closeBackgroundTasks(): void {
  if (useBackgroundTasksView.getState().open) useBackgroundTasksView.setState({ open: false });
}

useSessionsStore.subscribe((state, previous) => {
  if (state.activeId !== previous.activeId) closeBackgroundTasks();
});
