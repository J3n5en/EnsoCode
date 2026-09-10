import { ModelIdleTimer } from '../../llama/idle';
import type { Embedder } from '../types';
import { createGgufEmbeddingProvider } from './gguf';
import { Model2VecModel } from './model2vec';
import { withPrefix } from './prefix';
import { createRemoteEmbeddingProvider, type RemoteEmbeddingOptions } from './remote';
import type { EmbeddingModelSpec, EmbeddingProvider } from './types';

export { withPrefix };

// 查询向量缓存 TTL 300s / 64 条
const QUERY_CACHE_TTL_MS = 300_000;
const QUERY_CACHE_MAX = 64;

export interface CreateProviderContext {
  modelDir: string;
  /** remote:* 必供；由接线层从既有 ModelProvider 配置取出 */
  remote?: RemoteEmbeddingOptions;
  idleMinutes?: number;
}

/**
 * 按 spec.runtime 构造运行时；`none` 返回 null（纯 FTS）。
 * modelDir / remote 凭证由接线层注入，本模块不感知 electron。
 */
export async function createEmbeddingProvider(
  spec: EmbeddingModelSpec,
  ctx: CreateProviderContext
): Promise<EmbeddingProvider | null> {
  if (spec.runtime === 'gguf' || spec.runtime === 'model2vec') {
    const load = () => createRawProvider(spec, ctx);
    let resource = await load();
    const resolvedSpec = resource!.spec;
    let queue: Promise<unknown> = Promise.resolve();
    let closed = false;
    let closing: Promise<void> | null = null;
    const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
      const run = queue.then(task, task);
      queue = run.then(
        () => {},
        () => {}
      );
      return run;
    };
    const unload = async () => {
      const previous = resource;
      resource = null;
      await previous?.close?.();
    };
    const idle = new ModelIdleTimer(() => enqueue(unload));
    idle.configure(ctx.idleMinutes);
    idle.touch();
    return {
      spec: resolvedSpec,
      setIdleMinutes: (minutes) => idle.configure(minutes),
      embed: (texts, kind) => {
        if (closed) return Promise.reject(new Error('embedding provider is closed'));
        const release = idle.acquire();
        return enqueue(async () => {
          try {
            resource ??= await load();
            return await resource!.embed(texts, kind);
          } finally {
            release();
            if (closed) idle.reset();
          }
        });
      },
      close: () => {
        closed = true;
        idle.reset();
        closing ??= enqueue(unload);
        return closing;
      },
    };
  }
  return createRawProvider(spec, ctx);
}

async function createRawProvider(
  spec: EmbeddingModelSpec,
  ctx: CreateProviderContext
): Promise<EmbeddingProvider | null> {
  if (spec.runtime === 'none') return null;
  if (spec.runtime === 'gguf') {
    return createGgufEmbeddingProvider(spec, { modelDir: ctx.modelDir });
  }
  if (spec.runtime === 'openai-compatible') {
    if (!ctx.remote) throw new Error(`embedding: ${spec.id} needs remote credentials`);
    return createRemoteEmbeddingProvider(spec, ctx.remote);
  }
  if (spec.runtime === 'model2vec') {
    const model = Model2VecModel.load(ctx.modelDir);
    if (spec.dim !== null && model.dim !== spec.dim) {
      model.close();
      throw new Error(`embedding: ${spec.id} dim ${model.dim} != registry ${spec.dim}`);
    }
    return {
      spec: { ...spec, dim: model.dim },
      embed: async (texts, kind) => texts.map((t) => model.embed(withPrefix(spec, kind, t))),
      close: () => model.close(),
    };
  }
  throw new Error(`embedding runtime not implemented: ${spec.runtime}`);
}

/** 适配 store/search 用的单文本 Embedder；只缓存 query 向量，passage 每次都算 */
export function toEmbedder(
  provider: EmbeddingProvider,
  opts: { now?: () => number } = {}
): Embedder {
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; vec: Float32Array | null }>();
  return {
    model: provider.spec.id,
    get dim() {
      return provider.spec.dim;
    },
    async embed(text, kind) {
      if (kind !== 'query') return (await provider.embed([text], kind))[0] ?? null;
      const hit = cache.get(text);
      if (hit && now() - hit.at < QUERY_CACHE_TTL_MS) {
        cache.delete(text);
        cache.set(text, hit);
        return hit.vec;
      }
      const vec = (await provider.embed([text], kind))[0] ?? null;
      if (cache.size >= QUERY_CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(text, { at: now(), vec });
      return vec;
    },
  };
}
