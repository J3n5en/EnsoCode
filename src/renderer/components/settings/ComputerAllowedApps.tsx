import type { ComputerAllowedApp } from '@shared/computer/types';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';

function appKey(app: ComputerAllowedApp): string {
  return app.bundleId || app.path;
}

/** computer 的「始终允许」名单；首次操作某个 app 时由系统弹窗询问，这里只查看与撤销 */
export function ComputerAllowedApps() {
  const { t } = useI18n();
  const [apps, setApps] = useState<ComputerAllowedApp[] | null>(null);

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
    <div className="space-y-2" data-settings-row="tools.computerApps">
      <p className="font-medium text-sm">{t('Apps the AI may control')}</p>
      <p className="text-muted-foreground text-xs">
        {t(
          'The first time the AI clicks or types in an app, EnsoCode asks you. Apps you always allow are listed here; it can then read everything in their windows.'
        )}
      </p>
      {apps && apps.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('No apps are always allowed yet.')}</p>
      ) : null}
      {apps && apps.length > 0 ? (
        <ul className="divide-y rounded-md border">
          {apps.map((app) => (
            <li key={appKey(app)} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm">{app.name}</p>
                <p className="truncate text-muted-foreground text-xs" title={app.path}>
                  {app.bundleId || app.path}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => void revoke(app)}>
                {t('Revoke')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
