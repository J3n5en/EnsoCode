/**
 * 断链后保留远端 renderer 的策略：缓冲没溢出就能续，所以不再固定 30 秒就销毁。
 * 溢出后再给一段宽限把积压发完；挂起太久仍要回收，避免一直占内存。
 */
export const RESUME_OVERFLOW_GRACE_MS = 30_000;
export const RESUME_MAX_SUSPEND_MS = 30 * 60_000;

/** 挂起的 renderer 该不该销毁：缓冲溢出后再等一段宽限，挂起太久也回收 */
export function resumeGrace(input: {
  retainedBytes: number;
  maxBytes: number;
  suspendedMs: number;
}): 'dispose' | null {
  if (input.suspendedMs >= RESUME_MAX_SUSPEND_MS) return 'dispose';
  if (input.retainedBytes >= input.maxBytes && input.suspendedMs >= RESUME_OVERFLOW_GRACE_MS) {
    return 'dispose';
  }
  return null;
}
