import type { ModelProvider } from '@shared/types';
import type { AgentSessionCustomEntry } from '@shared/types/agent';

export interface SessionUsageAccount {
  providerId: string;
  modelId: string;
  accountKey: string;
}

export interface UsageAccountConversation {
  lastProviderId?: string;
  lastModelId?: string;
  customEntries?: readonly AgentSessionCustomEntry[];
}

/**
 * 普通订阅沿用固定账号；池只接受当前会话最新请求通知的完整路由身份，不回溯旧池或锚点。
 *
 * Fixed subscriptions retain their account; pools require the current session's latest request notice with exact route identity, never an older pool or anchor.
 */
export function resolveSessionUsageAccount(
  providers: readonly ModelProvider[],
  conversation: UsageAccountConversation | undefined
): SessionUsageAccount | undefined {
  if (!conversation?.lastProviderId || !conversation.lastModelId) return undefined;
  const provider = providers.find((entry) => entry.id === conversation?.lastProviderId);
  if (provider && !provider.oauthAccountPool) {
    return provider.oauthAccountKey
      ? {
          providerId: provider.id,
          modelId: conversation.lastModelId,
          accountKey: provider.oauthAccountKey,
        }
      : undefined;
  }
  const entries = conversation.customEntries ?? [];
  const latest = entries.findLast((entry) => entry.kind === 'oauth-account-selected');
  if (latest?.kind !== 'oauth-account-selected' || !latest.settingsProviderId || !latest.modelId)
    return undefined;
  if (
    conversation.lastProviderId !== latest.settingsProviderId ||
    conversation.lastModelId !== latest.modelId
  )
    return undefined;
  const actual = {
    providerId: latest.settingsProviderId,
    modelId: latest.modelId,
    accountKey: latest.accountKey,
  };
  const pool = providers.find((entry) => entry.id === actual.providerId);
  return pool?.oauthAccountPool && usageAccountKeyForProvider(pool, actual) ? actual : undefined;
}

/**
 * 菜单展示和预热共用账号边界；不具备会话实际路由证据的池不能查询锚点账号。
 *
 * Menu rendering and prefetch share the account boundary; a pool without session route evidence must not query its anchor.
 */
export function usageAccountKeyForProvider(
  provider: ModelProvider,
  activeAccount?: SessionUsageAccount
): string | undefined {
  if (!provider.oauthAccountPool) return provider.oauthAccountKey;
  return activeAccount?.providerId === provider.id &&
    provider.models.some(
      (model) => model.id === activeAccount.modelId && model.enabled !== false
    ) &&
    provider.oauthAccountPool.accountKeys.includes(activeAccount.accountKey)
    ? activeAccount.accountKey
    : undefined;
}
