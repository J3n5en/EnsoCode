/** Markdown 表格的排序与数值识别（纯函数）。 */

export type TableSort = { column: number; dir: 'asc' | 'desc' } | null;

const UNIT = /^(?:%|ms|s|sec|min|h|ms\/op|ns|µs|us|b|kb|mb|gb|tb|kib|mib|gib|x|×|k|m|bn)$/i;

/** 97.7%、$0.30、412 ms、1,234、(12) 都读作数字；带其它文字的不算 */
export function parseNumeric(text: string): number | null {
  let value = text.trim().replace(/^[$€£¥₹]\s*/, '');
  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1);
  }
  const match = /^([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(\S*)$/.exec(value);
  if (!match || (match[2] && !UNIT.test(match[2]))) return null;
  const number = Number(match[1]!.replace(/,/g, ''));
  return negative ? -number : number;
}

/** 非空单元格全能读成数字（且至少一个）的列 */
export function inferNumericColumns(rows: readonly (readonly string[])[]): boolean[] {
  const width = Math.max(0, ...rows.map((row) => row.length));
  return Array.from({ length: width }, (_, column) => {
    const cells = rows.map((row) => row[column]?.trim() ?? '').filter(Boolean);
    return cells.length > 0 && cells.every((cell) => parseNumeric(cell) !== null);
  });
}

export function compareCells(a: string, b: string, numeric: boolean): number {
  if (numeric) return (parseNumeric(a) ?? 0) - (parseNumeric(b) ?? 0);
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** 排序后的原行下标；空单元格不论升降序都垫底 */
export function sortedOrder(
  rows: readonly (readonly string[])[],
  sort: TableSort,
  numeric: readonly boolean[]
): number[] {
  const order = rows.map((_, index) => index);
  if (!sort) return order;
  const sign = sort.dir === 'asc' ? 1 : -1;
  const cell = (index: number) => rows[index]![sort.column]?.trim() ?? '';
  return order.sort((x, y) => {
    const a = cell(x);
    const b = cell(y);
    if (!a || !b) return a ? -1 : b ? 1 : 0;
    return sign * compareCells(a, b, numeric[sort.column] ?? false) || x - y;
  });
}

/** 点同一列：升序 → 降序 → 原序 */
export function nextSort(current: TableSort, column: number): TableSort {
  if (current?.column !== column) return { column, dir: 'asc' };
  return current.dir === 'asc' ? { column, dir: 'desc' } : null;
}
