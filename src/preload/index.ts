import type {
  CollectedAsset,
  CollectedProvider,
  ListModelsResult,
  LocalAssetScanResult,
  LocalProviderScanResult,
  ProviderApiConfig,
  TestProviderResult,
} from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { contextBridge, ipcRenderer } from 'electron';

const electronAPI = {
  env: {
    platform: process.platform,
  },

  settings: {
    read: (): Promise<Record<string, unknown> | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_READ),
    write: (data: Record<string, unknown>): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_WRITE, data),
    /** 其他窗口修改设置后触发，用于多窗口同步 */
    onChanged: (callback: () => void): (() => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.SETTINGS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SETTINGS_CHANGED, listener);
    },
  },

  providers: {
    scanLocal: (): Promise<LocalProviderScanResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_SCAN_LOCAL),
    collectImport: (scanId: string, candidateIds: string[]): Promise<CollectedProvider[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_COLLECT_IMPORT, scanId, candidateIds),
    listModels: (config: ProviderApiConfig): Promise<ListModelsResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_LIST_MODELS, config),
    test: (config: ProviderApiConfig, modelId?: string): Promise<TestProviderResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_TEST, config, modelId),
  },

  assets: {
    scanLocal: (): Promise<LocalAssetScanResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.ASSETS_SCAN_LOCAL),
    collectImport: (scanId: string, candidateIds: string[]): Promise<CollectedAsset[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.ASSETS_COLLECT_IMPORT, scanId, candidateIds),
  },

  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
    maximize: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MAXIMIZE),
    close: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
    isFullScreen: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_FULLSCREEN),
    setTrafficLightsVisible: (visible: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SET_TRAFFIC_LIGHTS_VISIBLE, visible),
    openSettings: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_OPEN_SETTINGS),
    onMaximizedChange: (callback: (maximized: boolean) => void): (() => void) => {
      const listener = (_: unknown, maximized: boolean) => callback(maximized);
      ipcRenderer.on(IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED, listener);
    },
    onFullScreenChange: (callback: (fullscreen: boolean) => void): (() => void) => {
      const listener = (_: unknown, fullscreen: boolean) => callback(fullscreen);
      ipcRenderer.on(IPC_CHANNELS.WINDOW_FULLSCREEN_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_FULLSCREEN_CHANGED, listener);
    },
  },
};

export type ElectronAPI = typeof electronAPI;

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
