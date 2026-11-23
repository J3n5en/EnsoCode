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

export type ImportProjectSessionsMode = 'move' | 'copy';

export type ProjectPairInput = { sourceProjectId: string; targetProjectId: string };

export type ImportProjectSessionsInput = ProjectPairInput & { mode: ImportProjectSessionsMode };

export type ImportProjectSessionsResult =
  | {
      ok: true;
      mode: ImportProjectSessionsMode;
      /** 移动：原会话 id；复制：新副本的根会话 id */
      imported: string[];
      skipped: { conversationId: string; error: string }[];
      /** 源项目已没有任何会话（含归档） */
      sourceEmpty: boolean;
    }
  | { ok: false; error: string };

export type ImportProjectSessionsPreview =
  | { ok: true; sourceExists: boolean; copies: number }
  | { ok: false; error: string };

export type RemoveEmptyProjectResult = { ok: true } | { ok: false; error: string };

/** 复制出的根会话行记下来源，弹窗据此提示「已复制过 N 次」 */
export type CopiedFrom = { projectId: string; conversationId: string };

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';

export function parseProjectPairInput(value: unknown): ProjectPairInput | null {
  if (!isRecord(value) || Object.keys(value).length !== 2) return null;
  const { sourceProjectId, targetProjectId } = value;
  if (!nonEmpty(sourceProjectId) || !nonEmpty(targetProjectId)) return null;
  if (sourceProjectId === targetProjectId) return null;
  return { sourceProjectId, targetProjectId };
}

export function parseImportProjectSessionsInput(value: unknown): ImportProjectSessionsInput | null {
  if (!isRecord(value) || Object.keys(value).length !== 3) return null;
  const { mode, ...pair } = value;
  if (mode !== 'move' && mode !== 'copy') return null;
  const parsed = parseProjectPairInput(pair);
  return parsed ? { ...parsed, mode } : null;
}

export function parseRemoveEmptyProjectInput(value: unknown): { projectId: string } | null {
  if (!isRecord(value) || Object.keys(value).length !== 1) return null;
  return nonEmpty(value.projectId) ? { projectId: value.projectId } : null;
}

/** 源项目目录已不在（项目挪走）时默认移动，否则默认复制 */
export function defaultImportMode(sourceExists: boolean): ImportProjectSessionsMode {
  return sourceExists ? 'copy' : 'move';
}

/** 目标项目里同一条源会话的副本最多有几份 */
export function importCopyCount(
  rows: Record<string, { projectId?: unknown; copiedFrom?: unknown } | undefined>,
  sourceProjectId: string,
  targetProjectId: string
): number {
  const counts = new Map<string, number>();
  for (const row of Object.values(rows)) {
    if (row?.projectId !== targetProjectId || !isRecord(row.copiedFrom)) continue;
    const { projectId, conversationId } = row.copiedFrom;
    if (projectId !== sourceProjectId || !nonEmpty(conversationId)) continue;
    counts.set(conversationId, (counts.get(conversationId) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

export function conversationIdsToMove(
  conversations: Record<string, { parentId?: unknown; btwParentId?: unknown } | undefined>,
  rootIds: string | readonly string[]
): string[] {
  const ids = new Set<string>(typeof rootIds === 'string' ? [rootIds] : rootIds);
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
