import { useEffect, useRef, useState } from 'react';
import {
  EMPTY_ACTIVITY_WITNESS,
  foldTimeline,
  nextActivityRelease,
  type TimelineItem,
  type TimelinePrep,
} from '@/stores/sessions/timeline';

/**
 * now 停在 state：流式渲染不重读时钟，已经记下的 closedAt 才不会被改晚。
 * 到点只把 now 设成 wakeAt。witness 跟这次挂载走，不进会话 store。
 */
export function useFoldedTimeline(
  items: TimelineItem[],
  running: boolean,
  expandedKeys: ReadonlySet<string>,
  prep: TimelinePrep
): TimelineItem[] {
  const witnessRef = useRef(EMPTY_ACTIVITY_WITNESS);
  const [now, setNow] = useState(() => Date.now());
  const compact = prep.compact;
  const autoCollapseCompletedTurns = prep.autoCollapseCompletedTurns;
  const collapse = prep.collapseCompletedActivity === true;
  const turnOverrides = prep.turnOverrides;

  const base = { compact, autoCollapseCompletedTurns, turnOverrides };
  let wakeAt: number | null = null;
  let rows: TimelineItem[];
  if (!collapse) {
    witnessRef.current = EMPTY_ACTIVITY_WITNESS;
    rows = foldTimeline(items, running, expandedKeys, {
      ...base,
      collapseCompletedActivity: false,
    });
  } else {
    const release = nextActivityRelease(
      items,
      running,
      { ...base, collapseCompletedActivity: true },
      witnessRef.current,
      now
    );
    witnessRef.current = release.witness;
    wakeAt = release.wakeAt;
    rows = foldTimeline(items, running, expandedKeys, {
      ...base,
      collapseCompletedActivity: true,
      releasedActivity: release.released,
    });
  }

  useEffect(() => {
    if (wakeAt === null || wakeAt <= now) return;
    const timer = window.setTimeout(() => setNow(wakeAt), wakeAt - now);
    return () => window.clearTimeout(timer);
  }, [wakeAt, now]);

  return rows;
}
