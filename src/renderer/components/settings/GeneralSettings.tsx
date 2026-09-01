import type { UpdateStatus } from '@shared/types/updater';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';

export function GeneralSettings() {
  const { language, setLanguage } = useSettingsStore();
  const { t } = useI18n();

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">{t('General')}</h3>
        <p className="text-sm text-muted-foreground">{t('General application settings')}</p>
      </div>

      <div className="grid grid-cols-[140px_1fr] items-center gap-4">
        <span className="text-sm font-medium">{t('Language')}</span>
        <Select
          items={{ en: 'English', zh: '简体中文' }}
          value={language}
          onValueChange={(v) => setLanguage(v as 'en' | 'zh')}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="en">English</SelectItem>
            <SelectItem value="zh">简体中文</SelectItem>
          </SelectPopup>
        </Select>
      </div>

      <SidePanelSection />
      <UpdateSection />
    </div>
  );
}

function SidePanelSection() {
  const { t } = useI18n();
  const openChangesOnFileEdit = useSettingsStore((s) => s.openChangesOnFileEdit);
  const setOpenChangesOnFileEdit = useSettingsStore((s) => s.setOpenChangesOnFileEdit);
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-sm">{t('Open Changes when files are edited')}</p>
        <p className="text-xs text-muted-foreground">
          {t('Automatically show the side panel Changes tab after the agent edits a file')}
        </p>
      </div>
      <Switch
        checked={openChangesOnFileEdit}
        onCheckedChange={(checked) => setOpenChangesOnFileEdit(checked === true)}
      />
    </div>
  );
}

/** 更新小节:当前版本 + 检查按钮 + 状态/进度 + 自动下载开关 */
function UpdateSection() {
  const { t } = useI18n();
  const autoUpdate = useSettingsStore((s) => s.autoUpdate);
  const setAutoUpdate = useSettingsStore((s) => s.setAutoUpdate);
  const [status, setStatus] = React.useState<UpdateStatus | null>(null);

  React.useEffect(() => {
    return window.electronAPI.updater.onStatus(setStatus);
  }, []);

  const statusText = (): string | null => {
    if (!status) return null;
    switch (status.status) {
      case 'checking':
        return t('Checking for updates…');
      case 'available':
        return t('New version {{version}} found', { version: status.info?.version ?? '' });
      case 'not-available':
        return t('You are on the latest version');
      case 'downloading':
        return t('Downloading update… {{percent}}%', {
          percent: Math.round(status.progress?.percent ?? 0),
        });
      case 'downloaded':
        return t('New version {{version}} is ready — restart to update.', {
          version: status.info?.version ?? '',
        });
      case 'error':
        return t('Update check failed');
      default:
        return null;
    }
  };
  const text = statusText();
  const busy = status?.status === 'checking' || status?.status === 'downloading';

  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-medium">{t('Updates')}</h4>
        <p className="text-xs text-muted-foreground">{t('Application update settings')}</p>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-sm">
            {t('Current version')} · {APP_VERSION}
          </p>
          {text && <p className="mt-0.5 truncate text-xs text-muted-foreground">{text}</p>}
        </div>
        {status?.status === 'downloaded' ? (
          <Button
            size="sm"
            onClick={() => void window.electronAPI.updater.quitAndInstall()}
            className="shrink-0"
          >
            {t('Restart to update')}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void window.electronAPI.updater.checkForUpdates()}
            className="shrink-0"
          >
            {t('Check for updates')}
          </Button>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-sm">{t('Automatic updates')}</p>
          <p className="text-xs text-muted-foreground">
            {t('Download and install updates automatically')}
          </p>
        </div>
        <Switch
          checked={autoUpdate}
          onCheckedChange={(checked) => {
            setAutoUpdate(checked);
            void window.electronAPI.updater.setAutoUpdateEnabled(checked);
          }}
        />
      </div>
    </div>
  );
}

/** 打包时由 vite 注入的 app 版本(见 electron.vite.config.ts define);dev 下取 package.json */
const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? 'dev';
