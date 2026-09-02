import type { TimelineItem } from '@/stores/sessions/timeline';

/** 真正跑完的 edit/write。无 result 的 speculative ok 不算，避免下一轮 running 时 Changes 再弹。 */
export function fileChangeKeys(timeline: TimelineItem[]): Set<string> {
  const keys = new Set<string>();
  for (const item of timeline) {
    if (item.kind !== 'tool' || item.state !== 'ok') continue;
    if (item.output === null && item.durationMs === null) continue;
    if (item.name !== 'edit' && item.name !== 'write') continue;
    if (item.name === 'edit' && !(item.edits && item.edits.length > 0)) continue;
    if (item.name === 'write' && !item.writeContent) continue;
    keys.add(item.key);
  }
  return keys;
}
