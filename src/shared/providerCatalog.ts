import type { ModelApiKind, ModelProvider, OauthProviderInfo } from './types';

/** 分类协议或官方分类器端点不能注册成聊天供应商，包括旧配置和手动导入。 */
export function isClassifierOnlyProvider(
  provider: Partial<Pick<ModelProvider, 'api' | 'baseUrl' | 'catalogId'>>
): boolean {
  if (provider.api === 'typesafe-system-one' || provider.catalogId === 'typesafe') return true;
  try {
    const host = new URL(provider.baseUrl ?? '').hostname.toLowerCase();
    return host === 'api.typesafe.ai' || host.endsWith('.api.typesafe.ai');
  } catch {
    return false;
  }
}

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
  // pi 的 Google SDK 在有自定义 baseUrl 时会把 apiVersion 置空，版本号必须写进地址
  'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta',
  ollama: 'http://127.0.0.1:11434',
  'typesafe-system-one': 'https://api.typesafe.ai/v1/',
};

export function withVersionSegment(base: string, segment: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.endsWith(`/${segment}`) ? trimmed : `${trimmed}/${segment}`;
}

const DEEPSEEK_HOST = 'api.deepseek.com';
const DEEPSEEK_OPENAI_BASE = 'https://api.deepseek.com';
const DEEPSEEK_ANTHROPIC_BASE = 'https://api.deepseek.com/anthropic';

function deepSeekPathSegments(baseUrl: string): string[] | null {
  try {
    const parsed = new URL(baseUrl.trim());
    if (parsed.hostname.toLowerCase() !== DEEPSEEK_HOST) return null;
    return parsed.pathname.split('/').filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * DeepSeek 官方 OpenAI / Anthropic 入口不同。表单切换 API 类型时只改官方默认地址，
 * 自定义中转不动。
 */
export function baseUrlAfterApiChange(nextApi: ModelApiKind, baseUrl: string): string {
  const segments = deepSeekPathSegments(baseUrl);
  if (!segments) return baseUrl;
  const isOpenAiPath = segments.length === 0 || (segments.length === 1 && segments[0] === 'v1');
  const isAnthropicPath = segments[0] === 'anthropic';
  if (nextApi === 'anthropic-messages' && isOpenAiPath) return DEEPSEEK_ANTHROPIC_BASE;
  if ((nextApi === 'openai-completions' || nextApi === 'openai-responses') && isAnthropicPath) {
    return DEEPSEEK_OPENAI_BASE;
  }
  return baseUrl;
}

/** 交给 pi registerProvider 的地址。Google 必须带 /v1beta，否则聊天 404、拉模型却成功。 */
export function resolvePiProviderBaseUrl(api: ModelApiKind, baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '') || DEFAULT_BASE_URLS[api];
  return api === 'google-generative-ai' ? withVersionSegment(base, 'v1beta') : base;
}

export const STATIC_PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    id: '__custom',
    label: 'Custom',
    defaultApi: 'openai-completions',
    supportsApiKey: true,
  },
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
    defaultBaseUrl: DEFAULT_BASE_URLS['google-generative-ai'],
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
    id: 'typesafe',
    label: 'TypeSafe',
    defaultApi: 'typesafe-system-one',
    defaultBaseUrl: DEFAULT_BASE_URLS['typesafe-system-one'],
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
];

/**
 * 把运行时 OAuth 能力并入静态定义；OpenAI 使用 Codex 登录，PI 原生登录独立展示。
 * 卡片 ID 只用于向导导航，实际登录保留原始 provider ID，不改变已有凭证或模型绑定。
 */
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
    const definitionId =
      oauth.id === 'openai-codex' ? 'openai' : oauth.id === 'openai' ? 'openai-chatgpt' : oauth.id;
    const existing = merged.get(definitionId);
    const label =
      oauth.id === 'openai-codex'
        ? 'OpenAI'
        : oauth.id === 'openai'
          ? 'ChatGPT (PI login)'
          : oauth.name || existing?.label || oauth.id;
    merged.set(definitionId, {
      ...(existing ?? {
        id: definitionId,
        supportsApiKey: false,
      }),
      label,
      oauthProviderId: oauth.id,
    });
  }

  return [{ ...custom }, ...merged.values()];
}
