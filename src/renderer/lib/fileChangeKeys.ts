import type { TimelineItem } from '@/stores/sessions/timeline';

/** 真正跑完的 edit/write。无 result 的 speculative ok 不算，避免下一轮 running 时 Changes 再弹。 */
export function fileChangeKeys(timeline: TimelineItem[]): Set<string> {
  const keys = new Set<string>();
  for (const item of timeline) {
    if (item.kind !== 'tool') continue;
    if (item.name === 'apply_patch') {
      if (item.fileChanges?.length) keys.add(item.key);
      continue;
    }
    if (item.state !== 'ok') continue;
    if (item.output === null && item.durationMs === null) continue;
    if (item.name !== 'edit' && item.name !== 'write') continue;
    if (item.name === 'edit' && !(item.edits && item.edits.length > 0)) continue;
    if (item.name === 'write' && !item.writeContent) continue;
    keys.add(item.key);
  }
  return keys;
}

/** 「编辑后打开 Changes」已见 edit/write 的基线 */
export interface FileChangeBaseline {
  conversationId: string | undefined;
  historyBaseIndex: number;
  /** null = 尚未占位：没有权威正文时不能把空时间线当成历史，否则补水回来的每条都算新增 */
  seen: Set<string> | null;
}

export const INITIAL_FILE_CHANGE_BASELINE: FileChangeBaseline = {
  conversationId: undefined,
  historyBaseIndex: 0,
  seen: null,
};

/**
 * 推进基线并判定是否出现新完成的 edit/write；切换会话只记快照不报新增。
 * 时间线 key 是绝对下标，historyBaseIndex 变化（上滑分页、尾窗切全文）后同一批历史
 * 会出现新 key，须清掉重新占位。
 */
export function advanceFileChangeBaseline(
  prev: FileChangeBaseline,
  next: {
    conversationId: string | undefined;
    historyBaseIndex: number;
    /** 正文含 worker 确认过的消息（乐观回显不算） */
    authoritative: boolean;
    timeline: TimelineItem[];
  }
): { baseline: FileChangeBaseline; added: boolean } {
  const { conversationId, historyBaseIndex } = next;
  // 冷会话正文被清空时等补水后再占位
  if (!next.authoritative) {
    return { baseline: { conversationId, historyBaseIndex, seen: null }, added: false };
  }
  const sameEpoch =
    prev.conversationId === conversationId && prev.historyBaseIndex === historyBaseIndex;
  const seen = sameEpoch ? prev.seen : null;
  const keys = fileChangeKeys(next.timeline);
  const added = seen !== null && [...keys].some((key) => !seen.has(key));
  return { baseline: { conversationId, historyBaseIndex, seen: keys }, added };
}
