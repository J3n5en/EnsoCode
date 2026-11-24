import type { SettingsDeepLink } from '@shared/settingsDeepLink';
import { X } from 'lucide-react';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { TitleBar } from '@/components/app/TitleBar';
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
import { PluginNotices } from '@/plugins/PluginNotices';
import './styles/globals.css';

installThemeStyles();
installScrollbarActivity();

/** 独立设置窗口（PR4 删除）：挂载先拉取暂存的深链，之后收推送 */
function useStandaloneDeepLink(): { link: SettingsDeepLink | null; linkSeq: number } {
  const [state, setState] = React.useState({ link: null as SettingsDeepLink | null, linkSeq: 0 });
  React.useEffect(() => {
    const apply = (link: SettingsDeepLink | null) => {
      if (link) setState((prev) => ({ link, linkSeq: prev.linkSeq + 1 }));
    };
    void window.electronAPI.window.consumeSettingsDeepLink().then(apply);
    return window.electronAPI.window.onSettingsDeepLink(apply);
  }, []);
  return state;
}

function SettingsApp() {
  const { t } = useI18n();
  const chromeKind = useWindowChromeKind();
  const { link, linkSeq } = useStandaloneDeepLink();

  // 远程浏览器里设置是叠加层，需要整行 TitleBar 上的关闭按钮
  if (chromeKind !== 'mobile' && chromeKind !== 'web') {
    return (
      <div data-enso="canvas" className="flex h-screen overflow-hidden bg-canvas">
        <OauthCredentialBootstrap />
        <ShellChromeContext.Provider
          value={{ trailing: <WindowControls kind={chromeKind} edgeGap={8} /> }}
        >
          <SettingsContent link={link} linkSeq={linkSeq} />
        </ShellChromeContext.Provider>
        <ToastProvider />
        <PluginNotices />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <OauthCredentialBootstrap />
      <TitleBar
        title={t('Settings')}
        actions={
          // 远程浏览器里设置是叠加层，没有系统关闭按钮
          window.electronAPI.remote && (
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
              onClick={() => void window.electronAPI.window.close()}
              aria-label={t('Close')}
              title={t('Close')}
            >
              <X className="h-4 w-4" />
            </button>
          )
        }
      />
      <main className="min-h-0 flex-1 overflow-hidden">
        <SettingsContent link={link} linkSeq={linkSeq} />
      </main>
      <ToastProvider />
      <PluginNotices />
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>
);
