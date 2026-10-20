import { type CodeViewDiffItem, type FileDiffMetadata, parseDiffFromFile } from '@pierre/diffs';
import { diffCacheKey } from './diffCacheKey';
import type { SessionChangeFile } from './sessionChanges';

interface MemoEntry {
  oldText: string;
  newText: string;
  collapsed: boolean;
  version: number;
  fileDiff: FileDiffMetadata;
}

/** 按 item id 记住上次的内容/折叠态/version；CodeView 只在 version 变时才更新 item */
export type ChangeItemMemo = Map<string, MemoEntry>;

export function buildChangeItems(
  files: SessionChangeFile[],
  collapsedIds: ReadonlySet<string>,
  memo: ChangeItemMemo,
  options: { ignoreLineEndings?: boolean } = {}
): CodeViewDiffItem[] {
  const seen = new Set<string>();
  const items = files.map((file) => {
    const id = `diff:${file.path}`;
    seen.add(id);
    const collapsed = collapsedIds.has(id);
    const prev = memo.get(id);
    const oldText = options.ignoreLineEndings ? file.oldText.replace(/\r\n/g, '\n') : file.oldText;
    const newText = options.ignoreLineEndings ? file.newText.replace(/\r\n/g, '\n') : file.newText;
    const contentChanged = !prev || prev.oldText !== oldText || prev.newText !== newText;
    const fileDiff =
      contentChanged || !prev
        ? parseDiffFromFile(
            { name: file.path, contents: oldText },
            { name: file.path, contents: newText }
          )
        : prev.fileDiff;
    if (contentChanged || !prev) fileDiff.cacheKey = diffCacheKey(file.path, oldText, newText);
    const version = !prev
      ? 0
      : contentChanged || prev.collapsed !== collapsed
        ? prev.version + 1
        : prev.version;
    memo.set(id, { oldText, newText, collapsed, version, fileDiff });
    return { id, type: 'diff' as const, fileDiff, version, collapsed };
  });
  for (const id of memo.keys()) if (!seen.has(id)) memo.delete(id);
  return items;
}
