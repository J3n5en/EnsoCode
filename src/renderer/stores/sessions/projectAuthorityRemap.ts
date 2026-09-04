/** Main 合并重复项目后，把渲染层会话的 projectId 指回权威记录。 */
export function remapConversationProjectIds<T extends { projectId: string; parentId?: string }>(
  conversations: Record<string, T>,
  authority: readonly { conversationId: string; projectId: string }[]
): Record<string, T> {
  const byConversation = new Map(
    authority.map((conversation) => [conversation.conversationId, conversation.projectId])
  );
  let changed = false;
  const next: Record<string, T> = { ...conversations };
  for (const [id, conversation] of Object.entries(conversations)) {
    const projectId = byConversation.get(id);
    if (!projectId || conversation.projectId === projectId) continue;
    next[id] = { ...conversation, projectId };
    changed = true;
  }
  for (const [id, conversation] of Object.entries(next)) {
    if (!conversation.parentId) continue;
    const parent = next[conversation.parentId];
    if (!parent || conversation.projectId === parent.projectId) continue;
    next[id] = { ...conversation, projectId: parent.projectId };
    changed = true;
  }
  return changed ? next : conversations;
}
