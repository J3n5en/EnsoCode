import { DEFAULT_TRAY_TOGGLE_BINDING } from '@shared/keybindingAccelerator';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYBINDINGS,
  effectiveKeybindings,
  eventToBinding,
  formatBinding,
  IS_MAC,
  isHoldReleased,
  KEYBINDING_ACTIONS,
} from './keybindings';

function keyEvent(partial: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): KeyboardEvent {
  return {
    key: partial.key,
    metaKey: partial.metaKey ?? false,
    ctrlKey: partial.ctrlKey ?? false,
    altKey: partial.altKey ?? false,
    shiftKey: partial.shiftKey ?? false,
  } as KeyboardEvent;
}

describe('send-message binding', () => {
  it('defaults to Enter', () => {
    expect(KEYBINDING_ACTIONS).toContain('send-message');
    expect(DEFAULT_KEYBINDINGS['send-message']).toBe('enter');
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

describe('voice hold-to-talk binding', () => {
  const held = { metaKey: IS_MAC, ctrlKey: !IS_MAC, shiftKey: true };

  it('defaults to a bare Space without clashing with any other default', () => {
    expect(KEYBINDING_ACTIONS).toContain('voice-hold');
    expect(DEFAULT_KEYBINDINGS['voice-hold']).toBe('space');
    const values = Object.values(DEFAULT_KEYBINDINGS).filter(Boolean);
    expect(new Set(values).size).toBe(values.length);
  });

  it('only yields a bare Space binding when bare keys are allowed', () => {
    expect(eventToBinding(keyEvent({ key: ' ' }))).toBeNull();
    expect(eventToBinding(keyEvent({ key: ' ' }), { allowBare: true })).toBe('space');
    expect(formatBinding('space')).toBe('Space');
    expect(isHoldReleased('space', keyEvent({ key: ' ' }))).toBe(true);
    expect(isHoldReleased('space', keyEvent({ key: 'a' }))).toBe(false);
  });

  it('encodes Space by name, including the non-breaking space of mac Option+Space', () => {
    expect(eventToBinding(keyEvent({ key: ' ', ...held }))).toBe('mod+shift+space');
    expect(eventToBinding(keyEvent({ key: '\u00a0', altKey: true }))).toBe('alt+space');
    expect(formatBinding('mod+shift+space')).toMatch(/Space$/);
  });

  it('counts releasing the key or any required modifier as letting go', () => {
    expect(isHoldReleased('mod+shift+space', keyEvent({ key: ' ', ...held }))).toBe(true);
    expect(
      isHoldReleased('mod+shift+space', keyEvent({ ...held, key: 'Shift', shiftKey: false }))
    ).toBe(true);
    expect(
      isHoldReleased(
        'mod+shift+space',
        keyEvent({ ...held, key: IS_MAC ? 'Meta' : 'Control', metaKey: false, ctrlKey: false })
      )
    ).toBe(true);
    expect(isHoldReleased('mod+shift+space', keyEvent({ key: 'a', ...held }))).toBe(false);
  });
});
