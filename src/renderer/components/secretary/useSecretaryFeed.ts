import {
  appendFeedPage,
  FEED_PAGE_SIZE,
  type FeedCursor,
  type FeedEvent,
  mergeFeedHead,
} from '@shared/secretary/feed';
import { useCallback, useEffect, useRef, useState } from 'react';

const TOP_SLACK = 8;

export function useSecretaryFeed(): {
  events: FeedEvent[];
  freshCount: number;
  loading: boolean;
  exhausted: boolean;
  sentinelRef: (node: HTMLDivElement | null) => void;
  reveal: () => void;
} {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [freshCount, setFreshCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [exhausted, setExhausted] = useState(false);
  const [ready, setReady] = useState(false);
  const [sentinelNode, setSentinelNode] = useState<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const eventsRef = useRef(events);
  const freshRef = useRef<FeedEvent[]>([]);
  const cursorRef = useRef<FeedCursor | undefined>(undefined);
  const loadingRef = useRef(false);
  const exhaustedRef = useRef(false);
  const readyRef = useRef(false);
  const headSeq = useRef(0);
  eventsRef.current = events;

  const setSentinel = useCallback((node: HTMLDivElement | null) => {
    sentinelRef.current = node;
    setSentinelNode(node);
  }, []);

  const scroller = useCallback(
    () =>
      sentinelRef.current?.closest('[data-enso="secretary-panel-scroll"]') as HTMLElement | null,
    []
  );

  const atTop = useCallback(() => {
    const node = scroller();
    if (!node) return true;
    return (node.scrollTop || 0) <= TOP_SLACK;
  }, [scroller]);

  const pullHead = useCallback(async () => {
    const seq = ++headSeq.current;
    const known = new Set(eventsRef.current.map((event) => event.id));
    const collected: FeedEvent[] = [];
    let before: FeedCursor | undefined;
    let hasMore = false;
    for (let guard = 0; guard < 20; guard += 1) {
      const result = await window.electronAPI.secretary.feed({
        ...(before ? { before } : {}),
        limit: FEED_PAGE_SIZE,
      });
      if (seq !== headSeq.current) return;
      if (!result.ok) {
        if (!readyRef.current) setLoading(false);
        return;
      }
      collected.push(...result.events);
      hasMore = result.hasMore;
      const overlap = result.events.some((event) => known.has(event.id));
      if (known.size === 0 || overlap || !hasMore || result.events.length === 0) break;
      const oldest = result.events.at(-1);
      if (!oldest) break;
      before = { at: oldest.at, id: oldest.id };
    }
    if (seq !== headSeq.current) return;
    const insert = atTop();
    const wasEmpty = eventsRef.current.length === 0;
    // setState 的更新函数要等渲染才跑，不能靠它带回 pending。
    const preview = mergeFeedHead(eventsRef.current, collected, insert);
    freshRef.current = insert ? [] : preview.pending;
    setFreshCount(freshRef.current.length);
    setEvents((loaded) => mergeFeedHead(loaded, collected, insert).events);
    if (wasEmpty) {
      const oldest = collected.at(-1);
      if (oldest) cursorRef.current = { at: oldest.at, id: oldest.id };
      exhaustedRef.current = !hasMore;
      setExhausted(!hasMore);
    }
    if (!readyRef.current) {
      readyRef.current = true;
      setReady(true);
      setLoading(false);
    }
  }, [atTop]);

  const pullOlder = useCallback(async () => {
    const before = cursorRef.current;
    if (!before || loadingRef.current || exhaustedRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const result = await window.electronAPI.secretary.feed({
        before,
        limit: FEED_PAGE_SIZE,
      });
      if (!result.ok) return;
      setEvents((loaded) => appendFeedPage(loaded, result.events));
      const oldest = result.events.at(-1);
      if (oldest) cursorRef.current = { at: oldest.at, id: oldest.id };
      exhaustedRef.current = !result.hasMore;
      setExhausted(!result.hasMore);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      if (alive) void pullHead();
    };
    refresh();
    const off = window.electronAPI.secretary.onStateChanged(refresh);
    return () => {
      alive = false;
      off();
    };
  }, [pullHead]);

  useEffect(() => {
    const node = sentinelNode;
    const root = scroller();
    if (!node || !root || !ready || exhausted || typeof IntersectionObserver !== 'function') {
      return;
    }
    const loadIfNear = () => {
      const rootBox = root.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      if (rootBox.height > 0 && box.top <= rootBox.bottom + 80) void pullOlder();
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void pullOlder();
      },
      { root, rootMargin: '80px' }
    );
    observer.observe(node);
    root.addEventListener('scroll', loadIfNear, { passive: true });
    return () => {
      observer.disconnect();
      root.removeEventListener('scroll', loadIfNear);
    };
  }, [exhausted, pullOlder, ready, scroller, sentinelNode]);

  const reveal = () => {
    const pending = freshRef.current;
    if (pending.length === 0) return;
    setEvents((loaded) => mergeFeedHead(loaded, pending, true).events);
    freshRef.current = [];
    setFreshCount(0);
    const node = scroller();
    if (node) node.scrollTop = 0;
  };

  return { events, freshCount, loading, exhausted, sentinelRef: setSentinel, reveal };
}
