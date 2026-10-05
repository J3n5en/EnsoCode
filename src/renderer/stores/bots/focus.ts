/** 时间线行 key：用户消息为 `${i}`，助手消息各 part 为 `${i}-${n}`（见 buildTimeline） */
export function messageItemKey(
  items: readonly { key: string }[],
  messageIndex: number
): string | undefined {
  const exact = String(messageIndex);
  const prefix = `${exact}-`;
  return items.find((item) => item.key === exact || item.key.startsWith(prefix))?.key;
}

/** 跳到某条消息前：目标还没加载就向前翻页，翻到头仍没有则放弃 */
export function focusStep(state: {
  target: number;
  /** 已加载的最早一条（seq 或消息下标）；undefined = 还没有数据 */
  earliest: number | undefined;
  hasOlder: boolean;
  loading: boolean;
}): 'scroll' | 'load' | 'wait' | 'give-up' {
  if (state.earliest === undefined) return 'wait';
  if (state.target >= state.earliest) return 'scroll';
  if (state.loading) return 'wait';
  return state.hasOlder ? 'load' : 'give-up';
}

/**
 * 群时间线跳转：目标在已加载范围 [first, last] 内就滚动，否则直接按目标附近加载一段（不逐页前翻）。
 * range：undefined = 时间线未就绪，null = 已就绪但为空。
 */
export function windowFocusStep(state: {
  target: number;
  range: readonly [number, number] | null | undefined;
  loading: boolean;
  /** 本次跳转已按窗口加载过 */
  jumped: boolean;
}): 'scroll' | 'jump' | 'wait' | 'give-up' {
  if (state.range === undefined || state.loading) return 'wait';
  if (state.range && state.target >= state.range[0] && state.target <= state.range[1])
    return 'scroll';
  return state.jumped ? 'give-up' : 'jump';
}

/** 搜索片段按 Main 返回的命中区间切分（区间须递增、不重叠、不越界） */
export function snippetParts(
  snippet: string,
  ranges: readonly (readonly [number, number])[]
): { text: string; match: boolean }[] {
  const parts: { text: string; match: boolean }[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor || end <= start || end > snippet.length) continue;
    if (start > cursor) parts.push({ text: snippet.slice(cursor, start), match: false });
    parts.push({ text: snippet.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < snippet.length) parts.push({ text: snippet.slice(cursor), match: false });
  return parts;
}
