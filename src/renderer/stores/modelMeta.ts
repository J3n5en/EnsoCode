import {
  type CustomModelResolveSource,
  type ResolvedCustomModelCapabilities,
  resolveCustomModelView,
} from '@shared/modelCatalog';
import type { ModelEntry, ModelMeta, ModelProvider } from '@shared/types';

export type { CustomModelResolveSource, ResolvedCustomModelCapabilities };
export { resolveCustomModelView };

import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { useSettingsStore } from '@/stores/settings';

/**
 * 模型元数据的 renderer 内存缓存。⛔ 不 persist、不进 settings store
 * （`.trellis/spec/renderer/state.md`：store 里的一切都会写进 settings.json）。
 *
 * 缓存键 `${oauthAccountKey ?? provider.id}/${modelId}`。
 * 失效：settings.providers 引用变化、OAuth 登录 `type:'done'`。无 TTL。
 */
interface ModelMetaState {
  cache: Record<string, ModelMeta>;
  generation: number;
  put: (scope: string, models: ModelMeta[]) => void;
  invalidate: () => void;
}

const useModelMetaStore = create<ModelMetaState>((set) => ({
  cache: {},
  generation: 0,
  put: (scope, models) =>
    set((state) => {
      const cache = { ...state.cache };
      for (const model of models) cache[`${scope}/${model.modelId}`] = model;
      return { cache };
    }),
  invalidate: () => set((state) => ({ cache: {}, generation: state.generation + 1 })),
}));

let cacheInvalidationBound = false;

function ensureCacheInvalidation(): void {
  if (cacheInvalidationBound) return;
  cacheInvalidationBound = true;
  useSettingsStore.subscribe((state, prev) => {
    if (state.providers !== prev.providers) useModelMetaStore.getState().invalidate();
  });
  window.electronAPI.providers.onOauthLoginEvent((event) => {
    if (event.event.type === 'done') useModelMetaStore.getState().invalidate();
  });
}

function scopeOf(provider: ModelProvider): string {
  return provider.oauthAccountKey ?? provider.id;
}

/**
 * 当前 provider 下 modelId → 元数据。缺键 = 尚未加载或未知，消费侧按「未知不加限制」处理。
 */
export function useModelMeta(provider: ModelProvider | undefined): Record<string, ModelMeta> {
  const cache = useModelMetaStore((state) => state.cache);
  const generation = useModelMetaStore((state) => state.generation);
  const put = useModelMetaStore((state) => state.put);

  useEffect(() => {
    ensureCacheInvalidation();
  }, []);

  useEffect(() => {
    if (!provider) return;
    void generation; // invalidate() 抬 generation，强制重拉
    const modelIds = provider.models
      .filter((model) => model.enabled !== false)
      .map((model) => model.id);
    let cancelled = false;
    void window.electronAPI.providers
      .modelMeta({
        ...(provider.oauthAccountKey ? { oauthAccountKey: provider.oauthAccountKey } : {}),
        modelIds,
      })
      .then((result) => {
        if (cancelled || !result.ok) return;
        put(scopeOf(provider), result.models);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, generation, put]);

  return useMemo(() => {
    if (!provider) return {};
    const prefix = `${scopeOf(provider)}/`;
    const models: Record<string, ModelMeta> = {};
    for (const [key, meta] of Object.entries(cache)) {
      if (key.startsWith(prefix)) models[meta.modelId] = meta;
    }
    return models;
  }, [cache, provider]);
}

/**
 * 自定义 apiKey 行的能力分层。OAuth 行不要用这个——订阅只读 catalog。
 * `catalogMeta` 来自 `useModelMeta`；未加载时按 catalog 未命中（乐观默认）处理。
 */
export function resolveCustomModelMeta(
  entry: ModelEntry | undefined,
  catalogMeta: ModelMeta | undefined
): ResolvedCustomModelCapabilities {
  return resolveCustomModelView(entry, catalogMeta);
}
