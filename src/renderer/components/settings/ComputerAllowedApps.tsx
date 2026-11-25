import type { ComputerAllowedApp } from '@shared/computer/types';
import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { SettingsButton, SettingsSubRow, SettingsSwitch } from './kit';

function appKey(app: ComputerAllowedApp): string {
  return app.bundleId || app.path;
}

/** computer 的「始终允许」名单；首次操作某个 app 时由系统弹窗询问，这里只查看与撤销 */
export function ComputerAllowedApps() {
  const { t } = useI18n();
  const [apps, setApps] = useState<ComputerAllowedApp[] | null>(null);
  const allowAll = useSettingsStore((state) => state.computerAllowAllApps);
  const setAllowAll = useSettingsStore((state) => state.setComputerAllowAllApps);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.computer.allowedApps().then((list) => {
      if (!cancelled) setApps(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const revoke = async (app: ComputerAllowedApp) => {
    await window.electronAPI.computer.revokeApp(appKey(app));
    setApps(await window.electronAPI.computer.allowedApps());
  };

  return (
    <div data-settings-row="tools.computerApps">
      <div className="px-4 py-2.5 pl-10 max-sm:pr-3 max-sm:pl-7">
        <p className="font-medium text-[13px] leading-5">{t('Apps the AI may control')}</p>
        <p className="mt-px text-[12px] text-muted-foreground leading-[18px]">
          {t(
            'The first time the AI clicks or types in an app, EnsoCode asks you. Apps you always allow are listed here; it can then read everything in their windows.'
          )}
        </p>
      </div>
      <SettingsSubRow
        rowId="tools.allow-all-apps"
        label={t('Allow all apps')}
        description={t(
          'The AI can click, type and read in any app without asking. It can see everything in their windows, including chats and passwords.'
        )}
      >
        <SettingsSwitch checked={allowAll} onCheckedChange={setAllowAll} />
      </SettingsSubRow>
      {apps && apps.length === 0 ? (
        <p className="px-4 py-2.5 pl-10 text-muted-foreground text-xs max-sm:pr-3 max-sm:pl-7">
          {t('No apps are always allowed yet.')}
        </p>
      ) : null}
      {apps && apps.length > 0
        ? apps.map((app) => (
            <SettingsSubRow
              key={appKey(app)}
              label={<span className="block truncate">{app.name}</span>}
              description={
                <span className="block truncate" title={app.path}>
                  {app.bundleId || app.path}
                </span>
              }
            >
              <SettingsButton onClick={() => void revoke(app)}>{t('Revoke')}</SettingsButton>
            </SettingsSubRow>
          ))
        : null}
    </div>
  );
}
