import type { BotChat } from '@shared/types/bot';
import type { SessionProjection } from '@/stores/sessions/reducer';

/** 群聊按时间线 seq；私聊按当前会话的绝对消息数（新对话换 key 从零计） */
export function readKey(chat: Pick<BotChat, 'id' | 'kind'>, conversationId?: string): string {
  return chat.kind === 'group' ? chat.id : `${chat.id}:${conversationId ?? ''}`;
}

export function directMarker(projection: SessionProjection | undefined): number {
  if (!projection) return 0;
  const confirmed = projection.messages.filter((message) => !message.optimistic).length;
  return (projection.historyBaseIndex ?? 0) + confirmed;
}

export function isUnread(marker: number, read: number | undefined): boolean {
  return marker > (read ?? 0);
}

/** 群聊已读记号：历史窗口里只推进到已加载的末尾，不回退已有记号（窗口外的新消息仍算未读） */
export function groupReadMark(
  timeline: { entries: readonly { seq: number }[]; lastSeq: number; history?: unknown } | undefined,
  read: number | undefined
): number {
  if (!timeline?.history) return timeline?.lastSeq ?? 0;
  return Math.max(read ?? 0, timeline.entries.at(-1)?.seq ?? 0);
}

/** 手动标为未读：已读记号退回一格；还没有任何活动时返回 undefined */
export function unreadMark(marker: number): number | undefined {
  return marker > 0 ? marker - 1 : undefined;
}

/** 首次使用（无任何记录）时当前活动全部视为已读 */
export function seedReadMarks(
  marks: Record<string, number> | null,
  markers: Record<string, number>
): Record<string, number> {
  return marks ?? { ...markers };
}
