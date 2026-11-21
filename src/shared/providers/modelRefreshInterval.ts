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
