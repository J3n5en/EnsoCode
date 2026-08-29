import type { ProviderDefinition } from '@shared/providerCatalog';
import type { ProviderApiFormValue } from './ProviderApiForm';

export type ProviderSetupMethod = 'oauth' | 'api-key';

export function availableProviderSetupMethods(
  definition: ProviderDefinition
): ProviderSetupMethod[] {
  const methods: ProviderSetupMethod[] = [];
  if (definition.oauthProviderId) methods.push('oauth');
  if (definition.supportsApiKey) methods.push('api-key');
  return methods;
}

export function initialProviderApiValue(definition: ProviderDefinition): ProviderApiFormValue {
  return {
    name: definition.id === '__custom' ? '' : definition.label,
    api: definition.defaultApi ?? 'openai-completions',
    apiKey: '',
    baseUrl: definition.defaultBaseUrl ?? '',
    models: [],
  };
}
