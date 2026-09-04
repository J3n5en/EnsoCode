import { isValidProxyUrl, type ProxyMode } from '@shared/proxy';
import type { UpdateStatus } from '@shared/types/updater';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { GENERATION_STALL_TIMEOUT_MINUTES } from '@/stores/sessions/stallTimeout';
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

      <div
        className="grid grid-cols-[140px_1fr] items-center gap-4"
        data-settings-row="general.language"
      >
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
      <ProxySection />
      <UpdateSection />
    </div>
  );
}

function SidePanelSection() {
  const { t } = useI18n();
  const openChangesOnFileEdit = useSettingsStore((s) => s.openChangesOnFileEdit);
  const setOpenChangesOnFileEdit = useSettingsStore((s) => s.setOpenChangesOnFileEdit);
  const compactReadOnlyTools = useSettingsStore((s) => s.compactReadOnlyTools);
  const setCompactReadOnlyTools = useSettingsStore((s) => s.setCompactReadOnlyTools);
  const generationStallTimeoutMin = useSettingsStore((s) => s.generationStallTimeoutMin);
  const setGenerationStallTimeoutMin = useSettingsStore((s) => s.setGenerationStallTimeoutMin);
  return (
    <div className="space-y-2">
      <SwitchRow
        rowId="general.openChangesOnFileEdit"
        title={t('Open Changes when files are edited')}
        description={t(
          'Automatically show the side panel Changes tab after the agent edits a file'
        )}
        checked={openChangesOnFileEdit}
        onChange={setOpenChangesOnFileEdit}
      />
      <SwitchRow
        rowId="general.compactReadOnlyTools"
        title={t('Compact read-only tool calls')}
        description={t(
          'Show read/grep/find/ls as one-line rows and fold consecutive tool calls while the agent is still running'
        )}
        checked={compactReadOnlyTools}
        onChange={setCompactReadOnlyTools}
      />
      <div
        className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
        data-settings-row="general.generationStallTimeout"
      >
        <div className="min-w-0">
          <p className="text-sm">{t('Stop if no output')}</p>
          <p className="text-xs text-muted-foreground">
            {t(
              'Abort and retry the run when no tokens or tool results arrive for this long. Thinking counts as output.'
            )}
          </p>
        </div>
        <Select
          items={Object.fromEntries(
            GENERATION_STALL_TIMEOUT_MINUTES.map((value) => [
              String(value),
              value === 0 ? t('Never') : t('{{count}} min', { count: value }),
            ])
          )}
          value={String(generationStallTimeoutMin)}
          onValueChange={(value) => setGenerationStallTimeoutMin(Number(value))}
        >
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {GENERATION_STALL_TIMEOUT_MINUTES.map((value) => (
              <SelectItem key={value} value={String(value)}>
                {value === 0 ? t('Never') : t('{{count}} min', { count: value })}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    </div>
  );
}

function SwitchRow({
  title,
  description,
  checked,
  onChange,
  rowId,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  rowId?: string;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
      data-settings-row={rowId}
    >
      <div className="min-w-0">
        <p className="text-sm">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={(value) => onChange(value === true)} />
    </div>
  );
}

function applyProxy(mode: ProxyMode, customUrl: string): void {
  void window.electronAPI.proxy.apply({ mode, customUrl });
}

function ProxySection() {
  const { t } = useI18n();
  const proxyMode = useSettingsStore((s) => s.proxyMode);
  const customProxyUrl = useSettingsStore((s) => s.customProxyUrl);
  const setProxyMode = useSettingsStore((s) => s.setProxyMode);
  const setCustomProxyUrl = useSettingsStore((s) => s.setCustomProxyUrl);
  const [draft, setDraft] = React.useState(customProxyUrl);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setDraft(customProxyUrl);
  }, [customProxyUrl]);

  const changeMode = (mode: ProxyMode) => {
    setProxyMode(mode);
    applyProxy(mode, customProxyUrl);
  };

  const commitUrl = () => {
    const next = draft.trim();
    if (next && !isValidProxyUrl(next)) {
      setError(t('Enter an http(s) proxy URL'));
      return;
    }
    setError(null);
    setCustomProxyUrl(next);
    applyProxy(proxyMode, next);
  };

  return (
    <div className="space-y-3" data-settings-row="general.proxy">
      <div>
        <h4 className="text-sm font-medium">{t('Network proxy')}</h4>
        <p className="text-xs text-muted-foreground">
          {t('Used by model requests, the built-in browser, and agent tools')}
        </p>
      </div>
      <div className="grid grid-cols-[140px_1fr] items-center gap-4">
        <span className="text-sm font-medium">{t('Proxy mode')}</span>
        <Select
          items={{
            system: t('Follow system proxy'),
            none: t('No proxy'),
            custom: t('Custom proxy'),
          }}
          value={proxyMode}
          onValueChange={(value) => changeMode(value as ProxyMode)}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="system">{t('Follow system proxy')}</SelectItem>
            <SelectItem value="none">{t('No proxy')}</SelectItem>
            <SelectItem value="custom">{t('Custom proxy')}</SelectItem>
          </SelectPopup>
        </Select>
      </div>
      {proxyMode === 'custom' && (
        <div className="grid grid-cols-[140px_1fr] items-start gap-4">
          <span className="pt-1.5 text-sm font-medium">{t('Proxy URL')}</span>
          <div className="min-w-0 space-y-1">
            <Input
              value={draft}
              placeholder="http://127.0.0.1:7890"
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitUrl}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitUrl();
              }}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </div>
      )}
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
    <div className="space-y-3" data-settings-row="general.updates">
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
