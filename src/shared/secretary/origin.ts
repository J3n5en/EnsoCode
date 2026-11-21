import type { SecretaryCard, SecretaryState, SecretaryTakeoverView } from '../types/secretary';

export interface SecretaryOwner {
  secretaryId: string;
  /** 派发记录里的秘书会话；接管没有这个字段 */
  secretaryConversationId?: string;
}

function sessionCards(board: SecretaryState['board']): SecretaryCard[] {
  return [...board.running, ...board.needsYou, ...board.done];
}

/**
 * 会话属于哪个秘书：先看会话行上派出时写的归属，再看各秘书看板里的派发卡片，
 * 最后看各秘书的接管清单。只认带 secretaryId 的那份状态，不回退到「当前看着的秘书」。
 * 都没有就是没人管。
 */
export function secretaryOwner(
  states: Record<string, SecretaryState>,
  conversationId: string,
  recorded?: { secretaryConversationId: string; secretaryId?: string }
): SecretaryOwner | null {
  if (recorded?.secretaryId) return { secretaryId: recorded.secretaryId };
  for (const [id, state] of Object.entries(states)) {
    if (state.secretaryId && state.secretaryId !== id) continue;
    const card = sessionCards(state.board).find(
      (entry) =>
        entry.kind === 'session' && entry.conversationId === conversationId && !entry.takeover
    );
    if (card?.kind === 'session') {
      return { secretaryId: id, secretaryConversationId: card.secretaryConversationId };
    }
  }
  for (const [id, state] of Object.entries(states)) {
    if (state.secretaryId && state.secretaryId !== id) continue;
    if (state.takeovers.some((entry) => entry.conversationId === conversationId)) {
      return { secretaryId: id };
    }
  }
  return null;
}

/** 这个会话由哪个秘书接管：只在它自己的接管清单里找，不看当前聚焦的秘书 */
export function takeoverOf(
  states: Record<string, SecretaryState>,
  conversationId: string
): { secretaryId: string; takeover: SecretaryTakeoverView } | null {
  for (const [id, state] of Object.entries(states)) {
    if (state.secretaryId && state.secretaryId !== id) continue;
    const takeover = state.takeovers.find((entry) => entry.conversationId === conversationId);
    if (takeover) return { secretaryId: id, takeover };
  }
  return null;
}
