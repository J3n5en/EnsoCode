import { appendFileSync, statSync, writeFileSync } from 'node:fs';

/** 追加一行带时间戳的日志；超过上限时从头写，避免无界增长。写失败静默忽略 */
export function appendCappedLog(file: string, text: string, maxBytes = 512 * 1024): void {
  const line = `[${new Date().toISOString()}] ${text}\n`;
  try {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {}
    if (size + line.length > maxBytes) writeFileSync(file, line, 'utf8');
    else appendFileSync(file, line, 'utf8');
  } catch {}
}
