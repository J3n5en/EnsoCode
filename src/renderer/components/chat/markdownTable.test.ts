import { describe, expect, it } from 'vitest';
import { compareCells, inferNumericColumns, parseNumeric, sortedOrder } from './markdownTable';

describe('parseNumeric', () => {
  it.each([
    ['97.7%', 97.7],
    ['$0.30', 0.3],
    ['412 ms', 412],
    ['1,234', 1234],
    ['-5', -5],
    ['(12)', -12],
    ['¥ 8', 8],
    ['2.5 GB', 2.5],
  ])('%s → %d', (text, value) => {
    expect(parseNumeric(text)).toBe(value);
  });

  it.each(['', 'abc', 'v1.2', '12 apples', '1.2.3', '-'])('%s 不是数字', (text) => {
    expect(parseNumeric(text)).toBeNull();
  });
});

describe('inferNumericColumns', () => {
  it('非空单元格全是数字的列才算数字列，空格不影响', () => {
    expect(
      inferNumericColumns([
        ['alpha', '12 ms', '1'],
        ['beta', '', 'n/a'],
        ['gamma', '7 ms', '3'],
      ])
    ).toEqual([false, true, false]);
  });
});

describe('sortedOrder', () => {
  const rows = [
    ['b', '10'],
    ['a', '9'],
    ['c', ''],
  ];
  it('数字列按数值，空值始终垫底；文本列按自然序', () => {
    expect(sortedOrder(rows, { column: 1, dir: 'asc' }, [false, true])).toEqual([1, 0, 2]);
    expect(sortedOrder(rows, { column: 1, dir: 'desc' }, [false, true])).toEqual([0, 1, 2]);
    expect(sortedOrder(rows, { column: 0, dir: 'asc' }, [false, true])).toEqual([1, 0, 2]);
    expect(sortedOrder(rows, null, [false, true])).toEqual([0, 1, 2]);
  });

  it('文本比较按自然序：file2 排在 file10 前', () => {
    expect(compareCells('file2', 'file10', false)).toBeLessThan(0);
  });
});
