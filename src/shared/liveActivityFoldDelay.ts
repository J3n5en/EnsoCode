/** 过程中折叠的等待秒数。只有「过程中折叠」打开时界面才显示，缺省 5 秒。 */
export const LIVE_ACTIVITY_FOLD_DELAY_SEC_MIN = 1;
export const LIVE_ACTIVITY_FOLD_DELAY_SEC_MAX = 60;
export const DEFAULT_LIVE_ACTIVITY_FOLD_DELAY_SEC = 5;

export function liveActivityFoldDelaySec(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value))
    return DEFAULT_LIVE_ACTIVITY_FOLD_DELAY_SEC;
  if (value < LIVE_ACTIVITY_FOLD_DELAY_SEC_MIN) return LIVE_ACTIVITY_FOLD_DELAY_SEC_MIN;
  if (value > LIVE_ACTIVITY_FOLD_DELAY_SEC_MAX) return LIVE_ACTIVITY_FOLD_DELAY_SEC_MAX;
  return value;
}

export function liveActivityFoldDelayMs(value: unknown): number {
  return liveActivityFoldDelaySec(value) * 1000;
}
