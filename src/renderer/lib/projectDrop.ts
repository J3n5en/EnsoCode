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

export type DropZones = { project: boolean; attach: boolean };

/**
 * 拖动中只能读到 item 的 kind/type，读不到 entry。目录的 type 恒为空，
 * 所以全部带 MIME 的必是文件，只给「引用」；有空 type 或读不到列表时两个都给。
 */
export function dropZonesFor(input: {
  types: readonly string[];
  items: readonly { kind: string; type: string }[];
  composerReady: boolean;
}): DropZones {
  if (!input.types.includes('Files')) return { project: false, attach: false };
  const files = input.items.filter((item) => item.kind === 'file');
  return {
    project: files.length === 0 || files.some((item) => item.type === ''),
    attach: input.composerReady,
  };
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
