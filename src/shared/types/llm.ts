/** 模型 API 协议类型，值域对齐 pi sdk 的 Api，便于后续直接接入 */
export const MODEL_API_KINDS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'ollama',
] as const;

export type ModelApiKind = (typeof MODEL_API_KINDS)[number];

export interface ModelEntry {
  id: string;
  label?: string;
  /** 是否启用（缺省视为启用） */
  enabled?: boolean;
}

export interface ModelProvider {
  id: string;
  name: string;
  api: ModelApiKind;
  apiKey: string;
  baseUrl: string;
  enabled: boolean;
  models: ModelEntry[];
  /** 从哪个本地应用导入（手动创建时为空） */
  importedFrom?: string;
  /** pi 内置 OAuth provider id（如 'xai'）；存在即订阅条目，apiKey/baseUrl 为空 */
  oauthProviderId?: string;
}

/** provider 是否具备可用凭证（API key 或 OAuth 订阅） */
export const hasProviderCredentials = (
  provider: Pick<ModelProvider, 'apiKey' | 'oauthProviderId'>
): boolean => Boolean(provider.apiKey || provider.oauthProviderId);
