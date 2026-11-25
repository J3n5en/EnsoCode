import { RotateCcw, X } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { addToast } from '@/components/ui/toast';
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
import { type PluginCommandRef, pluginCommandRefs } from '@/plugins/commands';
import { resolvePluginKeybindings } from '@/plugins/keybindings';
import { useSettingsStore } from '@/stores/settings';
import { SettingsPage, SettingsRow, SettingsSection } from './kit';

const CAPTURE_BUTTON =
  'relative inline-flex h-(--settings-control-h) min-w-14 items-center justify-center rounded-md px-1.5 transition-colors';

function IconAction({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      title={title}
      onClick={onClick}
      className="text-muted-foreground hover:text-foreground pointer-coarse:size-[44px]"
    >
      {children}
    </Button>
  );
}

export function KeybindingsSettings() {
  const { t } = useI18n();
  return (
    <SettingsPage
      rowId="shortcuts.root"
      title={t('Shortcuts')}
      description={t('Click a shortcut to rebind it. Backspace removes it; Esc cancels.')}
    >
      <KeybindingsSection />
      <PluginKeybindingsSection />
    </SettingsPage>
  );
}

/** 直接拉插件列表，不依赖 PluginUiHost 是否已挂载 */
function usePluginCommandRefs(): PluginCommandRef[] {
  const [commands, setCommands] = React.useState<PluginCommandRef[]>([]);
  React.useEffect(() => {
    const api = window.electronAPI.extensionPlugins;
    let alive = true;
    const load = () =>
      void api.list().then((list) => alive && setCommands(pluginCommandRefs(list)));
    load();
    const off = api.onChanged(load);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return commands;
}

/** 插件命令快捷键：内置快捷键优先；默认键被占用时标出占用方，改键后生效 */
function PluginKeybindingsSection() {
  const { t } = useI18n();
  const commands = usePluginCommandRefs();
  const keybindings = useSettingsStore((s) => s.keybindings);
  const setKeybinding = useSettingsStore((s) => s.setKeybinding);
  const resetKeybinding = useSettingsStore((s) => s.resetKeybinding);
  const [capturing, setCapturing] = React.useState<string | null>(null);
  const [taken, setTaken] = React.useState<string | null>(null);
  if (commands.length === 0) return null;
  const builtin = effectiveKeybindings(keybindings);
  const { rows } = resolvePluginKeybindings(commands, keybindings, builtin);
  const labelOf = (action: string) =>
    rows.find((row) => row.action === action)?.command.title ??
    t(ACTION_LABEL_KEYS[action as KeybindingAction] ?? action);
  const stop = () => {
    setCapturing(null);
    setTaken(null);
  };

  const capture = (e: React.KeyboardEvent, action: string, declared?: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return stop();
    if (e.key === 'Backspace' || e.key === 'Delete') {
      setKeybinding(action, '');
      return stop();
    }
    const binding = eventToBinding(e);
    if (!binding) return;
    const owner =
      KEYBINDING_ACTIONS.find((a) => builtin[a] === binding) ??
      rows.find((row) => row.action !== action && !row.conflict && row.binding === binding)?.action;
    if (owner) return setTaken(owner);
    if (binding === declared) resetKeybinding(action);
    else setKeybinding(action, binding);
    stop();
  };

  return (
    <SettingsSection rowId="shortcuts.pluginCommands" title={t('Plugin commands')}>
      {rows.map(({ action, command, binding, custom, conflict }) => {
        const isCapturing = capturing === action;
        return (
          <SettingsRow
            key={action}
            label={command.title}
            description={
              <>
                {command.pluginName}
                {conflict && !isCapturing && (
                  <span className="ml-2 text-destructive-text">
                    {t('Already used by "{{label}}"', { label: labelOf(conflict) })}
                  </span>
                )}
              </>
            }
            status={
              isCapturing &&
              taken && (
                <span className="text-[12px] text-destructive-text">
                  {t('Already used by "{{label}}"', { label: labelOf(taken) })}
                </span>
              )
            }
          >
            {binding && !isCapturing && (
              <IconAction title={t('Remove shortcut')} onClick={() => setKeybinding(action, '')}>
                <X className="h-3.5 w-3.5" />
              </IconAction>
            )}
            {custom && !isCapturing && (
              <IconAction
                title={t('Reset to default')}
                onClick={() => {
                  resetKeybinding(action);
                  addToast({ type: 'info', title: t('Reset to defaults') });
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </IconAction>
            )}
            <button
              type="button"
              onClick={() => {
                setCapturing(action);
                setTaken(null);
              }}
              onKeyDown={isCapturing ? (e) => capture(e, action, command.key) : undefined}
              onBlur={() => isCapturing && stop()}
              // biome-ignore lint/a11y/noAutofocus: 进入录制态即聚焦以捕获按键是预期交互
              autoFocus={isCapturing}
              className={cn(
                CAPTURE_BUTTON,
                isCapturing ? 'ring-1 ring-ring' : 'hover:bg-muted',
                conflict && !isCapturing && 'opacity-50 line-through'
              )}
            >
              {isCapturing ? (
                <span className="text-muted-foreground text-xs">{t('Press shortcut…')}</span>
              ) : binding ? (
                <Kbd>{formatBinding(binding)}</Kbd>
              ) : (
                <span className="text-muted-foreground text-xs">{t('No shortcut')}</span>
              )}
            </button>
          </SettingsRow>
        );
      })}
    </SettingsSection>
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
    if (e.key === 'Backspace' || e.key === 'Delete') {
      setKeybinding(capturing, '');
      setCapturing(null);
      setConflictWith(null);
      return;
    }
    const binding = eventToBinding(e, { allowBare: capturing === 'send-message' });
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
    <SettingsSection>
      {KEYBINDING_ACTIONS.map((action) => {
        const isCapturing = capturing === action;
        const isCustom = keybindings[action] !== undefined;
        const binding = bindings[action];
        const hint = ACTION_HINT_KEYS[action];
        return (
          <SettingsRow
            key={action}
            label={t(ACTION_LABEL_KEYS[action])}
            description={hint && t(hint)}
            status={
              isCapturing &&
              conflictWith && (
                <span className="text-[12px] text-destructive-text">
                  {t('Already used by "{{label}}"', {
                    label: t(ACTION_LABEL_KEYS[conflictWith]),
                  })}
                </span>
              )
            }
          >
            {binding && !isCapturing && (
              <IconAction title={t('Remove shortcut')} onClick={() => setKeybinding(action, '')}>
                <X className="h-3.5 w-3.5" />
              </IconAction>
            )}
            {isCustom && !isCapturing && (
              <IconAction
                title={t('Reset to default')}
                onClick={() => {
                  resetKeybinding(action);
                  addToast({ type: 'info', title: t('Reset to defaults') });
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </IconAction>
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
              className={cn(CAPTURE_BUTTON, isCapturing ? 'ring-1 ring-ring' : 'hover:bg-muted')}
            >
              {isCapturing ? (
                <span className="text-xs text-muted-foreground">{t('Press shortcut…')}</span>
              ) : binding ? (
                <Kbd>{formatBinding(binding)}</Kbd>
              ) : (
                <span className="text-xs text-muted-foreground">{t('No shortcut')}</span>
              )}
            </button>
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}
