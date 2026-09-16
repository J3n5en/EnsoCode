import { randomUUID } from 'node:crypto';
import type { Api, Provider, ProviderRequestOptions } from '@earendil-works/pi-ai';
import { withSseEofFlush } from './sseEofFlush';

type OnPayload = NonNullable<ProviderRequestOptions['onPayload']>;

/** 每次请求各有一个兜底 key；底层网络重试可以复用，但独立摘要之间不复用。 */
function routingPayload(onPayload: OnPayload | undefined): OnPayload {
  let routingKey: string | undefined;
  return async (payload, model) => {
    const replacement = await onPayload?.(payload, model);
    const body = replacement === undefined ? payload : replacement;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
    if ('prompt_cache_key' in body && body.prompt_cache_key !== undefined) return body;
    routingKey ??= randomUUID();
    return { ...body, prompt_cache_key: routingKey };
  };
}

/**
 * 部分 Responses 网关把 prompt_cache_key 同时用于 Codex 请求校验/路由。
 * Pi 的原生压缩传 cacheRetention:none 后会删掉它，导致短摘要也报
 * invalid_responses_request。只补一次性 key，不改预算、存储或缓存保留策略。
 * 同时给 fetch 补 SSE EOF 空行：openai-node 会丢掉没有 trailing blank line 的
 * 末帧 `response.completed`，表现为重试同一会话一直报 stream ended。
 * 必须包 provider 的 raw/simple 两个出口：Agent.onPayload 覆盖不到原生压缩，
 * 而仅注册自定义 streamSimple 又会改变 ModelRegistry.complete 的 raw 参数语义。
 */
function responsesOptions<T extends ProviderRequestOptions | undefined>(
  options: T
): T & {
  onPayload: OnPayload;
  fetch: typeof fetch;
} {
  return {
    ...options,
    onPayload: routingPayload(options?.onPayload),
    fetch: withSseEofFlush(options?.fetch ?? globalThis.fetch.bind(globalThis)),
  };
}

export function withOpenAIResponsesRouting(provider: Provider): Provider {
  return {
    ...provider,
    stream(model, context, options) {
      return provider.stream<Api>(
        model,
        context,
        model.api === 'openai-responses' ? responsesOptions(options) : options
      );
    },
    streamSimple(model, context, options) {
      return provider.streamSimple(
        model,
        context,
        model.api === 'openai-responses' ? responsesOptions(options) : options
      );
    },
  };
}
