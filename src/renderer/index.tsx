import * as React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { useSessionsStore } from './stores/sessions';
import { useSettingsStore } from './stores/settings';
import './styles/globals.css';

// dev-only:e2e/调试可经 CDP 直达 store
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__stores = {
    sessions: useSessionsStore,
    settings: useSettingsStore,
  };
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
