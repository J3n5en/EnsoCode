import { RotateCcw } from 'lucide-react';
import * as React from 'react';
import { Kbd } from '@/components/ui/kbd';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
        <Select value={language} onValueChange={(v) => setLanguage(v as 'en' | 'zh')}>
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
    </div>
  );
}

const ACTION_LABEL_KEYS: Record<KeybindingAction, string> = {
  'toggle-sidebar': 'Toggle sidebar',
  'open-settings': 'Open settings',
  'new-conversation': 'New conversation',
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
