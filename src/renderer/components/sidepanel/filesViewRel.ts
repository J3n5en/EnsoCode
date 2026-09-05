/**
 * Files 面板 tab 标识辅助函数。预览 tab 用 NUL 分隔的 marker（`assertEntryName`
 * 已禁止真实文件名含 NUL），与真实 rel 永不冲突，替代此前的 `#preview` 字符串拼接。
 */
const PREVIEW_MARKER = '\u0000preview';

export function toPreviewKey(rel: string): string {
  return `${rel}${PREVIEW_MARKER}`;
}

export function isPreviewKey(key: string): boolean {
  return key.endsWith(PREVIEW_MARKER);
}

export function fromPreviewKey(key: string): string {
  return isPreviewKey(key) ? key.slice(0, -PREVIEW_MARKER.length) : key;
}

function isRelOrDescendant(candidate: string, rel: string): boolean {
  return candidate === rel || candidate.startsWith(`${rel}/`);
}

/** 删除 `deletedRel`（文件或目录）后，判断某个已打开 tab（含预览 key）是否需要关闭。 */
export function shouldCloseForDelete(tabRel: string, deletedRel: string): boolean {
  return isRelOrDescendant(fromPreviewKey(tabRel), deletedRel);
}

/**
 * `fromRel` 重命名/移动为 `toRel` 后，计算某个已打开 tab（含预览 key）的新 rel。
 * 不受影响返回 null。
 */
export function remapRelForRename(tabRel: string, fromRel: string, toRel: string): string | null {
  const preview = isPreviewKey(tabRel);
  const real = fromPreviewKey(tabRel);
  let nextReal: string | null = null;
  if (real === fromRel) nextReal = toRel;
  else if (real.startsWith(`${fromRel}/`)) nextReal = toRel + real.slice(fromRel.length);
  if (nextReal == null) return null;
  return preview ? toPreviewKey(nextReal) : nextReal;
}

export type FileViewMode = 'source' | 'preview';

/** 同 tab 内 source/preview 切换：undefined 视为默认 source */
export function toggleViewMode(mode: FileViewMode | undefined): FileViewMode {
  return mode === 'preview' ? 'source' : 'preview';
}

export interface RelMutation {
  /** 递增的操作序号，重命名/删除各占一格 */
  epoch: number;
  /** 被重命名走 / 被删除的旧 rel（文件或目录） */
  rel: string;
}

/**
 * 判断 `rel`（含预览 key）在 `sinceEpoch` 之后是否被某次重命名/删除波及，用于
 * 丢弃「读盘 / 存盘异步操作完成时，路径已经失效」的过期结果，避免在已失效的
 * 旧路径上复活 tab 或写盘。
 */
export function wasPathInvalidated(
  mutations: readonly RelMutation[],
  rel: string,
  sinceEpoch: number
): boolean {
  return mutations.some((m) => m.epoch > sinceEpoch && shouldCloseForDelete(rel, m.rel));
}
