import type { ModelRef } from '@shared/types';
import type { DispatchModelRef } from '@shared/types/secretary';
import { isVirtualRef, VIRTUAL_PROVIDER_ID, type VirtualModelEntry } from '@shared/virtualModels';

interface ProviderLike {
  id: string;
  name: string;
  models: readonly { id: string; enabled?: boolean }[];
}

/** 秘书拿不到 provider 的 UUID，常按显示名传：id 对不上时按显示名唯一匹配，重名不猜 */
export function dispatchProviderId(requested: string, providers: readonly ProviderLike[]): string {
  if (providers.some((provider) => provider.id === requested)) return requested;
  const key = requested.trim().toLowerCase();
  const named = providers.filter((provider) => provider.name.trim().toLowerCase() === key);
  return named.length === 1 ? named[0].id : requested;
}

/** 拒绝时附上可用模型的精确 id，让秘书据此改正重试；单个 provider 模型过多时截断 */
export function dispatchModelChoices(
  providers: readonly ProviderLike[],
  usable: (providerId: string, modelId: string) => boolean,
  maxPerProvider = 20
): string {
  return providers
    .flatMap((provider) => {
      const ids = provider.models
        .filter((model) => model.enabled !== false && usable(provider.id, model.id))
        .map((model) => model.id);
      if (!ids.length) return [];
      const shown = ids.slice(0, maxPerProvider).join(', ');
      const more = ids.length > maxPerProvider ? ` (+${ids.length - maxPerProvider} more)` : '';
      return [`${provider.name}: providerId "${provider.id}", modelId ${shown}${more}`];
    })
    .join('\n');
}

/**
 * 虚拟模型的规范引用是 `enso-virtual` + 条目 id；providerId 不是真实 provider 而 modelId 是条目 id 时也认，
 * providerId 是 `enso-virtual` 时 modelId 还可按名称唯一匹配。其余走真实 provider 的显示名匹配。
 */
function dispatchModelRef(
  requested: ModelRef,
  providers: readonly ProviderLike[],
  virtualModels: readonly Pick<VirtualModelEntry, 'id' | 'name'>[]
): ModelRef {
  const { providerId, modelId } = requested;
  if (providers.some((provider) => provider.id === providerId)) return requested;
  if (virtualModels.some((entry) => entry.id === modelId))
    return { providerId: VIRTUAL_PROVIDER_ID, modelId };
  if (isVirtualRef(requested)) {
    const key = modelId.trim().toLowerCase();
    const named = virtualModels.filter((entry) => entry.name.trim().toLowerCase() === key);
    return named.length === 1
      ? { providerId: VIRTUAL_PROVIDER_ID, modelId: named[0].id }
      : requested;
  }
  return { providerId: dispatchProviderId(providerId, providers), modelId };
}

export interface DispatchModelDeps {
  providers: readonly ProviderLike[];
  virtualModels: readonly VirtualModelEntry[];
  /** 能否给会话主模型用（虚拟模型按成员解析），成功返回落盘用的引用 */
  resolve(ref: ModelRef): { ok: true; ref: ModelRef } | { ok: false; error: string };
  /** 真实模型能否列进可用清单 */
  usable(ref: ModelRef): boolean;
}

/** 派发指定模型：解析失败时附上可用的真实模型与虚拟模型，让秘书据此改正重试 */
export function resolveDispatchModel(
  requested: DispatchModelRef,
  deps: DispatchModelDeps
): { ok: true; model: DispatchModelRef } | { ok: false; error: string } {
  const resolved = deps.resolve(dispatchModelRef(requested, deps.providers, deps.virtualModels));
  if (resolved.ok) {
    const { thinkingLevel } = requested;
    return { ok: true, model: { ...resolved.ref, ...(thinkingLevel ? { thinkingLevel } : {}) } };
  }
  const choices = [
    dispatchModelChoices(deps.providers, (providerId, modelId) =>
      deps.usable({ providerId, modelId })
    ),
    ...deps.virtualModels
      .filter(
        (entry) =>
          entry.enabled && deps.resolve({ providerId: VIRTUAL_PROVIDER_ID, modelId: entry.id }).ok
      )
      .map(
        (entry) =>
          `${entry.name} (virtual model): providerId "${VIRTUAL_PROVIDER_ID}", modelId "${entry.id}"`
      ),
  ]
    .filter(Boolean)
    .join('\n');
  return {
    ok: false,
    error: choices
      ? `${resolved.error}. providerId must be an exact id below (not a name), or omit model to follow the project's default model:\n${choices}`
      : resolved.error,
  };
}
