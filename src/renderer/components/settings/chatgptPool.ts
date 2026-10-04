import { isCodexAccountKey } from '@shared/oauthAccountPool';
import type { ModelProvider } from '@shared/types';
import type { TFunction } from '@/i18n';

/**
 * 按设置原顺序列出固定 ChatGPT 账号并按账号去重。停用账号仍可编辑成员关系；运行资格由后端判断。
 *
 * List fixed ChatGPT accounts in settings order, deduplicated by account. Disabled accounts remain editable; the backend decides runtime eligibility.
 */
export function chatgptPoolSources(providers: readonly ModelProvider[]): ModelProvider[] {
  const seen = new Set<string>();
  return providers.filter((provider) => {
    const key = provider.oauthAccountKey;
    if (!isCodexAccountKey(key) || provider.oauthAccountPool || provider.apiKey) {
      return false;
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 显式创建池；固定账号保持不变，首个源账号仅是目录兼容锚点，不表示运行账号。同名模型保留首源配置，任一源启用即可启用池模型。
 *
 * Create a pool explicitly; fixed accounts stay unchanged and the first source is only a catalog anchor. Duplicate models retain the first source's configuration and are enabled if any source enables them.
 */
export function createChatgptPoolProvider(
  providers: readonly ModelProvider[],
  id: string
): ModelProvider | null {
  const sources = chatgptPoolSources(providers);
  const first = sources[0];
  if (!first) return null;
  const models = new Map<string, ModelProvider['models'][number]>();
  for (const source of sources) {
    for (const model of source.models) {
      const existing = models.get(model.id);
      if (existing) {
        existing.enabled = existing.enabled !== false || model.enabled !== false;
      } else {
        models.set(model.id, { ...model, enabled: model.enabled !== false });
      }
    }
  }
  return {
    id,
    name: 'ChatGPT (automatic failover)',
    api: first.api,
    apiKey: '',
    baseUrl: '',
    enabled: true,
    oauthAccountKey: first.oauthAccountKey,
    oauthAccountPool: { accountKeys: sources.flatMap((source) => source.oauthAccountKey ?? []) },
    models: [...models.values()],
  };
}

export function providerDisplayName(provider: ModelProvider, t: TFunction): string {
  return provider.oauthAccountPool ? t('ChatGPT (automatic failover)') : provider.name;
}
