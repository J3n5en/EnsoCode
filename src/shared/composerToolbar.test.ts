import { describe, expect, it } from 'vitest';
import {
  COMPOSER_TOOLBAR_DEFAULT_ORDER,
  COMPOSER_TOOLBAR_DEFAULT_PINNED,
  insertComposerToolbarSpacer,
  isStoredComposerToolbar,
  normalizeComposerToolbar,
  pinComposerToolbarItem,
  removeComposerToolbarSpacer,
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

  it('合法 spacer 留在原位置，重复与非法 spacer 丢弃，超过 5 个只留前 5 个', () => {
    const kept = normalizeComposerToolbar({
      order: ['model', 'spacer', 'preset', 'spacer', 'spacer-', 'spacer-0x', 'spacerx', 'foo'],
      pinned: ['spacer', 'model'],
    });
    expect(kept.order.slice(0, 3)).toEqual(['model', 'spacer', 'preset']);
    expect(kept.order.filter((entry) => entry === 'spacer')).toHaveLength(1);
    expect(kept.order).not.toContain('spacer-');
    expect(kept.order).not.toContain('spacer-0x');
    expect(kept.order).not.toContain('spacerx');
    expect(kept.order).not.toContain('foo');
    expect(kept.pinned).toEqual(['model']);

    const capped = normalizeComposerToolbar({
      order: ['spacer', 'spacer-2', 'spacer-3', 'spacer-4', 'spacer-5', 'spacer-6', 'preset'],
      pinned: [],
    });
    expect(capped.order.filter((entry) => String(entry).startsWith('spacer'))).toEqual([
      'spacer',
      'spacer-2',
      'spacer-3',
      'spacer-4',
      'spacer-5',
    ]);
    expect(capped.order).not.toContain('spacer-6');
    expect(capped.order.indexOf('preset')).toBeGreaterThan(capped.order.indexOf('spacer-5'));
  });

  it('add-image 在默认 order 末尾，不在默认 pinned', () => {
    const normalized = normalizeComposerToolbar(undefined);
    expect(normalized.order.at(-1)).toBe('add-image');
    expect(normalized.order).toContain('add-image');
    expect(normalized.pinned).not.toContain('add-image');
    expect(COMPOSER_TOOLBAR_DEFAULT_PINNED).not.toContain('add-image');
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

  it('spacer 也可以被拖到目标下标', () => {
    const base = normalizeComposerToolbar({
      order: ['preset', 'spacer', 'model'],
      pinned: [],
    });
    const next = reorderComposerToolbar(base, 'spacer', 0);
    expect(next.order[0]).toBe('spacer');
    expect(next.order[1]).toBe('preset');
    expect(next.pinned).toEqual(base.pinned);
  });
});

describe('insert/remove spacer', () => {
  it('在指定下标插入最小未占用的 spacer key', () => {
    const base = normalizeComposerToolbar({ order: ['preset', 'model'], pinned: [] });
    const first = insertComposerToolbarSpacer(base, 1);
    expect(first.order[0]).toBe('preset');
    expect(first.order[1]).toBe('spacer');
    expect(first.order[2]).toBe('model');
    expect(first.pinned).toEqual(base.pinned);

    const skipped = insertComposerToolbarSpacer(
      normalizeComposerToolbar({ order: ['spacer-2', 'preset'], pinned: [] }),
      0
    );
    expect(skipped.order[0]).toBe('spacer');

    const next = insertComposerToolbarSpacer(
      normalizeComposerToolbar({ order: ['spacer', 'spacer-4', 'preset'], pinned: [] }),
      1
    );
    expect(next.order[1]).toBe('spacer-2');
  });

  it('已有 5 个 spacer 时返回原对象', () => {
    let full = normalizeComposerToolbar({ order: ['preset'], pinned: [] });
    for (const key of ['spacer', 'spacer-2', 'spacer-3', 'spacer-4', 'spacer-5'] as const) {
      full = insertComposerToolbarSpacer(full, full.order.length);
      expect(full.order.at(-1)).toBe(key);
    }
    expect(insertComposerToolbarSpacer(full, 0)).toBe(full);

    const crowded = normalizeComposerToolbar({
      order: ['spacer-6', 'spacer-7', 'spacer-8', 'spacer-9', 'spacer-10', 'preset'],
      pinned: [],
    });
    expect(insertComposerToolbarSpacer(crowded, 0)).toBe(crowded);
  });

  it('移除指定 spacer，不存在则返回原对象', () => {
    const base = normalizeComposerToolbar({
      order: ['preset', 'spacer', 'model'],
      pinned: ['preset'],
    });
    const next = removeComposerToolbarSpacer(base, 'spacer');
    expect(next.order.filter((entry) => entry === 'spacer')).toHaveLength(0);
    expect(next.order[0]).toBe('preset');
    expect(next.order[1]).toBe('model');
    expect(next.pinned).toEqual(base.pinned);
    expect(removeComposerToolbarSpacer(base, 'spacer-2')).toBe(base);
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

  it('合法 spacer 通过，重复、超过 5 个、pinned 里的 spacer 拒绝', () => {
    expect(
      isStoredComposerToolbar({
        order: ['preset', 'spacer', 'spacer-2', 'spacer-0'],
        pinned: ['preset'],
      })
    ).toBe(true);
    expect(isStoredComposerToolbar({ order: ['spacer', 'spacer'], pinned: [] })).toBe(false);
    expect(
      isStoredComposerToolbar({
        order: ['spacer', 'spacer-2', 'spacer-3', 'spacer-4', 'spacer-5', 'spacer-6'],
        pinned: [],
      })
    ).toBe(false);
    expect(isStoredComposerToolbar({ order: ['preset'], pinned: ['spacer'] })).toBe(false);
  });
});
