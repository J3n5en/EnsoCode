import { AGY_PROVIDER_ID } from '@shared/agy/constants';
import { agySettingsProvider, isSessionOnlyProvider } from '@shared/agy/settings';
import { type ModelDirectorySnapshot, materializeProviders } from '@shared/modelDirectory';
import type { ModelProvider } from '@shared/types';
import { useMemo } from 'react';
import {
  usableClassifierProvidersForOauthSnapshot,
  usableProvidersForOauthSnapshot,
  useOauthCredentialStore,
} from '@/stores/oauthCredentials';
import { useSettingsStore } from '@/stores/settings';
import { agyModelsFromState, useAgyAuthStore } from '../agyAuth';
import { useModelDirectoryStore } from './index';

/** 目录未就绪时与 settings.providers 同形透传；就绪后 OAuth models 按目录合成。 */
export function useMaterializedProviders(): ModelProvider[] {
  const providers = useSettingsStore((state) => state.providers);
  const snapshot = useModelDirectoryStore((state) => state.snapshot);
  const agyStatus = useAgyAuthStore((state) => state.status);
  const agyCachedModels = useAgyAuthStore((state) => state.cachedModels);
  return useMemo(() => {
    const materialized = materializeProviders(providers, snapshot);
    if (materialized.some((provider) => provider.id === AGY_PROVIDER_ID)) return materialized;
    const agyModels = agyModelsFromState({ status: agyStatus, cachedModels: agyCachedModels });
    return [...materialized, agySettingsProvider(agyModels)];
  }, [providers, snapshot, agyStatus, agyCachedModels]);
}

/** picker / 默认模型共用口径：先物化目录，再按 OAuth 凭证筛可用条目。 */
export function useUsableProviders(): ModelProvider[] {
  const providers = useMaterializedProviders();
  const snapshot = useOauthCredentialStore((state) => state.snapshot);
  return useMemo(() => usableProvidersForOauthSnapshot(providers, snapshot), [providers, snapshot]);
}

/** 一次性请求（标题、提交信息、代审、压缩、记忆、插件）的 picker：去掉只能在会话里跑的 agy cli。 */
export function useOneShotProviders(): ModelProvider[] {
  const providers = useUsableProviders();
  return useMemo(
    () => providers.filter((provider) => !isSessionOnlyProvider(provider)),
    [providers]
  );
}

/**
 * 分类器 picker 口径：聊天可用条目 + 分类器专用供应商（如 Jev，仅需 apiKey）。
 * 与 usableClassifierProvidersForOauthSnapshot 同语义，输入换成物化后的清单。
 */
export function useUsableClassifierProviders(): ModelProvider[] {
  const providers = useMaterializedProviders();
  const snapshot = useOauthCredentialStore((state) => state.snapshot);
  return useMemo(
    () => usableClassifierProvidersForOauthSnapshot(providers, snapshot),
    [providers, snapshot]
  );
}

export function useModelDirectorySnapshot(): ModelDirectorySnapshot | undefined {
  return useModelDirectoryStore((state) => state.snapshot);
}

/** 非组件调用点（store action / 目录同步）与 hook 同一物化口径。 */
export function readMaterializedProviders(): ModelProvider[] {
  return materializeProviders(
    useSettingsStore.getState().providers,
    useModelDirectoryStore.getState().snapshot
  );
}
