import { appActivityState, sessionThemeState } from '@shared/theme/themeState';
import { useSessionsStore } from '@/stores/sessions';

type Snapshot = ReturnType<typeof useSessionsStore.getState>;

function write({ conversations, activeId }: Snapshot): void {
  const root = document.documentElement.dataset;
  const activity = appActivityState(conversations);
  const session = sessionThemeState(activeId ? conversations[activeId] : undefined, conversations);
  if (root.ensoActivity !== activity) root.ensoActivity = activity;
  if (root.ensoSession !== session) root.ensoSession = session;
}

/** 主窗口把全局与当前会话状态写到 `<html>`，主题 CSS 据此切换样式 */
export function installThemeStateAttributes(): void {
  write(useSessionsStore.getState());
  useSessionsStore.subscribe((state, prev) => {
    if (state.conversations !== prev.conversations || state.activeId !== prev.activeId)
      write(state);
  });
}
