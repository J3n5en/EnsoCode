import {
  FORGETTING_DEFAULT_INTERVAL_DAYS,
  FORGETTING_DEFAULT_MAX_IMPORTANCE,
  FORGETTING_DEFAULT_STALE_DAYS,
  FORGETTING_INTERVAL_DAYS_MAX,
  FORGETTING_INTERVAL_DAYS_MIN,
  FORGETTING_MAX_IMPORTANCE_MAX,
  FORGETTING_MAX_IMPORTANCE_MIN,
  FORGETTING_STALE_DAYS_MAX,
  FORGETTING_STALE_DAYS_MIN,
} from './constants';

/**
 * 「自动遗忘」的三档行为。三档互相独立，越往下越危险，默认只开第一档：
 *   enabled          衰减进检索排序（只降权，不改任何状态）
 *   archiveCandidates 把满足阈值的记忆标成归档候选（只标记，列表里显示「建议归档」）
 *   autoArchive      每轮把候选直接归档（lifecycle_state → archived，永不删除）
 */
export interface ForgettingSettings {
  enabled: boolean;
  archiveCandidates: boolean;
  autoArchive: boolean;
  /** 超过这么多天没被检索命中就算「冷」；从未命中的按创建时间算 */
  staleDays: number;
  /** 重要度 <= 这个值才算「不重要」；默认 0.5 = 提炼允许写库的最低档 */
  maxImportance: number;
  /** 巡检间隔（天）；只在开库时检查，不另起定时器 */
  intervalDays: number;
}

export const DEFAULT_FORGETTING_SETTINGS: ForgettingSettings = {
  enabled: true,
  archiveCandidates: false,
  autoArchive: false,
  staleDays: FORGETTING_DEFAULT_STALE_DAYS,
  maxImportance: FORGETTING_DEFAULT_MAX_IMPORTANCE,
  intervalDays: FORGETTING_DEFAULT_INTERVAL_DAYS,
};

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * 设置项 → 行为配置。脏值一律回落到默认值而不是抛错：这些值来自 settings.json，
 * 手改坏了不能让记忆库打不开。autoArchive 依赖 archiveCandidates（没有候选就没有可归档的），
 * 这里不强行联动，由调用方按 `archiveCandidates && autoArchive` 判断。
 */
export function normalizeForgettingSettings(raw: unknown): ForgettingSettings {
  const row =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    enabled: row.memoryDecayEnabled !== false,
    archiveCandidates: row.memoryDecayArchiveCandidates === true,
    autoArchive: row.memoryDecayAutoArchive === true,
    staleDays: Math.round(
      clampNumber(
        row.memoryDecayStaleDays,
        FORGETTING_DEFAULT_STALE_DAYS,
        FORGETTING_STALE_DAYS_MIN,
        FORGETTING_STALE_DAYS_MAX
      )
    ),
    maxImportance: clampNumber(
      row.memoryDecayMaxImportance,
      FORGETTING_DEFAULT_MAX_IMPORTANCE,
      FORGETTING_MAX_IMPORTANCE_MIN,
      FORGETTING_MAX_IMPORTANCE_MAX
    ),
    intervalDays: Math.round(
      clampNumber(
        row.memoryDecayIntervalDays,
        FORGETTING_DEFAULT_INTERVAL_DAYS,
        FORGETTING_INTERVAL_DAYS_MIN,
        FORGETTING_INTERVAL_DAYS_MAX
      )
    ),
  };
}
