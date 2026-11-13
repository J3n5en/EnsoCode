import type { ProjectedFileChange, SessionChangeSnapshots } from '@shared/types/fileChanges';

export interface EditBlock {
  oldText: string;
  newText: string;
}

export interface SessionChangeTool {
  path: string;
  edits: EditBlock[] | null;
  writeContent: string | null;
  /** apply_patch 的单个实际落盘操作；每个 path 独立一项 */
  fileChange?: ProjectedFileChange | null;
}

export interface SessionChangeFile {
  path: string;
  oldText: string;
  newText: string;
}

/** 逐项引用比较：流式重建 timeline 时 tools 内容未变则复用旧引用，避免下游读盘/解析 diff 重跑 */
export function sameTools(prev: SessionChangeTool[], next: SessionChangeTool[]): boolean {
  return (
    prev.length === next.length &&
    prev.every(
      (tool, i) =>
        tool.path === next[i].path &&
        tool.edits === next[i].edits &&
        tool.writeContent === next[i].writeContent &&
        tool.fileChange === next[i].fileChange
    )
  );
}

export function sameRecord<T>(prev: Record<string, T>, next: Record<string, T>): boolean {
  const keys = Object.keys(next);
  return keys.length === Object.keys(prev).length && keys.every((key) => prev[key] === next[key]);
}

export function reconstructOld(current: string, blocks: EditBlock[]): string | null {
  let text = current;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const { oldText, newText } = blocks[i];
    // 纯删除没有可匹配的新文本，indexOf('') 恒为 0 会把删掉的内容插到开头；
    // 只有文本已空时删除位置才唯一，其余情况放弃还原，避免错误 old 被当快照落盘。
    if (newText === '' && text !== '') return null;
    const idx = text.indexOf(newText);
    if (idx === -1) return null;
    text = text.slice(0, idx) + oldText + text.slice(idx + newText.length);
  }
  return text;
}

export function aggregateSessionChanges(input: {
  tools: SessionChangeTool[];
  snapshots: SessionChangeSnapshots;
  currentByPath: Record<string, string | null>;
}): {
  files: SessionChangeFile[];
  snapshots: SessionChangeSnapshots;
  incompletePaths?: string[];
} {
  const byPath = new Map<string, SessionChangeTool[]>();
  for (const tool of input.tools) {
    if (!tool.path) continue;
    const list = byPath.get(tool.path) ?? [];
    list.push(tool);
    byPath.set(tool.path, list);
  }

  const files: SessionChangeFile[] = [];
  const incompletePaths = new Set(
    Object.entries(input.snapshots).flatMap(([path, snapshot]) => (snapshot === null ? [path] : []))
  );
  const snapshots = { ...input.snapshots };

  for (const [path, tools] of byPath) {
    const current = input.currentByPath[path];
    const edits = tools.flatMap((tool) => tool.edits ?? []);
    const exactChanges = tools.flatMap((tool) =>
      tool.fileChange && tool.fileChange.truncated !== true ? [tool.fileChange] : []
    );
    const lastWrite = [...tools].reverse().find((tool) => tool.writeContent != null)?.writeContent;
    const firstFileChange = tools.find((tool) => tool.fileChange)?.fileChange;
    const lastOperation = [...tools]
      .reverse()
      .find((tool) => tool.fileChange || tool.writeContent != null || tool.edits?.length);
    const fallbackNew = lastOperation?.fileChange
      ? lastOperation.fileChange.truncated === true
        ? null
        : lastOperation.fileChange.newText
      : (lastOperation?.writeContent ?? null);
    const hasSnapshot = Object.hasOwn(snapshots, path);
    const snapshot = snapshots[path];

    if (!hasSnapshot && firstFileChange?.truncated === true) {
      snapshots[path] = null;
      incompletePaths.add(path);
      continue;
    }
    if (hasSnapshot && snapshot === null) {
      incompletePaths.add(path);
      continue;
    }

    let oldText: string | null =
      typeof snapshot === 'string' ? snapshot : (exactChanges[0]?.oldText ?? null);
    const newText: string | null = typeof current === 'string' ? current : fallbackNew;

    if (oldText == null) {
      if (edits.length > 0 && typeof current === 'string') {
        oldText = reconstructOld(current, edits);
      } else if (lastWrite != null && edits.length === 0) {
        oldText = '';
      }
    }

    if (newText == null && lastOperation?.fileChange?.truncated === true) {
      incompletePaths.add(path);
    }
    if (oldText == null || newText == null) continue;
    if (oldText === newText && exactChanges.length === 0) continue;

    snapshots[path] = oldText;
    files.push({ path, oldText, newText });
  }

  return {
    files,
    snapshots,
    ...(incompletePaths.size > 0 ? { incompletePaths: [...incompletePaths] } : {}),
  };
}
