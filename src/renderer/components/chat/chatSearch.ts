import type { TimelineItem } from '@/stores/sessions/timeline';

export function matchesQuery(query: string, parts: Array<string | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return parts.some((part) => part?.toLowerCase().includes(q));
}

export interface SearchHit {
  key: string;
  nth: number;
}

export function timelineSearchHits(items: readonly TimelineItem[], query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const item of items) {
    if (item.kind !== 'user' && item.kind !== 'text') continue;
    const hay = item.text.toLowerCase();
    let from = 0;
    let nth = 0;
    for (;;) {
      const at = hay.indexOf(q, from);
      if (at === -1) break;
      hits.push({ key: item.key, nth });
      nth += 1;
      from = at + q.length;
    }
  }
  return hits;
}
