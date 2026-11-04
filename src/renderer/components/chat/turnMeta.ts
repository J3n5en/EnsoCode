import type { TimelineItem } from '@/stores/sessions/timeline';

type UserItem = Extract<TimelineItem, { kind: 'user' }>;

/** 算作一轮回复内容的行 */
export const REPLY_ROW_KINDS: ReadonlySet<TimelineItem['kind']> = new Set([
  'text',
  'thinking',
  'tool',
  'tool-group',
]);

/** 每轮回复末行的 key → 本轮用户行，回合末尾的模型与时间挂在这一行之后 */
export function turnMetaTails(rows: readonly TimelineItem[]): Map<string, UserItem> {
  const tails = new Map<string, UserItem>();
  let owner: UserItem | undefined;
  let replied = false;
  const close = (last: TimelineItem | undefined) => {
    if (!owner || !replied || !last) return;
    if (owner.replyModel || owner.replyAt !== undefined || owner.replyPrivacyMask) {
      tails.set(last.key, owner);
    }
  };
  rows.forEach((row, index) => {
    if (row.kind === 'user') {
      close(rows[index - 1]);
      owner = row.collapsed ? undefined : row;
      replied = false;
    } else if (REPLY_ROW_KINDS.has(row.kind)) {
      replied = true;
    }
  });
  close(rows.at(-1));
  return tails;
}
