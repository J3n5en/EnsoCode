import type { PairedDevice } from '@enso/pair';

/** 配对凭据持久化。含 contentKey，故存 localStorage（浏览器沙箱内），解绑后远程失效。 */

const KEY = 'enso-phone-pairing';
/** 每会话的消息游标，用于重连增量续传 */
const CURSOR_KEY = 'enso-phone-cursors';

export function loadPairing(): PairedDevice | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PairedDevice) : null;
  } catch {
    return null;
  }
}

export function savePairing(device: PairedDevice): void {
  localStorage.setItem(KEY, JSON.stringify(device));
}

export function clearPairing(): void {
  localStorage.removeItem(KEY);
  // 游标属于旧配对：不清会让重新配对后的增量续传按旧 index 起算而漏消息
  localStorage.removeItem(CURSOR_KEY);
}

/** 每会话的消息游标，用于重连增量续传 */

export function loadCursors(): Record<string, number> {
  try {
    const raw = localStorage.getItem(CURSOR_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function saveCursor(sessionId: string, index: number): void {
  const cursors = loadCursors();
  if ((cursors[sessionId] ?? -1) >= index) return;
  cursors[sessionId] = index;
  localStorage.setItem(CURSOR_KEY, JSON.stringify(cursors));
}
