import { pickModelCapabilityOverrides } from '@shared/modelCatalog';
import { extractModelOverrides } from '@shared/modelDirectory';
import { isCodexAccountKey } from '@shared/oauthAccountPool';
import type { ModelProvider } from '@shared/types';
import type { TFunction } from '@/i18n';

/**
 * 按设置原顺序列出固定 ChatGPT 账号并按账号去重。停用账号仍可编辑成员关系；运行资格由后端判断。
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
 * 显式创建池；固定账号保持不变，首个源账号仅是目录兼容锚点，不表示运行账号。
 * 同名模型保留首源的 label/能力覆盖，任一源启用即可启用池模型。
 *
 * 稀疏覆盖语义：源条目缺行 = 缺省启用，所以「禁用」只在**所有**来源都显式
 * `enabled: false` 时成立。池条目自身同样是 OAuth 稀疏条目（读取时按锚点账号的
 * 目录分区物化），这里只产意图行，无意图的裸行不落盘。
 */
export function createChatgptPoolProvider(
  providers: readonly ModelProvider[],
  id: string
): ModelProvider | null {
  const sources = chatgptPoolSources(providers);
  const first = sources[0];
  if (!first) return null;
  const ids: string[] = [];
  for (const source of sources) {
    for (const model of source.models) {
      if (!ids.includes(model.id)) ids.push(model.id);
    }
  }
  const models: ModelProvider['models'] = [];
  for (const modelId of ids) {
    const row: ModelProvider['models'][number] = { id: modelId };
    const firstRow = first.models.find((model) => model.id === modelId);
    Object.assign(row, pickModelCapabilityOverrides(firstRow));
    if (firstRow?.label) row.label = firstRow.label;
    const allDisabled = sources.every((source) => {
      const entry = source.models.find((model) => model.id === modelId);
      return entry !== undefined && entry.enabled === false;
    });
    if (allDisabled) row.enabled = false;
    // 无意图行（如来源的冻结拷贝 {id, enabled:true}）不进池的稀疏覆盖表
    if (extractModelOverrides([row]).length > 0) models.push(row);
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
    models,
  };
}

export function providerDisplayName(provider: ModelProvider, t: TFunction): string {
  return provider.oauthAccountPool ? t('ChatGPT (automatic failover)') : provider.name;
}
