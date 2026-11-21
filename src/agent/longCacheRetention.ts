import type { Api, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';

/**
 * 长缓存只给会话请求（带 sessionId）且走 Anthropic Messages 的模型。不用 PI_CACHE_RETENTION：
 * 它是进程级的，会让 OpenAI Responses/Completions 多发 prompt_cache_retention:24h，
 * 也会让标题、代审等一次性辅助请求按 2× 价写 1h 缓存。显式 cacheRetention（如压缩的 none）不动；
 * 模型声明不支持 1h 的也不动，免得 cache warmer 按 1h 估算。
 */
export function withLongCacheRetention<T extends SimpleStreamOptions | undefined>(
  model: Model<Api>,
  options: T,
  enabled: boolean
): T {
  if (!enabled || !options?.sessionId || options.cacheRetention !== undefined) return options;
  if (model.api !== 'anthropic-messages') return options;
  const compat = model.compat as { supportsLongCacheRetention?: boolean } | undefined;
  if (compat?.supportsLongCacheRetention === false) return options;
  return { ...options, cacheRetention: 'long' };
}

type StreamLike = (model: Model<Api>, context: never, options?: SimpleStreamOptions) => unknown;

/**
 * 包住 Agent.streamFunction（cache warmer 在其内侧读同一份 options）与 runtime 的 stream(Simple)
 * （虚拟模型在 runtime 内派发到物理模型）。每次请求读开关，切换后下一轮生效。
 */
export function installLongCacheRetention(
  target: object | undefined,
  isEnabled: () => boolean
): void {
  if (!target) return;
  const methods = target as Record<string, unknown>;
  for (const name of ['streamFunction', 'stream', 'streamSimple']) {
    const method = methods[name];
    if (typeof method !== 'function') continue;
    const original = method as StreamLike;
    methods[name] = (model: Model<Api>, context: never, options?: SimpleStreamOptions) =>
      original.call(target, model, context, withLongCacheRetention(model, options, isEnabled()));
  }
}
