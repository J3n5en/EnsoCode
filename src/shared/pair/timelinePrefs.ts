/** 桌面时间线折叠 / 待办条偏好，随 appearance 帧下发手机 */
export interface PairTimelinePrefs {
  expandLiveReasoning: boolean;
  autoCollapseTurns: boolean;
  collapseCompletedActivity: boolean;
  collapseLiveActivity: boolean;
  pinUnfinishedTodos: boolean;
}

/** 缺省或脏值（旧桌面）按桌面默认值；autoCollapseTurns 默认关，其余默认开 */
export function normalizeTimelinePrefs(
  raw: Partial<Record<keyof PairTimelinePrefs, unknown>>
): PairTimelinePrefs {
  return {
    expandLiveReasoning: raw.expandLiveReasoning !== false,
    autoCollapseTurns: raw.autoCollapseTurns === true,
    collapseCompletedActivity: raw.collapseCompletedActivity !== false,
    collapseLiveActivity: raw.collapseLiveActivity === true,
    pinUnfinishedTodos: raw.pinUnfinishedTodos !== false,
  };
}
