import type { ProviderApiConfig } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import {
  cancelOauthLogin,
  listOauthProviders,
  oauthLogout,
  respondOauthPrompt,
  startOauthLogin,
} from '../services/oauthProviders';
import { listModels, testProvider } from '../services/providerApi';
import { collectImport, scanLocalProviders } from '../services/providerScan';

function toApiConfig(input: unknown): ProviderApiConfig | null {
  if (!input || typeof input !== 'object') return null;
  const { api, apiKey, baseUrl } = input as Record<string, unknown>;
  if (typeof api !== 'string' || typeof apiKey !== 'string' || typeof baseUrl !== 'string') {
    return null;
  }
  return { api: api as ProviderApiConfig['api'], apiKey, baseUrl };
}

export function registerProviderHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PROVIDERS_SCAN_LOCAL, async () => {
    return scanLocalProviders();
  });

  ipcMain.handle(
    IPC_CHANNELS.PROVIDERS_COLLECT_IMPORT,
    (_event, scanId: unknown, candidateIds: unknown) => {
      if (typeof scanId !== 'string' || !Array.isArray(candidateIds)) return [];
      return collectImport(
        scanId,
        candidateIds.filter((id): id is string => typeof id === 'string')
      );
    }
  );

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_LIST_MODELS, (_event, config: unknown) => {
    const parsed = toApiConfig(config);
    if (!parsed) return { ok: false, models: [], error: 'Invalid config' };
    return listModels(parsed);
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_TEST, (_event, config: unknown, modelId: unknown) => {
    const parsed = toApiConfig(config);
    if (!parsed) return { ok: false, latencyMs: 0, message: 'Invalid config' };
    return testProvider(parsed, typeof modelId === 'string' ? modelId : undefined);
  });

  ipcMain.handle(IPC_CHANNELS.OAUTH_PROVIDERS_LIST, () => listOauthProviders());

  ipcMain.handle(IPC_CHANNELS.OAUTH_LOGIN, (event, providerId: unknown) => {
    if (typeof providerId !== 'string') return;
    // 不 await：登录流程持续到用户完成授权，事件经 OAUTH_LOGIN_EVENT 推送
    void startOauthLogin(providerId, event.sender);
  });

  ipcMain.handle(IPC_CHANNELS.OAUTH_LOGIN_RESPOND, (_event, requestId: unknown, value: unknown) => {
    if (typeof requestId === 'string' && typeof value === 'string') {
      respondOauthPrompt(requestId, value);
    }
  });

  ipcMain.handle(IPC_CHANNELS.OAUTH_LOGIN_CANCEL, () => cancelOauthLogin());

  ipcMain.handle(IPC_CHANNELS.OAUTH_LOGOUT, (_event, providerId: unknown) => {
    if (typeof providerId !== 'string') return;
    return oauthLogout(providerId);
  });
}
