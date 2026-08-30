import type { ChatMentionCandidate, FileMentionCandidate } from '@shared/types/mentions';

/**
 * Composer 的 insertMention 出口。DndContext 在 App.tsx,而编辑器 ref 在
 * Composer 内部——用模块级注册表桥接,避免把 ref 层层上提。
 * 只有一个主 Composer,后注册覆盖先注册(切会话时重挂)。
 */

type InsertFn = (candidate: FileMentionCandidate | ChatMentionCandidate) => void;

let current: InsertFn | null = null;

export function registerComposerInsert(fn: InsertFn): () => void {
  current = fn;
  return () => {
    if (current === fn) current = null;
  };
}

export function insertComposerMention(
  candidate: FileMentionCandidate | ChatMentionCandidate
): boolean {
  if (!current) return false;
  current(candidate);
  return true;
}
