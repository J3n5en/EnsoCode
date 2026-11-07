import { describe, expect, it } from 'vitest';
import { closestMatchHint } from './closestMatch';

const file = [
  'import x from "x";',
  '',
  'export function demo(a: number) {',
  '  const doubled = a * 2;',
  '  return doubled + 1;',
  '}',
  '',
  'export const tail = true;',
];

describe('closestMatchHint', () => {
  it('按行投票找到最接近的区域，带行号原文', () => {
    const hint = closestMatchHint(file, [
      'export function demo(a: number) {',
      '  const doubled = a * 3;',
      '  return doubled + 1;',
    ]);
    expect(hint).toContain('lines 2-6');
    expect(hint).toContain('     4|   const doubled = a * 2;');
  });

  it('缩进不同也能定位', () => {
    expect(closestMatchHint(file, ['return doubled + 1;'])).toContain(
      '     5|   return doubled + 1;'
    );
  });

  it('没有任何相同行时返回空串', () => {
    expect(closestMatchHint(file, ['nothing here', 'at all'])).toBe('');
  });
});
