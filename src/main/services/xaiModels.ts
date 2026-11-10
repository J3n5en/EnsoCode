import { isXaiChatModelId } from '@shared/oauthCatalog';
import type { FetchedModel } from '@shared/types';
import { listModels } from './providerApi';

export const XAI_API_BASE = 'https://api.x.ai/v1';
export const XAI_CLI_BASE = 'https://cli-chat-proxy.grok.com/v1';

const CLI_HEADERS = {
  Accept: 'application/json',
  'X-XAI-Token-Auth': 'xai-grok-cli',
};

/** Grok 订阅：官方 API + CLI 代理各拉一次，失败的一侧丢掉，不挡另一侧。 */
export async function fetchXaiSubscriptionModels(token: string): Promise<FetchedModel[]> {
  const key = token.trim();
  if (!key) return [];
  const [official, cli] = await Promise.all([
    listModels({ api: 'openai-completions', apiKey: key, baseUrl: XAI_API_BASE }),
    listModels({
      api: 'openai-completions',
      apiKey: key,
      baseUrl: XAI_CLI_BASE,
      headers: CLI_HEADERS,
    }),
  ]);
  const merged = new Map<string, FetchedModel>();
  for (const model of [...(official.ok ? official.models : []), ...(cli.ok ? cli.models : [])]) {
    if (!isXaiChatModelId(model.id) || merged.has(model.id)) continue;
    merged.set(model.id, model);
  }
  return [...merged.values()];
}
