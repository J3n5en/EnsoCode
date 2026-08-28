import type { UpdateStatus } from '@shared/types/updater';
import { RotateCcw } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import {
  DEFAULT_KEYBINDINGS,
  effectiveKeybindings,
  eventToBinding,
  formatBinding,
  KEYBINDING_ACTIONS,
  type KeybindingAction,
} from '@/lib/keybindings';
import { cn } from '@/lib/utils';
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

      <KeybindingsSection />
      <UpdateSection />
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

const ACTION_LABEL_KEYS: Record<KeybindingAction, string> = {
  'toggle-sidebar': 'Toggle sidebar',
  'open-settings': 'Open settings',
  'new-conversation': 'New conversation',
  'next-tab': 'Next coworker tab',
  'prev-tab': 'Previous coworker tab',
};

/** 快捷键改绑:点击当前键位进入录制,按下新组合保存;Esc 取消;与其它动作冲突时拒绝并提示 */
function KeybindingsSection() {
  const { t } = useI18n();
  const keybindings = useSettingsStore((s) => s.keybindings);
  const setKeybinding = useSettingsStore((s) => s.setKeybinding);
  const resetKeybinding = useSettingsStore((s) => s.resetKeybinding);
  const [capturing, setCapturing] = React.useState<KeybindingAction | null>(null);
  const [conflictWith, setConflictWith] = React.useState<KeybindingAction | null>(null);
  const bindings = effectiveKeybindings(keybindings);

  const capture = (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!capturing) return;
    if (e.key === 'Escape') {
      setCapturing(null);
      setConflictWith(null);
      return;
    }
    const binding = eventToBinding(e);
    if (!binding) return;
    const taken = KEYBINDING_ACTIONS.find(
      (action) => action !== capturing && bindings[action] === binding
    );
    if (taken) {
      setConflictWith(taken);
      return;
    }
    if (binding === DEFAULT_KEYBINDINGS[capturing]) resetKeybinding(capturing);
    else setKeybinding(capturing, binding);
    setCapturing(null);
    setConflictWith(null);
  };

  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-medium">{t('Shortcuts')}</h4>
        <p className="text-xs text-muted-foreground">
          {t('Click a shortcut to rebind it; press Esc to cancel.')}
        </p>
      </div>
      <div className="divide-y rounded-md border">
        {KEYBINDING_ACTIONS.map((action) => {
          const isCapturing = capturing === action;
          const isCustom = keybindings[action] !== undefined;
          return (
            <div key={action} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1 text-sm">{t(ACTION_LABEL_KEYS[action])}</span>
              {isCapturing && conflictWith && (
                <span className="text-xs text-destructive">
                  {t('Already used by "{{label}}"', { label: t(ACTION_LABEL_KEYS[conflictWith]) })}
                </span>
              )}
              {isCustom && !isCapturing && (
                <button
                  type="button"
                  title={t('Reset to default')}
                  onClick={() => resetKeybinding(action)}
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setCapturing(action);
                  setConflictWith(null);
                }}
                onKeyDown={isCapturing ? capture : undefined}
                onBlur={() => {
                  if (isCapturing) {
                    setCapturing(null);
                    setConflictWith(null);
                  }
                }}
                // biome-ignore lint/a11y/noAutofocus: 进入录制态即聚焦以捕获按键是预期交互
                autoFocus={isCapturing}
                className={cn(
                  'rounded-md px-1 py-0.5 transition-colors',
                  isCapturing ? 'ring-1 ring-ring' : 'hover:bg-muted'
                )}
              >
                {isCapturing ? (
                  <span className="text-xs text-muted-foreground">{t('Press shortcut…')}</span>
                ) : (
                  <Kbd>{formatBinding(bindings[action])}</Kbd>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
