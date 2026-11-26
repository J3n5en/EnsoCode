import { DEFAULT_TRAY_TOGGLE_BINDING } from '@shared/keybindingAccelerator';
import { describe, expect, it } from 'vitest';
import {
  ADD_PROJECT_SHORTCUT,
  DEFAULT_KEYBINDINGS,
  effectiveKeybindings,
  eventToBinding,
  formatBinding,
  IS_MAC,
  isAddProjectShortcut,
  isSendMessageKey,
  KEYBINDING_ACTIONS,
} from './keybindings';

function keyEvent(partial: {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
}): KeyboardEvent {
  return {
    key: partial.key,
    code: partial.code ?? '',
    metaKey: partial.metaKey ?? false,
    ctrlKey: partial.ctrlKey ?? false,
    altKey: partial.altKey ?? false,
    shiftKey: partial.shiftKey ?? false,
    repeat: partial.repeat ?? false,
    defaultPrevented: partial.defaultPrevented ?? false,
  } as KeyboardEvent;
}

describe('send-message binding', () => {
  it('mac 上 ⌥ 改写的字符按物理键记，如 ⌥P 的 π 记作 p', () => {
    const mod = IS_MAC ? { metaKey: true } : { ctrlKey: true };
    expect(eventToBinding(keyEvent({ key: 'π', code: 'KeyP', altKey: true, ...mod }))).toBe(
      'mod+alt+p'
    );
    expect(eventToBinding(keyEvent({ key: '¡', code: 'Digit1', altKey: true, ...mod }))).toBe(
      'mod+alt+1'
    );
    expect(eventToBinding(keyEvent({ key: 'k', code: 'KeyK', ...mod }))).toBe('mod+k');
  });

  it('defaults to Enter', () => {
    expect(KEYBINDING_ACTIONS).toContain('send-message');
    expect(DEFAULT_KEYBINDINGS['send-message']).toBe('enter');
  });

  it('isSendMessageKey 跟随用户绑定，未绑定时不发送', () => {
    const enter = keyEvent({ key: 'Enter' });
    const modEnter = keyEvent({
      key: 'Enter',
      ...(IS_MAC ? { metaKey: true } : { ctrlKey: true }),
    });
    expect(isSendMessageKey(enter, 'enter')).toBe(true);
    expect(isSendMessageKey(keyEvent({ key: 'Enter', shiftKey: true }), 'enter')).toBe(false);
    expect(isSendMessageKey(enter, 'mod+enter')).toBe(false);
    expect(isSendMessageKey(modEnter, 'mod+enter')).toBe(true);
    expect(isSendMessageKey(enter, '')).toBe(false);
  });

  it('切换最小化到托盘有默认全局绑定', () => {
    expect(KEYBINDING_ACTIONS).toContain('toggle-minimize-to-tray');
    expect(DEFAULT_KEYBINDINGS['toggle-minimize-to-tray']).toBe(DEFAULT_TRAY_TOGGLE_BINDING);
  });

  it('切换 Code / Bot 模式有默认绑定且不与其它动作冲突', () => {
    expect(KEYBINDING_ACTIONS).toContain('toggle-app-mode');
    const binding = DEFAULT_KEYBINDINGS['toggle-app-mode'];
    expect(binding).toBe('mod+e');
    expect(KEYBINDING_ACTIONS.filter((action) => DEFAULT_KEYBINDINGS[action] === binding)).toEqual([
      'toggle-app-mode',
    ]);
  });

  it('打开秘书有默认绑定且不与其它动作冲突', () => {
    expect(KEYBINDING_ACTIONS).toContain('open-secretary');
    const binding = DEFAULT_KEYBINDINGS['open-secretary'];
    expect(binding).toBe('mod+shift+s');
    expect(KEYBINDING_ACTIONS.filter((action) => DEFAULT_KEYBINDINGS[action] === binding)).toEqual([
      'open-secretary',
    ]);
  });

  it('空覆盖表示删除，不回落到默认', () => {
    expect(effectiveKeybindings({ 'toggle-minimize-to-tray': '' })['toggle-minimize-to-tray']).toBe(
      ''
    );
  });

  it('allowBare 只放行 Enter 家族，字母仍要修饰键', () => {
    expect(eventToBinding(keyEvent({ key: 'Enter' }))).toBeNull();
    expect(eventToBinding(keyEvent({ key: 'Enter' }), { allowBare: true })).toBe('enter');
    expect(eventToBinding(keyEvent({ key: 'Enter', shiftKey: true }), { allowBare: true })).toBe(
      'shift+enter'
    );
    expect(eventToBinding(keyEvent({ key: 'a' }), { allowBare: true })).toBeNull();
  });

  it('mod+Enter 与平台无关地编码为 mod+enter', () => {
    const event = keyEvent({
      key: 'Enter',
      metaKey: IS_MAC,
      ctrlKey: !IS_MAC,
    });
    expect(eventToBinding(event)).toBe('mod+enter');
    expect(eventToBinding(event, { allowBare: true })).toBe('mod+enter');
  });

  it('formatBinding 显示 Enter', () => {
    expect(formatBinding('enter')).toBe('Enter');
    expect(formatBinding('shift+enter')).toMatch(/Enter/);
  });
});

describe('Space binding', () => {
  const held = { metaKey: IS_MAC, ctrlKey: !IS_MAC, shiftKey: true };

  it('never yields a bare Space binding', () => {
    expect(eventToBinding(keyEvent({ key: ' ' }))).toBeNull();
    expect(eventToBinding(keyEvent({ key: ' ' }), { allowBare: true })).toBeNull();
  });

  it('encodes Space by name, including the non-breaking space of mac Option+Space', () => {
    expect(eventToBinding(keyEvent({ key: ' ', ...held }))).toBe('mod+shift+space');
    expect(eventToBinding(keyEvent({ key: '\u00a0', altKey: true }))).toBe('alt+space');
    expect(formatBinding('mod+shift+space')).toMatch(/Space$/);
  });
});

describe('add project shortcut', () => {
  const mod = IS_MAC ? { metaKey: true } : { ctrlKey: true };

  it('Cmd/Ctrl+Shift+A 打开添加项目，且不占用现有默认绑定', () => {
    expect(ADD_PROJECT_SHORTCUT).toBe('mod+shift+a');
    expect(Object.values(DEFAULT_KEYBINDINGS)).not.toContain(ADD_PROJECT_SHORTCUT);
    expect(formatBinding(ADD_PROJECT_SHORTCUT)).toBe(IS_MAC ? '⇧⌘A' : 'Ctrl+Shift+A');
    expect(isAddProjectShortcut(keyEvent({ key: 'A', shiftKey: true, ...mod }))).toBe(true);
    expect(isAddProjectShortcut(keyEvent({ key: 'a', shiftKey: true, ...mod }))).toBe(true);
  });

  it('连发、少修饰键或带 Alt 都不算', () => {
    expect(isAddProjectShortcut(keyEvent({ key: 'A', shiftKey: true, repeat: true, ...mod }))).toBe(
      false
    );
    expect(isAddProjectShortcut(keyEvent({ key: 'a', ...mod }))).toBe(false);
    expect(isAddProjectShortcut(keyEvent({ key: 'A', shiftKey: true }))).toBe(false);
    expect(isAddProjectShortcut(keyEvent({ key: 'A', shiftKey: true, altKey: true, ...mod }))).toBe(
      false
    );
    const wrongMod = IS_MAC ? { ctrlKey: true } : { metaKey: true };
    expect(isAddProjectShortcut(keyEvent({ key: 'A', shiftKey: true, ...wrongMod }))).toBe(false);
  });
});
