import {
  type ConversationsPatch,
  mergeConversationOrder,
  parseConversationsPatch,
  type SequencedConversationsPatch,
} from '@shared/conversationsPatch';
import { RUNTIME_CONVERSATION_KEYS } from './persistSnapshot';
import { isPairViewed } from './unread';

const RUNTIME_KEYS: ReadonlySet<string> = new Set(RUNTIME_CONVERSATION_KEYS);

interface PatchTarget<C> {
  conversations: Record<string, C>;
  order: string[];
  activeId: string | null;
}

export function applyConversationsPatchToState<C extends object>(
  state: PatchTarget<C>,
  patch: ConversationsPatch
): PatchTarget<C> {
  const conversations = { ...state.conversations };
  for (const id of patch.removes) delete conversations[id];
  for (const [id, row] of Object.entries(patch.upserts)) {
    const current = conversations[id];
    if (!current) {
      // 本地已删/从未有过的会话只收到字段级差量时，拼不出完整会话，丢弃
      if (typeof row.set.id !== 'string') continue;
      conversations[id] = { ...row.set, messages: [] } as C;
      continue;
    }
    const merged: Record<string, unknown> = Object.fromEntries(Object.entries(current));
    for (const key of row.unset) if (!RUNTIME_KEYS.has(key)) delete merged[key];
    for (const [key, value] of Object.entries(row.set)) {
      if (!RUNTIME_KEYS.has(key)) merged[key] = value;
    }
    // 未读是写方按自己的 activeId 判的；本端正在看就是已读，写回会把 false 同步回去
    if (merged.unread === true && (id === state.activeId || isPairViewed(id))) {
      merged.unread = false;
    }
    conversations[id] = merged as C;
  }
  const exists = (id: string) => id in conversations;
  const base = patch.order
    ? mergeConversationOrder(state.order, patch.order, exists)
    : state.order.filter(exists);
  const listed = new Set(base);
  const added = Object.keys(patch.upserts).filter((id) => exists(id) && !listed.has(id));
  const order = [...added, ...base];
  const activeId = state.activeId && !exists(state.activeId) ? (order[0] ?? null) : state.activeId;
  return { conversations, order, activeId };
}

/** 已应用补丁的序号，persist 写回时作为确认号上报给 Main */
let appliedSeq = 0;
let hydrated = false;
const buffered: SequencedConversationsPatch[] = [];

export const conversationsAppliedSeq = (): number => appliedSeq;

/** 磁盘读回的序号：之后推送的补丁都还没应用 */
export function resetConversationsAppliedSeq(seq: number): void {
  appliedSeq = seq;
}

/** 先推进确认号再返回新状态：persist 在 setState 的同步回调里读到的确认号与值一致 */
export function applySequencedConversationsPatch<C extends object>(
  state: PatchTarget<C>,
  patch: SequencedConversationsPatch
): PatchTarget<C> {
  appliedSeq = Math.max(appliedSeq, patch.seq);
  return applyConversationsPatchToState(state, patch);
}

/**
 * 水合前的补丁只缓存：水合会用磁盘值盖掉内存，丢弃等于永久丢失 Main 的插入。
 * 水合后返回补丁由调用方立即应用。
 */
export function queueConversationsPatch(value: unknown): SequencedConversationsPatch | null {
  const patch = parseConversationsPatch(value);
  if (!patch) return null;
  if (!hydrated) {
    buffered.push(patch);
    return null;
  }
  return patch;
}

export function flushBufferedConversationsPatches(): SequencedConversationsPatch[] {
  hydrated = true;
  return buffered.splice(0);
}
