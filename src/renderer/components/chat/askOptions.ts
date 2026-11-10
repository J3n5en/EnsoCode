/** 提问选项的数字直选：只覆盖前 9 个，0 留给自由输入 */
export function askOptionShortcut(index: number): string | null {
  return index >= 0 && index < 9 ? String(index + 1) : null;
}

export function askOptionShortcutCount(options: readonly string[]): number {
  return Math.min(options.length, 9);
}

/** 键盘焦点位置：0..n-1 为选项，n 为输入框。打开时落推荐项，否则第一个位置 */
export function askFocusStart(
  options: readonly string[] | undefined,
  recommended?: string
): number {
  const index = recommended === undefined ? -1 : (options?.indexOf(recommended) ?? -1);
  return index >= 0 ? index : 0;
}

/** ↑↓ 移动焦点，到头停住；其它键返回 null */
export function askFocusMove(index: number, count: number, key: string): number | null {
  if (key === 'ArrowDown') return Math.min(index + 1, count - 1);
  if (key === 'ArrowUp') return Math.max(index - 1, 0);
  return null;
}
