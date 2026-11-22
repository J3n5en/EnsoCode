import {
  isStatusLineSegmentPinned,
  type StatusLineSegmentId,
  statusLinePresetOf,
} from '@shared/statusLine';

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
  /** 上下文已在行内时详情按钮只剩「更多」图标，这是它的宽度；缺省同 triggerWidth */
  moreWidth?: number;
  /** 手机布局：没有悬停，所有段都按顺序争取常驻，上下文保底 */
  mobile: boolean;
}

/** 手机输入框工具栏已显示模型名：段位仍是默认预设（没改过）时状态栏不再重复，
 *  用户改过段位（含关掉再打开模型段）就按设置来 */
export function statusLineLayoutSegments(
  segments: readonly StatusLineSegmentId[],
  mobile: boolean
): readonly StatusLineSegmentId[] {
  return mobile && statusLinePresetOf(segments) === 'default'
    ? segments.filter((id) => id !== 'model')
    : segments;
}

/**
 * 段位只整段显示或整段收起，从不压缩：常驻段按用户排序取能完整放下的前缀，
 * 放不下的连同悬停段一起收进详情弹层。尚未测量（首帧/SSR）时按桌面原样排布。
 * 手机没有悬停段：全部放得下就不出详情按钮；放不下时上下文先占位，其余按顺序取前缀，
 * 连上下文都放不下就由详情按钮显示上下文百分比。
 */
export function fitStatusLine({
  segments,
  widths,
  available,
  triggerWidth = 0,
  moreWidth = triggerWidth,
  mobile,
}: StatusLineFitInput): StatusLineFit {
  const pinned = mobile
    ? [...segments]
    : segments.filter((id, index) => isStatusLineSegmentPinned(id, index));
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
  if (mobile) {
    const anchor: StatusLineSegmentId[] = segments.filter((id) => id === 'context');
    const ordered = (taken: StatusLineSegmentId[]) =>
      segments.filter((id) => anchor.includes(id) || taken.includes(id));
    const taken = prefix(
      segments.filter((id) => !anchor.includes(id)),
      (ids) => widthOf(ordered(ids)) + STATUS_LINE_GAP_PX + moreWidth <= available
    );
    const inline = ordered(taken);
    const fits = inline.length > 0 && widthOf(inline) + STATUS_LINE_GAP_PX + moreWidth <= available;
    return { inline: fits ? inline : [], hoverable: [], collapsed: true };
  }
  const inline = prefix(
    pinned,
    (taken) => widthOf(taken) + STATUS_LINE_GAP_PX + triggerWidth <= available
  );
  return { inline, hoverable: [], collapsed: true };
}
