import { prependTurnNote } from '@shared/turnNotes';
/**
 * 无人值守的模型侧说明。
 *
 * 光靠「动作被拒」的工具错误压不住模型的默认行为：它只知道这一次调用失败，不知道没人在场，
 * 于是很自然地反问一句「要我继续吗」然后收尾等人。所以「没人在线」必须作为常驻前提进
 * 系统提示词（压缩也不丢），拒绝文案只是二次强化。
 */
export const UNATTENDED_PROMPT = `<unattended>
This session has no human watching it.
- Asking is not available: ask_user and any action that needs confirmation fail immediately with a "no user available" error. Nothing waits for a reply, and no answer will arrive later in this turn.
- Never ask a question in prose and stop, and never say you are waiting for approval. If you were about to ask, decide instead.
- Decide on the most reasonable assumption, state it in one line, and keep working.
- Stop only when a decision is irreversible and would change the user's data, account or money, or when the work cannot continue without it. Then say plainly which decision is needed and what you already did.
</unattended>`;

/** 开关打开时的一次性提示：前缀到下一条进入模型的消息（与 plan-mode 提示同一机制） */
export const UNATTENDED_ON_NOTE = `<unattended>
Unattended mode is ON: this session has no human watching it. ask_user and actions that need confirmation now fail immediately, so nothing waits for an answer.
Do not ask in prose and wait. Decide on the most reasonable assumption, state it, and keep going; stop only for an irreversible decision that changes the user's data, account or money.
</unattended>`;

/** 开关关闭时的一次性提示：人回来了，可以再问 */
export const UNATTENDED_OFF_NOTE = `<unattended>
Unattended mode is OFF: a human is available again. ask_user and approval requests now reach them and wait for an answer.
</unattended>`;

/** 取出待发的一次性提示并前缀到消息上：只追加、消费一次，与 plan-mode 提示同语义 */
export function consumeUnattendedNote(state: { unattendedNote?: string }, text: string): string {
  const note = state.unattendedNote;
  if (!note) return text;
  state.unattendedNote = undefined;
  return prependTurnNote(note, text);
}
