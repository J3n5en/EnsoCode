const holders = new Set<unknown>();
let reported = false;

/**
 * 输入框里的草稿只在内存里，应用重启就丢：各输入框报自己有没有，
 * 汇总后只在有无变化时告诉 Main（不等空闲的自动重启据此先等）
 */
export function setUnsentDraft(holder: unknown, has: boolean): void {
  if (has) holders.add(holder);
  else holders.delete(holder);
  const next = holders.size > 0;
  if (next === reported) return;
  reported = next;
  window.electronAPI?.updater?.reportUnsentDraft?.(next);
}
