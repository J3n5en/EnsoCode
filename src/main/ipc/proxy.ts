import { isValidProxyUrl, normalizeProxyMode } from '@shared/proxy';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import { getProxyConfig } from '../services/proxyConfig';

export function registerProxyHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PROXY_APPLY, async (_event, raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'invalid proxy settings' };
    }
    const input = raw as { mode?: unknown; customUrl?: unknown };
    const config = getProxyConfig();
    config.setProxyMode(normalizeProxyMode(input.mode));
    if (typeof input.customUrl === 'string') {
      if (input.customUrl.trim() !== '' && !isValidProxyUrl(input.customUrl)) {
        return { ok: false, error: 'invalid proxy url' };
      }
      config.setCustomProxyUrl(input.customUrl);
    }
    return { ok: await config.resolveProxy() };
  });
}
