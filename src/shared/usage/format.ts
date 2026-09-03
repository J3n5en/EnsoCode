/** 用量面板的数字格式化。纯函数，主进程与渲染层共用。 */

function trimOne(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

const UNITS: Array<[number, string]> = [
  [1_000_000_000, 'B'],
  [1_000_000, 'M'],
  [1_000, 'K'],
];

/** 1500000 → '1.5M'；240000 → '240K'；3.1e9 → '3.1B'；<1000 原样；四舍五入到 1000 时进位（999990 → '1M'） */
export function formatTokens(tokens: number): string {
  for (const [unit, suffix] of UNITS) {
    // 一位小数后 ≥ 999.95 会被 toFixed 进成 1000.0，那就该升一档
    if (tokens >= unit * 0.99995) return `${trimOne(tokens / unit)}${suffix}`;
  }
  return String(Math.round(tokens));
}

/** null（无定价）→ '—'；否则 '$1911.88' */
export function formatCost(cost: number | null): string {
  if (cost === null) return '—';
  return `$${cost.toFixed(2)}`;
}

/** 只按小时累加不折天：'9h 51m'；不足 1h 只显示分钟 */
export function formatDurationMs(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** 相对上期变化：'+86.4%' / '-36.9%'；上期为 0 且本期有值 → 'new'；无可比 → null */
export function formatDelta(
  prev: number | null | undefined,
  cur: number | null | undefined
): string | null {
  if (prev === null || prev === undefined || cur === null || cur === undefined) return null;
  if (prev === 0) return cur > 0 ? 'new' : null;
  const pct = ((cur - prev) / prev) * 100;
  if (Math.abs(pct) < 0.05) return '0.0%';
  const sign = pct > 0 ? '+' : '-';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}
