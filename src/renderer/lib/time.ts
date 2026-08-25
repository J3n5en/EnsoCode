/** 相对时间：原生 Intl.RelativeTimeFormat，随 i18n locale 输出「3 分钟前 / 昨天」等 */
export function formatRelativeTime(ts: number, locale: string, now: number = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const diff = ts - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return rtf.format(0, 'second');
  if (abs < 3_600_000) return rtf.format(Math.trunc(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.trunc(diff / 3_600_000), 'hour');
  if (abs < 30 * 86_400_000) return rtf.format(Math.trunc(diff / 86_400_000), 'day');
  if (abs < 365 * 86_400_000) return rtf.format(Math.trunc(diff / (30 * 86_400_000)), 'month');
  return rtf.format(Math.trunc(diff / (365 * 86_400_000)), 'year');
}
