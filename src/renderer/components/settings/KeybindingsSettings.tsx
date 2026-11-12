import { RotateCcw, X } from 'lucide-react';
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
import { type PluginCommandRef, pluginCommandRefs } from '@/plugins/commands';
import { resolvePluginKeybindings } from '@/plugins/keybindings';
import { useSettingsStore } from '@/stores/settings';

export function KeybindingsSettings() {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <div data-settings-row="shortcuts.root">
        <h3 className="text-lg font-medium">{t('Shortcuts')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('Click a shortcut to rebind it. Backspace removes it; Esc cancels.')}
        </p>
      </div>
      <KeybindingsSection />
      <PluginKeybindingsSection />
    </div>
  );
}

/** 设置窗口不挂 PluginUiHost，直接拉插件列表 */
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
    <div className="space-y-2">
      <h4 className="font-medium text-sm">插件命令</h4>
      <div className="divide-y rounded-md border">
        {rows.map(({ action, command, binding, custom, conflict }) => {
          const isCapturing = capturing === action;
          return (
            <div key={action} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm">{command.title}</p>
                <p className="text-muted-foreground text-xs">
                  {command.pluginName}
                  {conflict && !isCapturing && (
                    <span className="ml-2 text-destructive">
                      {t('Already used by "{{label}}"', { label: labelOf(conflict) })}
                    </span>
                  )}
                </p>
              </div>
              {isCapturing && taken && (
                <span className="text-destructive text-xs">
                  {t('Already used by "{{label}}"', { label: labelOf(taken) })}
                </span>
              )}
              {binding && !isCapturing && (
                <button
                  type="button"
                  title={t('Remove shortcut')}
                  onClick={() => setKeybinding(action, '')}
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
              {custom && !isCapturing && (
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
                  setTaken(null);
                }}
                onKeyDown={isCapturing ? (e) => capture(e, action, command.key) : undefined}
                onBlur={() => isCapturing && stop()}
                // biome-ignore lint/a11y/noAutofocus: 进入录制态即聚焦以捕获按键是预期交互
                autoFocus={isCapturing}
                className={cn(
                  'rounded-md px-1 py-0.5 transition-colors',
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
            </div>
          );
        })}
      </div>
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
    if (e.key === 'Backspace' || e.key === 'Delete') {
      setKeybinding(capturing, '');
      setCapturing(null);
      setConflictWith(null);
      return;
    }
    const binding = eventToBinding(e, {
      allowBare: capturing === 'send-message' || capturing === 'voice-hold',
    });
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
        const binding = bindings[action];
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
            {binding && !isCapturing && (
              <button
                type="button"
                title={t('Remove shortcut')}
                onClick={() => setKeybinding(action, '')}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
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
              ) : binding ? (
                <Kbd>{formatBinding(binding)}</Kbd>
              ) : (
                <span className="text-xs text-muted-foreground">{t('No shortcut')}</span>
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
