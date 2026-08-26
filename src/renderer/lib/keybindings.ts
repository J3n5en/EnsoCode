/** 可配置快捷键:动作清单、默认绑定、事件↔绑定串转换。绑定格式 "mod+alt+shift+key",mod = mac ⌘ / 其它 Ctrl */

export const KEYBINDING_ACTIONS = ['toggle-sidebar', 'open-settings', 'new-conversation'] as const;
export type KeybindingAction = (typeof KEYBINDING_ACTIONS)[number];

export const DEFAULT_KEYBINDINGS: Record<KeybindingAction, string> = {
  'toggle-sidebar': 'mod+b',
  'open-settings': 'mod+,',
  'new-conversation': 'mod+n',
};

export const IS_MAC = navigator.platform.startsWith('Mac');

/** 合并用户覆盖与默认(store 只存覆盖项,默认可随版本演进) */
export function effectiveKeybindings(
  overrides: Record<string, string>
): Record<KeybindingAction, string> {
  return { ...DEFAULT_KEYBINDINGS, ...overrides };
}

/** keydown 事件转绑定串;纯修饰键或无修饰的单键(避免劫持正常输入)返回 null */
export function eventToBinding(e: KeyboardEvent | React.KeyboardEvent): string | null {
  const key = e.key.toLowerCase();
  if (['meta', 'control', 'alt', 'shift'].includes(key)) return null;
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (!mod && !e.altKey) return null;
  const parts: string[] = [];
  if (mod) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

/** 绑定串转显示文本:mac 用符号(⌘⌥⇧B),其它平台 Ctrl+Alt+Shift+B */
export function formatBinding(binding: string): string {
  const parts = binding.split('+');
  const key = parts.at(-1) ?? '';
  const keyLabel = key.length === 1 ? key.toUpperCase() : key;
  if (IS_MAC) {
    return [
      parts.includes('mod') ? '⌘' : '',
      parts.includes('alt') ? '⌥' : '',
      parts.includes('shift') ? '⇧' : '',
      keyLabel,
    ].join('');
  }
  return [
    parts.includes('mod') ? 'Ctrl' : '',
    parts.includes('alt') ? 'Alt' : '',
    parts.includes('shift') ? 'Shift' : '',
    keyLabel,
  ]
    .filter(Boolean)
    .join('+');
}
