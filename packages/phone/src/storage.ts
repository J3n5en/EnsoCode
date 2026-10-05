import type { PairedDevice } from '@enso/pair';
import { phoneOutboxStorage } from './botOutbox';
import { migrateStore, type StoredDevice } from './deviceList';
import { parseSessionId } from './launchSession';
import { phoneCache } from './sessionCache';

/**
 * 配对凭据持久化（多桌面）。含 contentKey，故存 localStorage（浏览器沙箱内），
 * 解绑后远程失效。游标与最近会话按 pairId 分命名空间，切桌面互不串。
 */

/** 旧单配对键：读到即迁移进列表键 */
const LEGACY_KEY = 'enso-phone-pairing';
const DEVICES_KEY = 'enso-phone-devices';
const ACTIVE_KEY = 'enso-phone-active-device';
/** 旧全局游标/最近会话键：迁移时归入旧配对的命名空间 */
const LEGACY_CURSOR_KEY = 'enso-phone-cursors';
const LEGACY_LAST_SESSION_KEY = 'enso-phone-last-session';

const cursorKey = (pairId: string) => `enso-phone-cursors:${pairId}`;
const lastSessionKey = (pairId: string) => `enso-phone-last-session:${pairId}`;
const lastBotChatKey = (pairId: string) => `enso-phone-last-bot-chat:${pairId}`;

export function loadDevices(): StoredDevice[] {
  const legacyRaw = localStorage.getItem(LEGACY_KEY);
  const list = migrateStore(localStorage.getItem(DEVICES_KEY), legacyRaw);
  // 旧单配对迁移落盘：游标/最近会话一并归入该台的命名空间
  if (legacyRaw && list.length > 0) {
    saveDevices(list);
    localStorage.removeItem(LEGACY_KEY);
    const pairId = list[0].pairId;
    const cursors = localStorage.getItem(LEGACY_CURSOR_KEY);
    if (cursors) {
      localStorage.setItem(cursorKey(pairId), cursors);
      localStorage.removeItem(LEGACY_CURSOR_KEY);
    }
    const last = localStorage.getItem(LEGACY_LAST_SESSION_KEY);
    if (last) {
      localStorage.setItem(lastSessionKey(pairId), last);
      localStorage.removeItem(LEGACY_LAST_SESSION_KEY);
    }
    if (!localStorage.getItem(ACTIVE_KEY)) saveActiveDeviceId(pairId);
  }
  return list;
}

export function saveDevices(devices: StoredDevice[]): void {
  localStorage.setItem(DEVICES_KEY, JSON.stringify(devices));
}

export function loadActiveDeviceId(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}

export function saveActiveDeviceId(pairId: string | null): void {
  if (pairId) localStorage.setItem(ACTIVE_KEY, pairId);
  else localStorage.removeItem(ACTIVE_KEY);
}

/** 解绑某台：顺带清掉它命名空间下的缓存、旧游标与最近会话 */
export function clearDeviceData(pairId: string): void {
  void phoneCache.clear(pairId);
  void phoneOutboxStorage.remove?.(pairId).catch(() => {});
  localStorage.removeItem(cursorKey(pairId));
  localStorage.removeItem(lastSessionKey(pairId));
  localStorage.removeItem(lastBotChatKey(pairId));
}

/** 每台桌面各自记住最近打开的会话 */

export function loadLastSession(pairId: string): string | null {
  return localStorage.getItem(lastSessionKey(pairId));
}

export function saveLastSession(pairId: string, sessionId: string | null): void {
  if (sessionId) localStorage.setItem(lastSessionKey(pairId), sessionId);
  else localStorage.removeItem(lastSessionKey(pairId));
}

export interface LastView {
  activeId: string | null;
  botChatId: string | null;
}

export function loadLastView(pairId: string | null, launchSession: string | null = null): LastView {
  return {
    activeId: launchSession ?? (pairId ? loadLastSession(pairId) : null),
    botChatId:
      !launchSession && pairId
        ? parseSessionId(localStorage.getItem(lastBotChatKey(pairId)))
        : null,
  };
}

export function saveLastView(pairId: string, view: LastView): void {
  saveLastSession(pairId, view.activeId);
  if (view.botChatId) localStorage.setItem(lastBotChatKey(pairId), view.botChatId);
  else localStorage.removeItem(lastBotChatKey(pairId));
}

/** 兼容旧调用：PairScreen 配对成功后由 App 统一走 upsert，不再单存 */
export type { PairedDevice, StoredDevice };
