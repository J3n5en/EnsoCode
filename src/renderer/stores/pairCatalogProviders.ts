import type { ModelProvider, PairCatalogPayload } from '@shared/types';
import {
  type OauthCredentialSnapshot,
  usableProvidersForOauthSnapshot,
} from '@/stores/oauthCredentials';

/** 手机目录只收启用且凭证可用的 provider；密钥与账号 key 一律不下行。 */
export function toPairProviderEntries(
  providers: readonly ModelProvider[],
  snapshot: OauthCredentialSnapshot
): PairCatalogPayload['providers'] {
  return usableProvidersForOauthSnapshot(providers, snapshot).map((p) => ({
    id: p.id,
    name: p.name,
    models: p.models.map((m) => ({ id: m.id, ...(m.label ? { label: m.label } : {}) })),
  }));
}
