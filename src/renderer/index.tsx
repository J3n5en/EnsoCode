import * as React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { DiffWorkerPool } from './components/chat/DiffWorkerPool';
import { syncOverlayGuard } from './lib/overlayGuard';
import { useBotsStore } from './stores/bots';
import { useRemoteNodesStore } from './stores/remoteNodes';
import { useSessionsStore } from './stores/sessions';
import { useSettingsStore } from './stores/settings';
import { useSidePanelStore } from './stores/sidePanel';
import './styles/globals.css';

// dev-only:e2e/调试可经 CDP 直达 store
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__stores = {
    sessions: useSessionsStore,
    settings: useSettingsStore,
    sidePanel: useSidePanelStore,
    remoteNodes: useRemoteNodesStore,
    bots: useBotsStore,
  };
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
