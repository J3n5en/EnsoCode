/** 可配置快捷键:动作清单、默认绑定、事件↔绑定串转换。
 *  绑定格式 "mod+ctrl+alt+shift+key":mod = mac ⌘ / 其它平台 Ctrl;ctrl 仅 mac 有意义(⌃) */

export const KEYBINDING_ACTIONS = [
  'toggle-sidebar',
  'toggle-side-panel',
  'open-settings',
  'switch-model',
  'focus-composer',
  'new-conversation',
  'next-tab',
  'prev-tab',
  'new-side-tab',
  'close-side-tab',
] as const;
export type KeybindingAction = (typeof KEYBINDING_ACTIONS)[number];

export const ACTION_LABEL_KEYS: Record<KeybindingAction, string> = {
  'toggle-sidebar': 'Toggle sidebar',
  'toggle-side-panel': 'Toggle side panel',
  'open-settings': 'Open settings',
  'switch-model': 'Switch model',
  'focus-composer': 'Focus chat input',
  'new-conversation': 'New conversation',
  'next-tab': 'Next coworker tab',
  'prev-tab': 'Previous coworker tab',
  'new-side-tab': 'New terminal tab',
  'close-side-tab': 'Close terminal tab',
};

/** 仅部分动作需要补充生效范围，没有就不渲染 */
export const ACTION_HINT_KEYS: Partial<Record<KeybindingAction, string>> = {
  'switch-model': 'Only when the chat input is focused',
};

export const IS_MAC = navigator.platform.startsWith('Mac');

export const DEFAULT_KEYBINDINGS: Record<KeybindingAction, string> = {
  'toggle-sidebar': 'mod+b',
  'toggle-side-panel': 'mod+j',
  'open-settings': 'mod+,',
  'switch-model': 'mod+.',
  'focus-composer': 'mod+l',
  'new-conversation': 'mod+n',
  // Ctrl+Tab 循环 coworker 标签(浏览器惯例);非 mac 上 Ctrl 即 mod
  'next-tab': IS_MAC ? 'ctrl+tab' : 'mod+tab',
  'prev-tab': IS_MAC ? 'ctrl+shift+tab' : 'mod+shift+tab',
  'new-side-tab': 'mod+t',
  'close-side-tab': 'mod+w',
};

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
  const ctrl = IS_MAC && e.ctrlKey;
  if (!mod && !ctrl && !e.altKey) return null;
  const parts: string[] = [];
  if (mod) parts.push('mod');
  if (ctrl) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

/** 绑定串转显示文本:mac 用符号(⌃⌥⇧⌘B),其它平台 Ctrl+Alt+Shift+B */
export function formatBinding(binding: string): string {
  const parts = binding.split('+');
  const key = parts.at(-1) ?? '';
  const keyLabel =
    key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
  if (IS_MAC) {
    return [
      parts.includes('ctrl') ? '⌃' : '',
      parts.includes('alt') ? '⌥' : '',
      parts.includes('shift') ? '⇧' : '',
      parts.includes('mod') ? '⌘' : '',
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
