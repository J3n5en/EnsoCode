import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { closeSettings, openSettings, useAppViewStore } from '@/stores/appView';
import App from './App';
import { useRestartOverlayStore } from './components/app/RestartWaitDialog';
import { DiffWorkerPool } from './components/chat/DiffWorkerPool';
import { syncOverlayGuard } from './lib/overlayGuard';
import { installScrollbarActivity } from './lib/scrollbars';
import { installThemeStateAttributes } from './lib/themeStateAttributes';
import { installThemeStyles } from './lib/themeStyles';
import { setPluginViews } from './plugins/viewBridge';
import { useBotsStore } from './stores/bots';
import { useRemoteNodesStore } from './stores/remoteNodes';
import { useSecretaryStore } from './stores/secretary';
import { useSessionRemindersStore } from './stores/sessionReminders';
import { useSessionsStore } from './stores/sessions';
import { useSettingsStore } from './stores/settings';
import { useSidePanelStore } from './stores/sidePanel';
import './styles/globals.css';

installThemeStyles();
installThemeStateAttributes();
installScrollbarActivity();

// dev-only:e2e/调试可经 CDP 直达 store；性能基准用 VITE_ENSO_EXPOSE_STORES=1 构建的生产包同样暴露
if (import.meta.env.DEV || import.meta.env.VITE_ENSO_EXPOSE_STORES === '1') {
  (window as unknown as Record<string, unknown>).__stores = {
    sessions: useSessionsStore,
    settings: useSettingsStore,
    sidePanel: useSidePanelStore,
    remoteNodes: useRemoteNodesStore,
    bots: useBotsStore,
    restartOverlay: useRestartOverlayStore,
    secretary: useSecretaryStore,
    sessionReminders: useSessionRemindersStore,
    appView: useAppViewStore,
    settingsView: { open: openSettings, close: closeSettings },
  };
  // dev-only:CDP 验证脚本注入假插件视图（长菜单复现用）
  (window as unknown as Record<string, unknown>).__setPluginViews = setPluginViews;
}

// 新一代 renderer 起步即全量重推，清掉主进程里上一代留下的浮层闩锁
syncOverlayGuard();

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <DiffWorkerPool>
      <App />
    </DiffWorkerPool>
  </React.StrictMode>
);
