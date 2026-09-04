import { RotateCcw } from 'lucide-react';
import * as React from 'react';
import { Kbd } from '@/components/ui/kbd';
import { useI18n } from '@/i18n';
import {
  ACTION_HINT_KEYS,
  ACTION_LABEL_KEYS,
  DEFAULT_KEYBINDINGS,
  effectiveKeybindings,
  eventToBinding,
  formatBinding,
  KEYBINDING_ACTIONS,
  type KeybindingAction,
} from '@/lib/keybindings';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';

export function KeybindingsSettings() {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <div data-settings-row="shortcuts.root">
        <h3 className="text-lg font-medium">{t('Shortcuts')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('Click a shortcut to rebind it; press Esc to cancel.')}
        </p>
      </div>
      <KeybindingsSection />
    </div>
  );
}

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
    <div className="divide-y rounded-md border">
      {KEYBINDING_ACTIONS.map((action) => {
        const isCapturing = capturing === action;
        const isCustom = keybindings[action] !== undefined;
        return (
          <div key={action} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm">{t(ACTION_LABEL_KEYS[action])}</p>
              {ACTION_HINT_KEYS[action] && (
                <p className="text-muted-foreground text-xs">{t(ACTION_HINT_KEYS[action])}</p>
              )}
            </div>
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
  );
}
