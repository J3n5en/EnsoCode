import { X } from 'lucide-react';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { SummonEnsoButton, TitleBar } from '@/components/app/TitleBar';
import {
  ShellChromeContext,
  useWindowChromeKind,
  WindowControls,
} from '@/components/app/WindowChrome';
import { OauthCredentialBootstrap } from '@/components/oauth/OauthCredentialBootstrap';
import { SettingsContent } from '@/components/settings';
import { ToastProvider } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { installScrollbarActivity } from '@/lib/scrollbars';
import { installThemeStyles } from '@/lib/themeStyles';
import './styles/globals.css';

installThemeStyles();
installScrollbarActivity();

function SettingsApp() {
  const { t } = useI18n();
  const chromeKind = useWindowChromeKind();

  if (chromeKind !== 'mobile') {
    return (
      <div data-enso="canvas" className="flex h-screen overflow-hidden bg-canvas">
        <OauthCredentialBootstrap />
        <ShellChromeContext.Provider
          value={{
            trailing: (
              <>
                <SummonEnsoButton label={false} />
                <WindowControls kind={chromeKind} edgeGap={8} />
              </>
            ),
          }}
        >
          <SettingsContent />
        </ShellChromeContext.Provider>
        <ToastProvider />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <OauthCredentialBootstrap />
      <TitleBar
        title={t('Settings')}
        actions={
          <>
            <SummonEnsoButton label={false} />
            {/* 远程浏览器里设置是叠加层，没有系统关闭按钮 */}
            {window.electronAPI.remote && (
              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                onClick={() => void window.electronAPI.window.close()}
                aria-label={t('Close')}
                title={t('Close')}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </>
        }
      />
      <main className="min-h-0 flex-1 overflow-hidden">
        <SettingsContent />
      </main>
      <ToastProvider />
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>
);
