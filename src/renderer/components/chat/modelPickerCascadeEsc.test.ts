import { describe, expect, it, vi } from 'vitest';
import {
  CASCADE_ESCAPE_REASON,
  interceptRootCascadeEscape,
  markSubmenuOpen,
} from './modelPickerCascadeEsc';

function details(reason: string) {
  return {
    reason,
    cancel: vi.fn(),
    allowPropagation: vi.fn(),
  };
}

describe('interceptRootCascadeEscape', () => {
  it('子菜单开着且焦点在菜单项上：拦截 Esc，只让当前级关', () => {
    const event = details(CASCADE_ESCAPE_REASON);
    expect(
      interceptRootCascadeEscape(false, event, { openSubmenuCount: 1, searchFocused: false })
    ).toBe(true);
    expect(event.cancel).toHaveBeenCalledOnce();
    expect(event.allowPropagation).toHaveBeenCalledOnce();
  });

  it('搜索框有焦点：不拦截，整棵选模器一次关掉', () => {
    const event = details(CASCADE_ESCAPE_REASON);
    expect(
      interceptRootCascadeEscape(false, event, { openSubmenuCount: 1, searchFocused: true })
    ).toBe(false);
    expect(event.cancel).not.toHaveBeenCalled();
  });

  it('点击外部：不拦截，整棵一次关掉', () => {
    const event = details('outside-press');
    expect(
      interceptRootCascadeEscape(false, event, { openSubmenuCount: 1, searchFocused: false })
    ).toBe(false);
    expect(event.cancel).not.toHaveBeenCalled();
  });

  it('没有打开的子菜单：根层 Esc 正常关整棵', () => {
    const event = details(CASCADE_ESCAPE_REASON);
    expect(
      interceptRootCascadeEscape(false, event, { openSubmenuCount: 0, searchFocused: false })
    ).toBe(false);
    expect(event.cancel).not.toHaveBeenCalled();
  });

  it('打开事件不拦截', () => {
    const event = details(CASCADE_ESCAPE_REASON);
    expect(
      interceptRootCascadeEscape(true, event, { openSubmenuCount: 1, searchFocused: false })
    ).toBe(false);
    expect(event.cancel).not.toHaveBeenCalled();
  });
});

describe('markSubmenuOpen', () => {
  it('按 id 增减打开集合', () => {
    const ids = new Set<string>();
    markSubmenuOpen(ids, 'a', true);
    markSubmenuOpen(ids, 'b', true);
    expect([...ids]).toEqual(['a', 'b']);
    markSubmenuOpen(ids, 'a', false);
    expect([...ids]).toEqual(['b']);
  });
});
