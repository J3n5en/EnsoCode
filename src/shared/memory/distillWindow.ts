/** 会话结束后等多久再提炼：窗口内同项目的会话合并成一次；0 = 立即提炼（不聚合） */
export const MEMORY_DISTILL_WINDOW_MINUTES = [0, 2, 5, 10, 30] as const;
export const DEFAULT_MEMORY_DISTILL_WINDOW_MINUTES = 5;

export function normalizeMemoryDistillWindowMinutes(value: unknown): number {
  return typeof value === 'number' &&
    MEMORY_DISTILL_WINDOW_MINUTES.some((minutes) => minutes === value)
    ? value
    : DEFAULT_MEMORY_DISTILL_WINDOW_MINUTES;
}
