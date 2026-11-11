import type { ProjectedMessage } from '@shared/types/agent';
import type { TimelineItem } from './timeline';

export const user = (text: string): ProjectedMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

export const toolItem = (key: string, name = 'bash', edits: TimelineItem[] = []): TimelineItem =>
  ({
    kind: 'tool',
    key,
    name,
    summary: name,
    output: null,
    state: 'ok',
    edits: edits.length > 0 ? [{ oldText: 'a', newText: 'b' }] : null,
  }) as TimelineItem;

export const userItem = (key: string): TimelineItem => ({
  kind: 'user',
  key,
  text: 'q',
  images: [],
});
export const textItem = (key: string): TimelineItem => ({
  kind: 'text',
  key,
  text: 'a',
  streaming: false,
});
export const thinkingItem = (key: string): TimelineItem => ({
  kind: 'thinking',
  key,
  text: 't',
  streaming: false,
  durationMs: null,
});

/** 回答完成后立刻折。进行中的尾段不走这条。 */
export const activityOn = (_rows?: TimelineItem[], _running = false) => ({
  collapseCompletedActivity: true as const,
});

export type UserItem = Extract<TimelineItem, { kind: 'user' }>;
export const users = (items: TimelineItem[]): UserItem[] =>
  items.filter((item): item is UserItem => item.kind === 'user');
export const userByText = (items: TimelineItem[], text: string): UserItem => {
  const found = users(items).find((item) => item.text === text);
  if (!found) throw new Error(`user item not found: ${text}`);
  return found;
};
