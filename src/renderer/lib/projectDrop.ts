export const MAX_DROPPED_PROJECTS = 10;

export type DroppedPath = {
  path: string;
  isDirectory: boolean;
};

export type PickDroppedDirectoriesResult = {
  directories: string[];
  skippedFiles: number;
  truncated: boolean;
};

/** 去空、去重、只留目录标记，最多 10 个。是否真目录由调用方标记（webkit entry / Main stat）。 */
export function pickDroppedDirectories(
  paths: readonly DroppedPath[]
): PickDroppedDirectoriesResult {
  const seen = new Set<string>();
  const directories: string[] = [];
  let skippedFiles = 0;
  let uniqueDirs = 0;
  for (const entry of paths) {
    const path = entry.path.trim();
    if (!path) continue;
    if (!entry.isDirectory) {
      skippedFiles += 1;
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    uniqueDirs += 1;
    if (directories.length < MAX_DROPPED_PROJECTS) directories.push(path);
  }
  return {
    directories,
    skippedFiles,
    truncated: uniqueDirs > MAX_DROPPED_PROJECTS,
  };
}

export type ProjectDropItemHint = {
  kind?: string;
  isDirectory?: boolean;
};

/** 全窗 overlay 是否接管这次拖入：文件-only 留给 Composer，目录才提示添加项目。 */
export function shouldOfferProjectDrop(input: {
  types: readonly string[];
  items?: readonly ProjectDropItemHint[];
}): boolean {
  if (!input.types.includes('Files')) return false;
  const fileItems = (input.items ?? []).filter((item) => item.kind !== 'string');
  if (fileItems.length === 0) return true;
  if (fileItems.some((item) => item.isDirectory === true)) return true;
  if (fileItems.every((item) => item.isDirectory === false)) return false;
  return true;
}

export type ProjectImportFocus = { kind: 'new' } | { kind: 'select'; conversationId: string };

/** 与 Sidebar handleAddProject 相同的收尾：解归档、展开、选最近会话或新建。 */
export function projectImportFollowUp(input: {
  projectId: string;
  knownIds: ReadonlySet<string>;
  archivedIds: readonly string[];
  collapsed: Readonly<Record<string, boolean>>;
  latestConversationId: string | undefined;
}): {
  archivedIds: string[];
  collapsed: Record<string, boolean>;
  focus: ProjectImportFocus;
} {
  const archivedIds = input.archivedIds.filter((id) => id !== input.projectId);
  const collapsed = { ...input.collapsed };
  const known = input.knownIds.has(input.projectId);
  if (known && collapsed[input.projectId] === true) collapsed[input.projectId] = false;
  if (known && input.latestConversationId) {
    return {
      archivedIds,
      collapsed,
      focus: { kind: 'select', conversationId: input.latestConversationId },
    };
  }
  return { archivedIds, collapsed, focus: { kind: 'new' } };
}
