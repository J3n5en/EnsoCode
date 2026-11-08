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
  const live = prep.collapseLiveActivity === true;
  const turnOverrides = prep.turnOverrides;

  const base = { compact, autoCollapseCompletedTurns, turnOverrides };
  const release = live ? nextActivityRelease(items, running, prep, witnessRef.current, now) : null;
  witnessRef.current = release?.witness ?? EMPTY_ACTIVITY_WITNESS;
  const wakeAt = release?.wakeAt ?? null;
  const rows = foldTimeline(items, running, expandedKeys, {
    ...base,
    collapseCompletedActivity: collapse,
    collapseLiveActivity: live,
    releasedLiveActivity: release?.released,
    heldOpenTools: prep.heldOpenTools,
  });

  useEffect(() => {
    if (wakeAt === null || wakeAt <= now) return;
    const timer = window.setTimeout(() => setNow(wakeAt), wakeAt - now);
    return () => window.clearTimeout(timer);
  }, [wakeAt, now]);

  return rows;
}
