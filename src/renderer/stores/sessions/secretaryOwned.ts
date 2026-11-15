/**
 * 由秘书负责的会话：秘书派出的（会话自带 secretaryOrigin）与用户交给秘书接管的。
 * 两种的结果都推给秘书，用户不需要在侧栏被提醒，所以它们跑完不标未读。
 * 接管名单由秘书 store 写进来，避免 sessions store 反向依赖它。
 */
let takenOver: ReadonlySet<string> = new Set();

export function setTakenOverSessions(conversationIds: Iterable<string>): void {
  takenOver = new Set(conversationIds);
}

export function isSecretaryOwned(conversation: { id: string; secretaryOrigin?: unknown }): boolean {
  return conversation.secretaryOrigin !== undefined || takenOver.has(conversation.id);
}
