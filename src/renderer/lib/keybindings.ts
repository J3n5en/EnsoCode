/** 可配置快捷键:动作清单、默认绑定、事件↔绑定串转换。
 *  绑定格式 "mod+ctrl+alt+shift+key":mod = mac ⌘ / 其它平台 Ctrl;ctrl 仅 mac 有意义(⌃) */

import { DEFAULT_TRAY_TOGGLE_BINDING } from '@shared/keybindingAccelerator';

export const KEYBINDING_ACTIONS = [
  'toggle-sidebar',
  'toggle-app-mode',
  'toggle-side-panel',
  'toggle-side-panel-fullscreen',
  'open-settings',
  'switch-model',
  'focus-composer',
  'send-message',
  'find-in-chat',
  'search-workspace',
  'new-conversation',
  'next-tab',
  'prev-tab',
  'new-side-tab',
  'new-btw-tab',
  'close-side-tab',
  'toggle-minimize-to-tray',
  'voice-hold',
] as const;
export type KeybindingAction = (typeof KEYBINDING_ACTIONS)[number];

export const ACTION_LABEL_KEYS: Record<KeybindingAction, string> = {
  'toggle-sidebar': 'Toggle sidebar',
  'toggle-app-mode': 'Switch between Code and Bot',
  'toggle-side-panel': 'Toggle side panel',
  'toggle-side-panel-fullscreen': 'Toggle side panel fullscreen',
  'open-settings': 'Open settings',
  'switch-model': 'Switch model',
  'focus-composer': 'Focus chat input',
  'send-message': 'Send message',
  'find-in-chat': 'Find in conversation',
  'search-workspace': 'Search anything',
  'new-conversation': 'New conversation',
  'next-tab': 'Next coworker tab',
  'prev-tab': 'Previous coworker tab',
  'new-side-tab': 'New terminal tab',
  'new-btw-tab': 'New Btw tab',
  'close-side-tab': 'Close terminal tab',
  'toggle-minimize-to-tray': 'Toggle minimize to tray',
  'voice-hold': 'Voice input (hold to talk)',
};

/** 仅部分动作需要补充生效范围，没有就不渲染 */
export const ACTION_HINT_KEYS: Partial<Record<KeybindingAction, string>> = {
  'toggle-app-mode': 'Only when Bot mode is enabled in Experimental settings',
  'switch-model': 'Only when the chat input is focused',
  'send-message': 'Only when the chat input is focused',
  'new-side-tab': 'New terminal when the side panel is focused; otherwise new conversation',
  'new-btw-tab': 'Open a Btw tab in the side panel',
  'toggle-minimize-to-tray': 'Works while the app is in the tray',
  'voice-hold': 'Hold while the chat input is focused, release to put the text in it',
};

export function isEventInSidePanel(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-slot="side-panel"]') !== null;
}

export const IS_MAC =
  typeof navigator !== 'undefined' && typeof navigator.platform === 'string'
    ? navigator.platform.startsWith('Mac')
    : process.platform === 'darwin';

export const DEFAULT_KEYBINDINGS: Record<KeybindingAction, string> = {
  'toggle-sidebar': 'mod+b',
  'toggle-app-mode': 'mod+e',
  'toggle-side-panel': 'mod+j',
  'toggle-side-panel-fullscreen': 'mod+shift+j',
  'open-settings': 'mod+,',
  'switch-model': 'mod+.',
  'focus-composer': 'mod+l',
  'send-message': 'enter',
  'find-in-chat': 'mod+f',
  'search-workspace': 'mod+k',
  'new-conversation': 'mod+n',
  // Ctrl+Tab 循环 coworker 标签(浏览器惯例);非 mac 上 Ctrl 即 mod
  'next-tab': IS_MAC ? 'ctrl+tab' : 'mod+tab',
  'prev-tab': IS_MAC ? 'ctrl+shift+tab' : 'mod+shift+tab',
  'new-side-tab': 'mod+t',
  'new-btw-tab': 'mod+shift+b',
  'close-side-tab': 'mod+w',
  'toggle-minimize-to-tray': DEFAULT_TRAY_TOGGLE_BINDING,
  'voice-hold': 'space',
};

/** 合并用户覆盖与默认(store 只存覆盖项,默认可随版本演进) */
export function effectiveKeybindings(
  overrides: Record<string, string>
): Record<KeybindingAction, string> {
  return { ...DEFAULT_KEYBINDINGS, ...overrides };
}

/** keydown 事件转绑定串;纯修饰键返回 null。默认拒绝无修饰单键以免劫持输入;allowBare 仅放行 Enter / Space。 */
export function eventToBinding(
  e: KeyboardEvent | React.KeyboardEvent,
  options?: { allowBare?: boolean }
): string | null {
  const key = bindingKey(e);
  if (['meta', 'control', 'alt', 'shift'].includes(key)) return null;
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  const ctrl = IS_MAC && e.ctrlKey;
  const hasNonShiftModifier = Boolean(mod || ctrl || e.altKey);
  if (!hasNonShiftModifier && !(options?.allowBare && (key === 'enter' || key === 'space'))) {
    return null;
  }
  const parts: string[] = [];
  if (mod) parts.push('mod');
  if (ctrl) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

/** 空格记作 space：否则绑定串里是看不见的空格，mac 的 ⌥Space 还会给出不换行空格 */
function bindingKey(e: KeyboardEvent | React.KeyboardEvent): string {
  return e.key === ' ' || e.key === '\u00a0' ? 'space' : e.key.toLowerCase();
}

/** 按住型快捷键：松开主键或任一所需修饰键都算松手（mac 按着 ⌘ 时主键的 keyup 不一定会来） */
export function isHoldReleased(binding: string, e: KeyboardEvent): boolean {
  const parts = binding.split('+');
  if (bindingKey(e) === parts.at(-1)) return true;
  return (
    (parts.includes('mod') && !(IS_MAC ? e.metaKey : e.ctrlKey)) ||
    (parts.includes('ctrl') && !e.ctrlKey) ||
    (parts.includes('alt') && !e.altKey) ||
    (parts.includes('shift') && !e.shiftKey)
  );
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
