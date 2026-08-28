import type { ModelMetaQuery, ProviderApiConfig } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import { queryModelMeta } from '../services/modelMeta';
import {
  cancelOauthLogin,
  getOauthAccountUsage,
  listOauthProviders,
  oauthLogout,
  reopenOauthLogin,
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

// 当前最大订阅 catalog 为 155 项；256 项留出增长余量，同时把单次 IPC 的字符串载荷
// 限在 32 KiB。单个 wire id 超过 256 字符也没有现实用途，应在构造 Set/返回体前拒绝。
const MAX_MODEL_IDS = 256;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_MODEL_IDS_CHARACTERS = 32_768;

function toModelMetaQuery(input: unknown): ModelMetaQuery | null {
  if (!input || typeof input !== 'object') return null;
  const { oauthAccountKey, modelIds } = input as Record<string, unknown>;
  if (!Array.isArray(modelIds) || modelIds.length > MAX_MODEL_IDS) return null;
  let totalCharacters = 0;
  for (const id of modelIds) {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_MODEL_ID_LENGTH) return null;
    totalCharacters += id.length;
    if (totalCharacters > MAX_MODEL_IDS_CHARACTERS) return null;
  }
  const parsedModelIds = modelIds as string[];
  if (oauthAccountKey !== undefined) {
    if (
      typeof oauthAccountKey !== 'string' ||
      oauthAccountKey.length === 0 ||
      oauthAccountKey.length > MAX_MODEL_ID_LENGTH
    ) {
      return null;
    }
    return { oauthAccountKey, modelIds: parsedModelIds };
  }
  // 空数组会返回整个 catalog，只允许 service 层已授权的订阅账号使用。
  if (parsedModelIds.length === 0) return null;
  return { modelIds: parsedModelIds };
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

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_MODEL_META, (_event, query: unknown) => {
    const parsed = toModelMetaQuery(query);
    if (!parsed) return { ok: false, models: [], error: 'Invalid query' };
    return queryModelMeta(parsed);
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
  ipcMain.handle(IPC_CHANNELS.OAUTH_LOGIN_REOPEN, () => reopenOauthLogin());

  ipcMain.handle(IPC_CHANNELS.OAUTH_LOGOUT, (_event, accountKey: unknown) => {
    if (typeof accountKey !== 'string') return;
    return oauthLogout(accountKey);
  });

  ipcMain.handle(IPC_CHANNELS.OAUTH_ACCOUNT_INFO, (_event, accountKey: unknown) => {
    if (typeof accountKey !== 'string') return { key: '', windows: [], error: 'Invalid account' };
    return getOauthAccountUsage(accountKey);
  });
}
