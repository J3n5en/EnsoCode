import { ipcMain } from '@platform';
import { isValidProxyUrl, normalizeProxyMode } from '@shared/proxy';
import { IPC_CHANNELS } from '@shared/types';
import { getProxyConfig } from '../services/proxyConfig';

/** UI（PROXY_APPLY）与本机配置 CLI 共用：把代理设置应用到会话、进程环境与 worker */
export async function applyProxySettings(raw: unknown): Promise<{ ok: boolean; error?: string }> {
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
}

export function registerProxyHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PROXY_APPLY, (_event, raw: unknown) => applyProxySettings(raw));
}
