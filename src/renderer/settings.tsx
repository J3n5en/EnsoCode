import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { TitleBar } from '@/components/app/TitleBar';
import { SettingsContent } from '@/components/settings';
import { useI18n } from '@/i18n';
import './styles/globals.css';

function SettingsApp() {
  const { t } = useI18n();

  return (
    <div className="flex h-screen flex-col">
      <TitleBar title={t('Settings')} />
      <main className="min-h-0 flex-1">
        <SettingsContent />
      </main>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>
);
