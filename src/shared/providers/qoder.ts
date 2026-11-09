import type { PiRefreshModelsContext, ProviderConfigInput } from './piProviderTypes';
import { interactiveLogin } from './qoder/vendor/auth/login';
import { encodeQoderKey, refreshQoderToken, resolveQoderIdentity } from './qoder/vendor/auth/oauth';
import {
  getCachedModels,
  staticCnModels,
  staticModels,
  updateQoderModelsCache,
} from './qoder/vendor/catalog';
import { streamQoder } from './qoder/vendor/protocol/stream';
import { getQoderBaseUrl, type QoderMode } from './qoder/vendor/region';

export const QODER_PROVIDER_ID = 'qoder';
export const QODER_CN_PROVIDER_ID = 'qoder-cn';

export function qoderProviderConfig(mode: QoderMode = 'global'): ProviderConfigInput {
  const name = mode === 'cn' ? 'Qoder-CN' : 'Qoder';
  const fallback = mode === 'cn' ? staticCnModels : staticModels;
  const refreshModels = async (ctx: PiRefreshModelsContext) => {
    if (!process.env.PI_CODING_AGENT_DIR) return fallback;
    const credential = ctx.credential;
    const userID =
      credential?.type === 'oauth' && typeof credential.userID === 'string'
        ? credential.userID
        : '';
    const cached = (id = userID) => getCachedModels(mode, id);
    if (!ctx.allowNetwork) return cached();
    try {
      const key = credential?.type === 'oauth' ? encodeQoderKey(credential, mode) : undefined;
      if (!key) return cached();
      const ident = await resolveQoderIdentity(
        key,
        mode === 'cn' ? QODER_CN_PROVIDER_ID : QODER_PROVIDER_ID,
        mode,
        ctx.signal
      );
      await updateQoderModelsCache(
        ident.access,
        ident.userID,
        ident.name,
        ident.email,
        mode,
        ctx.signal,
        ident.machineID
      );
      return cached(ident.userID);
    } catch {
      return cached();
    }
  };
  return {
    name,
    api: 'qoder-api',
    baseUrl: getQoderBaseUrl(mode),
    models: fallback,
    refreshModels,
    streamSimple: streamQoder as unknown as ProviderConfigInput['streamSimple'],
    oauth: {
      name,
      isSubscription: true,
      login: (callbacks) => interactiveLogin(callbacks, mode),
      refreshToken: (credentials, signal) => refreshQoderToken(credentials, mode, signal),
      getApiKey: (credentials) => encodeQoderKey(credentials, mode),
    },
  };
}
