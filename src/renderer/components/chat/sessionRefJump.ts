/** chat 引用卡片按 sessionFile 找会话；找不到（已删除、别的机器）时卡片保持不可点 */
export function conversationIdBySessionFile(
  conversations: Record<string, { sessionFile?: string } | undefined>,
  sessionFile: string
): string | null {
  if (!sessionFile) return null;
  for (const [id, conversation] of Object.entries(conversations)) {
    if (conversation?.sessionFile === sessionFile) return id;
  }
  return null;
}
