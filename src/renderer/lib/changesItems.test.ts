import { describe, expect, it } from 'vitest';
import { buildChangeItems, type ChangeItemMemo } from './changesItems';

const file = (path: string, oldText: string, newText: string) => ({ path, oldText, newText });

describe('buildChangeItems', () => {
  it('Git 预览忽略 CRLF 与 LF 差别，只统计实际修改的行', () => {
    const items = buildChangeItems(
      [file('a.txt', 'first\nold\nlast\n', 'first\r\nnew\r\nlast\r\n')],
      new Set(),
      new Map(),
      { ignoreLineEndings: true }
    );
    expect(items[0].fileDiff.hunks.reduce((count, hunk) => count + hunk.additionLines, 0)).toBe(1);
    expect(items[0].fileDiff.hunks.reduce((count, hunk) => count + hunk.deletionLines, 0)).toBe(1);
  });

  it('换行处理选项切换后刷新缓存，默认仍保留换行差异', () => {
    const files = [file('a.txt', 'first\nlast\n', 'first\r\nlast\r\n')];
    const memo: ChangeItemMemo = new Map();
    const original = buildChangeItems(files, new Set(), memo);
    expect(original[0].fileDiff.hunks).not.toHaveLength(0);
    const normalized = buildChangeItems(files, new Set(), memo, { ignoreLineEndings: true });
    expect(normalized[0].fileDiff.hunks).toHaveLength(0);
    expect(normalized[0].version).toBe((original[0].version ?? 0) + 1);
    expect(normalized[0].fileDiff.cacheKey).not.toBe(original[0].fileDiff.cacheKey);
  });

  it('首次构建：version 从 0 起，collapsed 取自集合', () => {
    const memo: ChangeItemMemo = new Map();
    const items = buildChangeItems([file('a.ts', 'x', 'y')], new Set(['diff:a.ts']), memo);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'diff:a.ts', type: 'diff', collapsed: true, version: 0 });
    expect(items[0].fileDiff).toBeDefined();
  });

  it('内容与折叠状态都不变时 version 与 fileDiff 引用不变', () => {
    const memo: ChangeItemMemo = new Map();
    const files = [file('a.ts', 'x', 'y')];
    const first = buildChangeItems(files, new Set(), memo);
    const second = buildChangeItems([file('a.ts', 'x', 'y')], new Set(), memo);
    expect(second[0].version).toBe(first[0].version);
    expect(second[0].fileDiff).toBe(first[0].fileDiff);
  });

  it('内容变化 → version 递增且重新解析 diff；折叠切换 → 只递增 version', () => {
    const memo: ChangeItemMemo = new Map();
    const first = buildChangeItems([file('a.ts', 'x', 'y')], new Set(), memo);
    const changed = buildChangeItems([file('a.ts', 'x', 'z')], new Set(), memo);
    expect(changed[0].version).toBe((first[0].version ?? 0) + 1);
    expect(changed[0].fileDiff).not.toBe(first[0].fileDiff);
    const collapsed = buildChangeItems([file('a.ts', 'x', 'z')], new Set(['diff:a.ts']), memo);
    expect(collapsed[0].version).toBe((changed[0].version ?? 0) + 1);
    expect(collapsed[0].fileDiff).toBe(changed[0].fileDiff);
    expect(collapsed[0].collapsed).toBe(true);
  });

  it('同一路径内容变化后 cacheKey 不同，否则 worker 池会拿旧高亮套新 diff', () => {
    const memo: ChangeItemMemo = new Map();
    const first = buildChangeItems([file('a.ts', 'x', 'y')], new Set(), memo);
    const changed = buildChangeItems([file('a.ts', 'x', 'z')], new Set(), memo);
    expect(first[0].fileDiff.cacheKey).toBeTruthy();
    expect(changed[0].fileDiff.cacheKey).not.toBe(first[0].fileDiff.cacheKey);
  });

  it('消失的文件从 memo 清掉', () => {
    const memo: ChangeItemMemo = new Map();
    buildChangeItems([file('a.ts', 'x', 'y'), file('b.ts', '1', '2')], new Set(), memo);
    buildChangeItems([file('b.ts', '1', '2')], new Set(), memo);
    expect([...memo.keys()]).toEqual(['diff:b.ts']);
  });
});
