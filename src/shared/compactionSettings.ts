/** pi 的 compaction.reserveTokens：上下文 > 窗口 − 该值时触发压缩，摘要输出上限取其 80% */
export const COMPACT_RESERVE_TOKENS_DEFAULT = 16384;
/** 太小会让摘要输出上限过低而失败 */
export const COMPACT_RESERVE_TOKENS_MIN = 4096;
/** 全局值无法按模型校验；超过小窗口模型的窗口会每次请求前都压缩，故取保守上限 */
export const COMPACT_RESERVE_TOKENS_MAX = 65536;

/** null 表示不写入（跟随 pi 默认）；非法返回 undefined */
export function parseCompactReserveTokens(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= COMPACT_RESERVE_TOKENS_MIN &&
    value <= COMPACT_RESERVE_TOKENS_MAX
    ? value
    : undefined;
}

/** 设置页输入框：空白为 null（不写入），否则须为范围内的十进制整数 */
export function parseCompactReserveTokensDraft(draft: string): number | null | undefined {
  const trimmed = draft.trim();
  if (!trimmed) return null;
  return /^\d+$/.test(trimmed) ? parseCompactReserveTokens(Number(trimmed)) : undefined;
}
