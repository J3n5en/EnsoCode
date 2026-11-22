import { isStatusLineSegmentPinned, type StatusLineSegmentId } from '@shared/statusLine';

/** 段间距，与状态栏行的 `gap-3` 一致 */
export const STATUS_LINE_GAP_PX = 12;
/** 齿轮按钮绝对定位在右侧；居中的段位行两侧各留这么宽，任何宽度都压不到齿轮 */
export const STATUS_LINE_GEAR_RESERVE_PX = 28;

export interface StatusLineFit {
  /** 常驻显示的段 */
  inline: StatusLineSegmentId[];
  /** 悬停/聚焦时追加显示的段 */
  hoverable: StatusLineSegmentId[];
  /** 有常驻段放不下：行尾显示详情按钮，全部信息进弹层 */
  collapsed: boolean;
}

export interface StatusLineFitInput {
  /** 有值的段，按用户排序 */
  segments: readonly StatusLineSegmentId[];
  /** 每段自然宽度；缺任何一段视为尚未测量 */
  widths?: Readonly<Partial<Record<StatusLineSegmentId, number>>>;
  /** 段位行可用宽度（已扣除两侧齿轮预留） */
  available?: number;
  /** 详情按钮宽度 */
  triggerWidth?: number;
  /** 手机布局：只留详情按钮 */
  summaryOnly: boolean;
}

/**
 * 段位只整段显示或整段收起，从不压缩：常驻段按用户排序取能完整放下的前缀，
 * 放不下的连同悬停段一起收进详情弹层。尚未测量（首帧/SSR）时按桌面原样排布。
 */
export function fitStatusLine({
  segments,
  widths,
  available,
  triggerWidth = 0,
  summaryOnly,
}: StatusLineFitInput): StatusLineFit {
  if (summaryOnly) return { inline: [], hoverable: [], collapsed: true };
  const pinned = segments.filter((id, index) => isStatusLineSegmentPinned(id, index));
  const rest = segments.filter((id) => !pinned.includes(id));
  const measured = widths && available !== undefined && segments.every((id) => widths[id] != null);
  if (!measured) return { inline: pinned, hoverable: rest, collapsed: false };

  const widthOf = (ids: readonly StatusLineSegmentId[]) =>
    ids.reduce((sum, id) => sum + (widths[id] ?? 0), 0) +
    Math.max(0, ids.length - 1) * STATUS_LINE_GAP_PX;
  const prefix = (
    ids: readonly StatusLineSegmentId[],
    fits: (taken: StatusLineSegmentId[]) => boolean
  ) => {
    const taken: StatusLineSegmentId[] = [];
    for (const id of ids) {
      if (!fits([...taken, id])) break;
      taken.push(id);
    }
    return taken;
  };

  if (widthOf(pinned) <= available) {
    const hoverable = prefix(rest, (taken) => widthOf([...pinned, ...taken]) <= available);
    return { inline: pinned, hoverable, collapsed: false };
  }
  const inline = prefix(
    pinned,
    (taken) => widthOf(taken) + STATUS_LINE_GAP_PX + triggerWidth <= available
  );
  return { inline, hoverable: [], collapsed: true };
}
