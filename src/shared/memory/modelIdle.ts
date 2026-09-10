export const MEMORY_MODEL_IDLE_MINUTES = [5, 10, 30, 0] as const;
export const DEFAULT_MEMORY_MODEL_IDLE_MINUTES = 10;

export function normalizeMemoryModelIdleMinutes(value: unknown): number {
  return typeof value === 'number' && MEMORY_MODEL_IDLE_MINUTES.some((minutes) => minutes === value)
    ? value
    : DEFAULT_MEMORY_MODEL_IDLE_MINUTES;
}
