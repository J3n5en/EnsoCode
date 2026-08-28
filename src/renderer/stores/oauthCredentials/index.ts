import {
  isUsableModel,
  type ModelCredentialContext,
  type OauthCredentialAvailability,
} from '@shared/defaultModel';
import type { ModelProvider } from '@shared/types';
import { create } from 'zustand';

export interface OauthCredentialSnapshot {
  revision: number;
  availability: OauthCredentialAvailability;
}

interface OauthCredentialState {
  snapshot: OauthCredentialSnapshot;
}

const initialSnapshot: OauthCredentialSnapshot = {
  revision: 0,
  availability: { status: 'unloaded' },
};

/** OAuth auth.json 的 Renderer 内存快照；不得持久化进 settings.json。 */
export const useOauthCredentialStore = create<OauthCredentialState>(() => ({
  snapshot: initialSnapshot,
}));

/** 开始一次刷新并让所有 OAuth provider 立即 fail-closed。 */
export function beginOauthCredentialRefresh(): number {
  const revision = useOauthCredentialStore.getState().snapshot.revision + 1;
  useOauthCredentialStore.setState({
    snapshot: { revision, availability: { status: 'loading' } },
  });
  return revision;
}

/** 只提交当前刷新轮次；晚到的旧请求返回 false 且不覆盖新状态。 */
export function setOauthCredentialState(snapshot: OauthCredentialSnapshot): boolean {
  if (snapshot.revision !== useOauthCredentialStore.getState().snapshot.revision) return false;
  useOauthCredentialStore.setState({ snapshot });
  return true;
}

export function oauthCredentialContext(snapshot: OauthCredentialSnapshot): ModelCredentialContext {
  return { oauthCredentials: snapshot.availability };
}

/**
 * 聊天选择器与默认模型选择器共用的候选口径：条目启用、凭证真实可用、模型启用。
 * OAuth 非 ready 时只排除订阅条目，API-key 条目仍可用。
 */
export function usableProvidersForOauthSnapshot(
  providers: readonly ModelProvider[],
  snapshot: OauthCredentialSnapshot
): ModelProvider[] {
  const credentials = oauthCredentialContext(snapshot);
  const usable: ModelProvider[] = [];
  for (const provider of providers) {
    if (!provider.enabled) continue;
    const models = provider.models.filter((model) => model.enabled !== false);
    const firstModel = models[0];
    if (
      !firstModel ||
      !isUsableModel({ providerId: provider.id, modelId: firstModel.id }, providers, credentials)
    ) {
      continue;
    }
    usable.push(models.length === provider.models.length ? provider : { ...provider, models });
  }
  return usable;
}
