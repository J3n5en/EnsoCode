export const MIN_PROVIDER_MODEL_REFRESH_INTERVAL_HOURS = 1;
export const MAX_PROVIDER_MODEL_REFRESH_INTERVAL_HOURS = 168;
export const DEFAULT_PROVIDER_MODEL_REFRESH_INTERVAL_HOURS = 1;

export function isProviderModelRefreshIntervalHours(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_PROVIDER_MODEL_REFRESH_INTERVAL_HOURS &&
    value <= MAX_PROVIDER_MODEL_REFRESH_INTERVAL_HOURS
  );
}

export function normalizeProviderModelRefreshIntervalHours(value: unknown): number {
  return isProviderModelRefreshIntervalHours(value)
    ? value
    : DEFAULT_PROVIDER_MODEL_REFRESH_INTERVAL_HOURS;
}

export function hasApiKeyProviderCredentials<T extends Record<string, unknown>>(
  provider: T
): provider is T & { apiKey: string } {
  return (
    !provider.oauthAccountKey &&
    !provider.oauthProviderId &&
    !provider.oauthAccountPool &&
    typeof provider.apiKey === 'string' &&
    provider.apiKey.trim().length > 0
  );
}

/**
 * 旧开关和间隔只用于补齐既有 API Key 条目，保留有效的逐条配置。移除旧键后可安全重跑。
 *
 * The legacy switch and interval only fill existing API key entries without valid per-entry values. Removing the old fields makes this safe to rerun.
 */
export function migrateProviderModelRefreshSettings(
  state: Record<string, unknown>
): Record<string, unknown> {
  if (
    !Object.hasOwn(state, 'providerModelRefreshIntervalHours') &&
    !Object.hasOwn(state, 'autoFetchProviderModels')
  ) {
    return state;
  }
  const {
    providerModelRefreshIntervalHours: hours,
    autoFetchProviderModels: enabled,
    ...next
  } = state;
  if (Array.isArray(state.providers)) {
    next.providers = state.providers.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const provider = entry as Record<string, unknown>;
      if (typeof provider.id !== 'string' || !hasApiKeyProviderCredentials(provider)) return entry;
      const inheritInterval =
        isProviderModelRefreshIntervalHours(hours) &&
        !isProviderModelRefreshIntervalHours(provider.modelRefreshIntervalHours);
      const inheritSwitch =
        typeof enabled === 'boolean' && typeof provider.autoFetchModels !== 'boolean';
      if (!inheritInterval && !inheritSwitch) return entry;
      return {
        ...provider,
        ...(inheritInterval ? { modelRefreshIntervalHours: hours } : {}),
        ...(inheritSwitch ? { autoFetchModels: enabled } : {}),
      };
    });
  }
  return next;
}
