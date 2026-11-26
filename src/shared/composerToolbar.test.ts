import { describe, expect, it } from 'vitest';
import {
  COMPOSER_TOOLBAR_DEFAULT_ORDER,
  COMPOSER_TOOLBAR_DEFAULT_PINNED,
  isStoredComposerToolbar,
  normalizeComposerToolbar,
  pinComposerToolbarItem,
  reorderComposerToolbar,
  unpinComposerToolbarItem,
} from './composerToolbar';

describe('normalizeComposerToolbar', () => {
  it('空值回落默认：preset/分支/权限/模型 pin 在外面', () => {
    const normalized = normalizeComposerToolbar(undefined);
    expect(normalized.pinned).toEqual([...COMPOSER_TOOLBAR_DEFAULT_PINNED]);
    expect(normalized.order).toEqual([...COMPOSER_TOOLBAR_DEFAULT_ORDER]);
  });

  it('过滤未知 id、去重，漏掉的 id 追加到 order 末尾', () => {
    const normalized = normalizeComposerToolbar({
      order: ['model', 'bogus', 'model', 'preset'],
      pinned: ['model', 'bogus', 'preset'],
    });
    expect(normalized.pinned).toEqual(['model', 'preset']);
    expect(normalized.order[0]).toBe('model');
    expect(normalized.order[1]).toBe('preset');
    expect(normalized.order).toHaveLength(COMPOSER_TOOLBAR_DEFAULT_ORDER.length);
    expect(new Set(normalized.order).size).toBe(COMPOSER_TOOLBAR_DEFAULT_ORDER.length);
    expect(normalized.order).toContain('approval-mode');
    expect(normalized.order).not.toContain('bogus');
  });

  it('脏输入（非数组/非对象）回落默认', () => {
    expect(normalizeComposerToolbar('x').pinned).toEqual([...COMPOSER_TOOLBAR_DEFAULT_PINNED]);
    expect(normalizeComposerToolbar({ order: 1, pinned: null }).order).toEqual([
      ...COMPOSER_TOOLBAR_DEFAULT_ORDER,
    ]);
    expect(normalizeComposerToolbar({ order: [], pinned: [] }).pinned).toEqual([]);
    expect(normalizeComposerToolbar({ order: [], pinned: [] }).order).toEqual([
      ...COMPOSER_TOOLBAR_DEFAULT_ORDER,
    ]);
  });
});

describe('pin/unpin', () => {
  it('pin 追加到 pinned 末尾且不在 order 里移动', () => {
    const base = normalizeComposerToolbar(undefined);
    const next = pinComposerToolbarItem(base, 'learn');
    expect(next.pinned[next.pinned.length - 1]).toBe('learn');
    expect(next.order).toEqual(base.order);
  });

  it('重复 pin 不产生重复项', () => {
    const base = pinComposerToolbarItem(normalizeComposerToolbar(undefined), 'learn');
    const again = pinComposerToolbarItem(base, 'learn');
    expect(again.pinned.filter((id) => id === 'learn')).toHaveLength(1);
  });

  it('unpin 只移出 pinned，order 保持完整', () => {
    const base = normalizeComposerToolbar(undefined);
    const next = unpinComposerToolbarItem(base, 'model');
    expect(next.pinned).not.toContain('model');
    expect(next.order).toContain('model');
    expect(next.order).toHaveLength(COMPOSER_TOOLBAR_DEFAULT_ORDER.length);
  });
});

describe('reorderComposerToolbar', () => {
  it('把 id 移到目标下标，其余顺序保持', () => {
    const base = normalizeComposerToolbar(undefined);
    const next = reorderComposerToolbar(base, 'model', 0);
    expect(next.order[0]).toBe('model');
    expect(next.order).toContain('preset');
    expect(new Set(next.order).size).toBe(COMPOSER_TOOLBAR_DEFAULT_ORDER.length);
  });

  it('未知 id 或越界下标不改变顺序', () => {
    const base = normalizeComposerToolbar(undefined);
    expect(reorderComposerToolbar(base, 'bogus' as never, 0).order).toEqual(base.order);
    expect(reorderComposerToolbar(base, 'model', 99).order).toEqual(base.order);
  });
});

describe('isStoredComposerToolbar（configSync 导入严格校验）', () => {
  it('合法形状通过', () => {
    expect(isStoredComposerToolbar(normalizeComposerToolbar(undefined))).toBe(true);
    expect(isStoredComposerToolbar({ order: [], pinned: [] })).toBe(true);
  });

  it('未知 id、重复、非数组、缺键、多余键都拒绝', () => {
    expect(isStoredComposerToolbar(undefined)).toBe(false);
    expect(isStoredComposerToolbar({ order: ['bogus'], pinned: [] })).toBe(false);
    expect(isStoredComposerToolbar({ order: ['preset', 'preset'], pinned: [] })).toBe(false);
    expect(isStoredComposerToolbar({ order: [], pinned: ['bogus'] })).toBe(false);
    expect(isStoredComposerToolbar({ order: [] })).toBe(false);
    expect(isStoredComposerToolbar({ order: [], pinned: [], extra: 1 })).toBe(false);
    expect(isStoredComposerToolbar({ order: 'x', pinned: [] })).toBe(false);
  });
});
