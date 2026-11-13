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

export type DroppedEntry<F> = DroppedPath & { file: F };

type DropFileLike = { size: number; type: string };

export type DropDataLike<F> = {
  items?: ArrayLike<{
    kind: string;
    getAsFile(): F | null;
    webkitGetAsEntry?(): { isDirectory: boolean } | null;
  }> | null;
  files?: ArrayLike<F> | null;
};

/**
 * drop 时刻同步读取（之后 DataTransfer 即失效）。只取 kind=file 且有磁盘路径的项：
 * 链接、文本片段是 string 项，网页里拖出的图片拿不到路径，一律丢弃。
 */
export function readDroppedEntries<F extends DropFileLike>(
  data: DropDataLike<F>,
  pathFor: (file: F) => string
): DroppedEntry<F>[] {
  const safePath = (file: F) => {
    try {
      return pathFor(file).trim();
    } catch {
      return '';
    }
  };
  const guessDirectory = (file: F) => file.size === 0 && file.type === '';
  const rows: DroppedEntry<F>[] = [];
  const items = data.items;
  if (items && items.length > 0) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      const path = safePath(file);
      if (!path) continue;
      const entry = item.webkitGetAsEntry?.();
      rows.push({ path, isDirectory: entry ? entry.isDirectory : guessDirectory(file), file });
    }
    return rows;
  }
  for (const file of Array.from(data.files ?? [])) {
    const path = safePath(file);
    if (path) rows.push({ path, isDirectory: guessDirectory(file), file });
  }
  return rows;
}

export type DropPlan<F> =
  | ({ kind: 'projects' } & PickDroppedDirectoriesResult)
  | { kind: 'files'; files: F[]; names: string[] };

/** 有目录就按项目打开（混入的文件计入 skippedFiles），否则作为附件；都没有返回 null。 */
export function planDrop<F>(entries: readonly DroppedEntry<F>[]): DropPlan<F> | null {
  const picked = pickDroppedDirectories(entries);
  if (picked.directories.length > 0) return { kind: 'projects', ...picked };
  const seen = new Set<string>();
  const files: F[] = [];
  const names: string[] = [];
  for (const entry of entries) {
    const path = entry.path.trim();
    if (!path || entry.isDirectory || seen.has(path)) continue;
    seen.add(path);
    files.push(entry.file);
    names.push(path.split(/[\\/]/).filter(Boolean).at(-1) ?? path);
  }
  return files.length > 0 ? { kind: 'files', files, names } : null;
}

export const DROP_HIGHLIGHT_WATCHDOG_MS = 150;

export type DropHighlightTracker = {
  enter(hasFiles: boolean): void;
  over(hasFiles: boolean): void;
  leave(): void;
  /** drop / dragend / blur / Escape */
  cancel(): void;
  dispose(): void;
};

/**
 * 拖入高亮状态机。Chromium 先 enter 新元素再 leave 旧元素，深度归零即已离窗；
 * 窗口内 Esc 取消、贴边拖出时 leave 可能不归零，靠 dragover 看门狗兜底复位。
 */
export function createDropHighlightTracker(
  onChange: (active: boolean) => void,
  watchdogMs = DROP_HIGHLIGHT_WATCHDOG_MS
): DropHighlightTracker {
  let depth = 0;
  let active = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const reset = () => {
    stopTimer();
    depth = 0;
    if (!active) return;
    active = false;
    onChange(false);
  };
  const keepAlive = () => {
    if (!active) {
      active = true;
      onChange(true);
    }
    stopTimer();
    timer = setTimeout(reset, watchdogMs);
  };
  return {
    enter(hasFiles) {
      if (!hasFiles) return;
      depth += 1;
      keepAlive();
    },
    over(hasFiles) {
      if (!hasFiles) return;
      depth = Math.max(depth, 1);
      keepAlive();
    },
    leave() {
      if (!active) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) reset();
    },
    cancel: reset,
    dispose: stopTimer,
  };
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
