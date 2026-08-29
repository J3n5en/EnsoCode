import type { ModelApiKind, OauthProviderInfo } from './types';

export interface ProviderDefinition {
  id: string;
  label: string;
  oauthProviderId?: string;
  defaultApi?: ModelApiKind;
  defaultBaseUrl?: string;
  supportsApiKey: boolean;
}

/** 各协议在未填写地址时的唯一默认值，向导与主进程请求共用。 */
export const DEFAULT_BASE_URLS: Readonly<Record<ModelApiKind, string>> = {
  'openai-completions': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com',
  'google-generative-ai': 'https://generativelanguage.googleapis.com',
  ollama: 'http://127.0.0.1:11434',
};

export const STATIC_PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    defaultApi: 'anthropic-messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    supportsApiKey: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    defaultApi: 'openai-responses',
    defaultBaseUrl: 'https://api.openai.com/v1',
    supportsApiKey: true,
  },
  {
    id: 'google',
    label: 'Google',
    defaultApi: 'google-generative-ai',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    supportsApiKey: true,
  },
  {
    id: 'xai',
    label: 'xAI',
    defaultApi: 'openai-completions',
    defaultBaseUrl: 'https://api.x.ai/v1',
    supportsApiKey: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultApi: 'openai-completions',
    defaultBaseUrl: 'https://api.deepseek.com',
    supportsApiKey: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultApi: 'openai-completions',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    supportsApiKey: true,
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    defaultApi: 'openai-completions',
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    supportsApiKey: true,
  },
  {
    id: 'zhipu',
    label: 'Zhipu AI',
    defaultApi: 'openai-completions',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    supportsApiKey: true,
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    defaultApi: 'openai-completions',
    defaultBaseUrl: 'https://api.minimax.chat/v1',
    supportsApiKey: true,
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    defaultApi: 'openai-completions',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    supportsApiKey: true,
  },
  {
    id: 'groq',
    label: 'Groq',
    defaultApi: 'openai-completions',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    supportsApiKey: true,
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    defaultApi: 'openai-completions',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    supportsApiKey: true,
  },
  {
    id: 'local',
    label: 'Local',
    defaultApi: 'ollama',
    defaultBaseUrl: DEFAULT_BASE_URLS.ollama,
    supportsApiKey: true,
  },
  {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    defaultApi: 'openai-completions',
    supportsApiKey: true,
  },
  {
    id: 'alibaba',
    label: 'Alibaba Cloud',
    defaultApi: 'openai-completions',
    supportsApiKey: true,
  },
  {
    id: 'volcengine',
    label: 'Volcengine',
    defaultApi: 'openai-completions',
    supportsApiKey: true,
  },
  {
    id: '__custom',
    label: 'Custom',
    defaultApi: 'openai-completions',
    supportsApiKey: true,
  },
];

/** 把运行时 OAuth 能力并入静态定义；扩展 provider 会自动出现在自定义项之前。 */
export function mergeProviderDefinitions(
  oauthProviders: readonly Pick<OauthProviderInfo, 'id' | 'name'>[]
): ProviderDefinition[] {
  const custom = STATIC_PROVIDER_DEFINITIONS.find((definition) => definition.id === '__custom');
  if (!custom) throw new Error('Provider catalog must include __custom');

  const merged = new Map(
    STATIC_PROVIDER_DEFINITIONS.filter((definition) => definition.id !== '__custom').map(
      (definition) => [definition.id, { ...definition }] as const
    )
  );

  for (const oauth of oauthProviders) {
    if (!oauth.id) continue;
    const existing = merged.get(oauth.id);
    merged.set(oauth.id, {
      ...(existing ?? {
        id: oauth.id,
        label: oauth.name || oauth.id,
        supportsApiKey: false,
      }),
      label: oauth.name || existing?.label || oauth.id,
      oauthProviderId: oauth.id,
    });
  }

  return [...merged.values(), { ...custom }];
}
