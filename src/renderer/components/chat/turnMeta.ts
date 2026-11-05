import type { TimelineItem } from '@/stores/sessions/timeline';

/** 算作一轮回复内容的行 */
export const REPLY_ROW_KINDS: ReadonlySet<TimelineItem['kind']> = new Set([
  'text',
  'thinking',
  'tool',
  'tool-group',
]);
