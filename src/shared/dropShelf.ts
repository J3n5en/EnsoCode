/** 拖放浮窗（实验功能，仅 macOS）：Finder 拖文件时在屏幕右上角弹出投放区 */

export const DROP_SHELF_MAX_PATHS = 50;

/** 投到浮窗哪个区域：引用到当前会话 / 作为项目打开 */
export type DropShelfAction = 'attach' | 'project';

export interface DropShelfDelivery {
  action: DropShelfAction;
  paths: string[];
  /** 投到「新建项目」但不是文件夹、被剔掉的条目数 */
  skipped?: number;
}

/** single 只有「引用」；拖的是文件夹（或读不到内容）时给出「引用 / 新建项目」二选一 */
export type DropShelfLayout = 'single' | 'choice';

export function dropShelfLayout(isDirectory: readonly boolean[] | null): DropShelfLayout {
  if (!isDirectory || isDirectory.length === 0 || isDirectory.some(Boolean)) return 'choice';
  return 'single';
}

export interface DragWatchState {
  /** 上次看到的 NSDragPboard changeCount */
  count: number;
  dragging: boolean;
}

export interface DragSample {
  count: number;
  mouseDown: boolean;
  /** 本应用处于前台：拖放由主窗口自己的遮罩处理 */
  appActive: boolean;
  /** 读拖放剪贴板类型；只在计数变化时调用 */
  hasFiles: () => boolean;
}

export function stepDragWatch(
  state: DragWatchState,
  sample: DragSample
): { state: DragWatchState; event: 'start' | 'end' | null } {
  if (
    !state.dragging &&
    sample.count !== state.count &&
    sample.mouseDown &&
    !sample.appActive &&
    sample.hasFiles()
  ) {
    return { state: { count: sample.count, dragging: true }, event: 'start' };
  }
  if (state.dragging && !sample.mouseDown) {
    return { state: { count: sample.count, dragging: false }, event: 'end' };
  }
  return { state: { count: sample.count, dragging: state.dragging }, event: null };
}

export function parseDropShelfPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const paths = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string' || !item.startsWith('/') || item.includes('\0')) continue;
    paths.add(item);
    if (paths.size >= DROP_SHELF_MAX_PATHS) break;
  }
  return [...paths];
}

export function parseDropShelfDrop(raw: unknown): DropShelfDelivery | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { action, paths } = raw as { action?: unknown; paths?: unknown };
  if (action !== 'attach' && action !== 'project') return null;
  const parsed = parseDropShelfPaths(paths);
  return parsed.length > 0 ? { action, paths: parsed } : null;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function dropShelfBounds(
  workArea: Rect,
  size: { width: number; height: number },
  margin: number
): Rect {
  return {
    x: workArea.x + workArea.width - size.width - margin,
    y: workArea.y + margin,
    width: size.width,
    height: size.height,
  };
}
