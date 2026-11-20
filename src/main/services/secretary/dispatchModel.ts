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
