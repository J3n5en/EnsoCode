import { isSessionMutedInStore, sessionMuteRootId } from '@shared/sessionMute';
import { readSettings } from '../ipc/settings';

/** 本进程里比落盘更早的开关。重启后清空，回到 settings.json。 */
const overrides = new Map<string, boolean>();

export function setSessionMuteOverride(sessionId: string, muted: boolean): void {
  const root = sessionMuteRootId(sessionId);
  if (!root) return;
  overrides.set(root, muted);
}

export function isSessionMuted(sessionId: string): boolean {
  const root = sessionMuteRootId(sessionId);
  if (!root) return false;
  const override = overrides.get(root);
  if (override !== undefined) return override;
  return isSessionMutedInStore(readSettings(), sessionId);
}

export function resetSessionMuteOverrides(): void {
  overrides.clear();
}
