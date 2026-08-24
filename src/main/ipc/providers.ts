import type { ProviderApiConfig } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
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
}
