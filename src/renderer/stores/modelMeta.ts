import {
  type CustomModelResolveSource,
  type ResolvedCustomModelCapabilities,
  resolveCustomModelView,
} from '@shared/modelCatalog';
import type { ModelEntry, ModelMeta, ModelMetaResult, ModelProvider } from '@shared/types';

export type { CustomModelResolveSource, ResolvedCustomModelCapabilities };
export { resolveCustomModelView };

import { useEffect } from 'react';
import { create } from 'zustand';
import { useSettingsStore } from '@/stores/settings';

/**
 * 模型元数据的 renderer 内存缓存。⛔ 不 persist、不进 settings store
 * （`docs/engineering-reference/renderer/state.md`：store 里的一切都会写进 settings.json）。
 *
 * 按 scope（`oauthAccountKey ?? provider.id`）分桶：一个服务商的结果到达只换它那一桶，
 * 订阅别的服务商的选择器不跟着重渲染。同一 scope、同一组 id 在一代缓存里只问 Main 一次
 * ——模型中心同时挂着几十个选择器，Main 侧反查是同步的，重复查询会把主进程连续占住十几秒。
 * 失效：settings.providers 引用变化、OAuth 登录 `type:'done'`。无 TTL。
 */
interface ModelMetaState {
  byScope: Record<string, Record<string, ModelMeta>>;
  generation: number;
}

const useModelMetaStore = create<ModelMetaState>(() => ({ byScope: {}, generation: 0 }));

/** 本代缓存里已发出或已拿到的查询；被拒的会删掉，下次挂载再试 */
const requested = new Set<string>();
const EMPTY_META: Record<string, ModelMeta> = {};

/** 模型目录手动刷新后丢掉无 TTL 的元数据缓存，让下一轮查询读到新窗口。 */
export function invalidateModelMeta(): void {
  requested.clear();
  useModelMetaStore.setState((state) => ({ byScope: {}, generation: state.generation + 1 }));
}

function put(scope: string, models: ModelMeta[]): void {
  useModelMetaStore.setState((state) => {
    const bucket = { ...state.byScope[scope] };
    for (const model of models) bucket[model.modelId] = model;
    return { byScope: { ...state.byScope, [scope]: bucket } };
  });
}

let cacheInvalidationBound = false;

function ensureCacheInvalidation(): void {
  if (cacheInvalidationBound) return;
  cacheInvalidationBound = true;
  useSettingsStore.subscribe((state, prev) => {
    if (state.providers !== prev.providers) invalidateModelMeta();
  });
  window.electronAPI.providers.onOauthLoginEvent((event) => {
    if (event.event.type === 'done') invalidateModelMeta();
  });
}

function scopeOf(provider: ModelProvider): string {
  return provider.oauthAccountKey ?? provider.id;
}

/**
 * 当前 provider 下 modelId → 元数据。缺键 = 尚未加载或未知，消费侧按「未知不加限制」处理。
 */
export function useModelMeta(provider: ModelProvider | undefined): Record<string, ModelMeta> {
  const scope = provider && scopeOf(provider);
  const meta = useModelMetaStore((state) => (scope ? state.byScope[scope] : undefined));
  const generation = useModelMetaStore((state) => state.generation);

  useEffect(() => {
    ensureCacheInvalidation();
  }, []);

  useEffect(() => {
    if (!provider) return;
    const modelIds = provider.models
      .filter((model) => model.enabled !== false)
      .map((model) => model.id);
    const scope = scopeOf(provider);
    // invalidate() 抬 generation，键随之变化，强制重拉
    const key = [generation, scope, ...modelIds].join('\n');
    if (requested.has(key)) return;
    requested.add(key);
    const settle = (result: ModelMetaResult | undefined) => {
      if (useModelMetaStore.getState().generation !== generation) return;
      if (result?.ok) put(scope, result.models);
      else requested.delete(key);
    };
    void window.electronAPI.providers
      .modelMeta({
        ...(provider.oauthAccountKey ? { oauthAccountKey: provider.oauthAccountKey } : {}),
        modelIds,
      })
      .then(settle, () => settle(undefined));
  }, [provider, generation]);

  return meta ?? EMPTY_META;
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
