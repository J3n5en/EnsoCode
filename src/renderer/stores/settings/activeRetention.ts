export const ACTIVE_RETENTION_MINUTES = [0, 5, 10, 15, 30, 60, 120] as const;
export type ActiveRetentionMinutes = (typeof ACTIVE_RETENTION_MINUTES)[number];
export const DEFAULT_ACTIVE_RETENTION_MINUTES: ActiveRetentionMinutes = 0;

export function normalizeActiveRetentionMinutes(value: unknown): ActiveRetentionMinutes {
  return typeof value === 'number' && ACTIVE_RETENTION_MINUTES.includes(value as never)
    ? (value as ActiveRetentionMinutes)
    : DEFAULT_ACTIVE_RETENTION_MINUTES;
}
