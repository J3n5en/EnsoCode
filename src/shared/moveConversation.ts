const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export type MoveConversationInput = {
  conversationId: string;
  targetProjectId: string;
};

export function parseMoveConversationInput(value: unknown): MoveConversationInput | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).length !== 2) return null;
  const { conversationId, targetProjectId } = value;
  if (typeof conversationId !== 'string' || conversationId.length === 0) return null;
  if (typeof targetProjectId !== 'string' || targetProjectId.length === 0) return null;
  return { conversationId, targetProjectId };
}

export function conversationIdsToMove(
  conversations: Record<string, { parentId?: unknown; btwParentId?: unknown } | undefined>,
  rootId: string
): string[] {
  const ids = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, row] of Object.entries(conversations)) {
      if (!row || ids.has(id)) continue;
      if (
        (typeof row.parentId === 'string' && ids.has(row.parentId)) ||
        (typeof row.btwParentId === 'string' && ids.has(row.btwParentId))
      ) {
        ids.add(id);
        grew = true;
      }
    }
  }
  return [...ids];
}

/** 秘书项目的会话固定在秘书里，Main 同样拒绝（source-secretary） */
export function canMoveConversationFrom<T extends { id: string; kind?: string }>(
  projects: readonly T[],
  currentProjectId: string
): boolean {
  return !projects.some(
    (project) => project.id === currentProjectId && project.kind === 'secretary'
  );
}

export function moveConversationTargets<T extends { id: string; kind?: string }>(
  projects: readonly T[],
  currentProjectId: string
): T[] {
  if (!canMoveConversationFrom(projects, currentProjectId)) return [];
  return projects.filter(
    (project) =>
      project.id !== currentProjectId && project.kind !== 'scratch' && project.kind !== 'secretary'
  );
}
