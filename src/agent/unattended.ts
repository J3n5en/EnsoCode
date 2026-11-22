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

/** 秘书派出/跟踪的无人值守会话：ask_user 会转给秘书，提示词改为「技术细节自己定，取舍和不可逆才问」 */
export const UNATTENDED_RELAY_PROMPT = `<unattended>
This session has no human watching it. Questions you ask with ask_user go to the secretary that dispatched you, who answers them or asks the user when needed.
- Decide technical details yourself: implementation choices, either-or approaches, and anything you can infer from the code or context. Pick the most reasonable assumption, state it in one line, and keep working.
- Use ask_user for product trade-offs or preferences, unclear requirements where a wrong guess is costly, and irreversible actions (deleting data, publishing, merging to main, deleting branches, touching accounts or money). Give 2-4 options and a default_option.
- After asking, wait for the answer; do not go ahead and do it yourself meanwhile. Never ask a question in prose and stop.
- Actions that need approval are still rejected automatically. Use an approach that needs no approval, or say in your report what was blocked.
</unattended>`;

export const UNATTENDED_RELAY_ON_NOTE = `<unattended>
Unattended mode is ON: this session has no human watching it. ask_user now goes to the secretary that dispatched you; actions that need confirmation fail immediately.
Decide technical details yourself on the most reasonable assumption. Use ask_user, with 2-4 options and a default_option, only for product trade-offs, costly unclear requirements or irreversible actions, then wait for the answer.
</unattended>`;

export function unattendedPrompt(relay: boolean): string {
  return relay ? UNATTENDED_RELAY_PROMPT : UNATTENDED_PROMPT;
}

interface UnattendedState {
  autoReject: boolean;
  relay: boolean;
}

/** 无人值守 / 提问转发状态变化后该给模型的一次性提示；没有可感知的变化时不发 */
export function unattendedSwitchNote(
  prev: UnattendedState,
  next: UnattendedState
): string | undefined {
  if (!next.autoReject) return prev.autoReject ? UNATTENDED_OFF_NOTE : undefined;
  if (prev.autoReject && prev.relay === next.relay) return undefined;
  return next.relay ? UNATTENDED_RELAY_ON_NOTE : UNATTENDED_ON_NOTE;
}

/** 取出待发的一次性提示并前缀到消息上：只追加、消费一次，与 plan-mode 提示同语义 */
export function consumeUnattendedNote(state: { unattendedNote?: string }, text: string): string {
  const note = state.unattendedNote;
  if (!note) return text;
  state.unattendedNote = undefined;
  return prependTurnNote(note, text);
}
