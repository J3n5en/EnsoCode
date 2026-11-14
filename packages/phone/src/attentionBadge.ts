/** 主屏幕角标：只数「要你动手」的提问与审批，不含运行中。 */

export function attentionBadgeCount(
  entries: readonly {
    pendingAskCount?: number;
    pendingApprovalCount?: number;
    muted?: boolean;
  }[]
): number {
  let n = 0;
  for (const entry of entries) {
    if (entry.muted === true) continue;
    n += positiveCount(entry.pendingAskCount);
    n += positiveCount(entry.pendingApprovalCount);
  }
  return n;
}

function positiveCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

export function applyAppBadge(
  count: number,
  api: {
    setAppBadge?: (n: number) => unknown;
    clearAppBadge?: () => unknown;
  } = typeof navigator === 'undefined' ? {} : navigator
): void {
  const n = positiveCount(count);
  try {
    if (n > 0) void api.setAppBadge?.(n);
    else void api.clearAppBadge?.();
  } catch {}
}
