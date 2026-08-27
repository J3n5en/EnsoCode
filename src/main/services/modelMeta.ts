import { supportedProjectThinkingLevels } from '@shared/modelThinking';
import { ensureAccountProvider } from '@shared/piAccounts';
import type { ModelMeta, ModelMetaQuery, ModelMetaResult } from '@shared/types';
import { ensureProviderModelsRefreshed, getRuntime, hasStoredAccount } from './oauthProviders';

type CatalogEntry = {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null | undefined>;
};

/**
 * 与 `supervisor.ts` 的 `positiveContextWindow` 同口径：非正 / 非有限视为缺失。
 * 未知不得用 128K 凑数——那是 spawn 的运行时兜底，不是元数据。
 */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function attachWindow(meta: ModelMeta, model: CatalogEntry): void {
  const contextWindow = positiveNumber(model.contextWindow);
  if (contextWindow !== undefined) meta.contextWindow = contextWindow;
  const maxTokens = positiveNumber(model.maxTokens);
  if (maxTokens !== undefined) meta.maxTokens = maxTokens;
}

function mapOauthModel(model: CatalogEntry): ModelMeta {
  const meta: ModelMeta = {
    modelId: model.id,
    reasoning: model.reasoning,
    thinkingLevels: supportedProjectThinkingLevels(model),
    source: 'catalog',
  };
  attachWindow(meta, model);
  return meta;
}

function mapCatalogFallback(modelId: string, catalog: CatalogEntry | undefined): ModelMeta {
  if (!catalog) return { modelId, source: 'unknown' };
  // 自定义 API 命中 catalog 只借窗口；reasoning / thinkingLevels 留给「未知」——
  // spawn 走的是硬编码 reasoning:true + {max:'max'}，报 catalog 档会和线上不一致。
  const meta: ModelMeta = { modelId, source: 'catalog-fallback' };
  attachWindow(meta, catalog);
  return meta;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 按订阅账号或裸 model id 反查 pi catalog，产出 UI 用的模型元数据 */
export async function queryModelMeta(query: ModelMetaQuery): Promise<ModelMetaResult> {
  try {
    const runtime = await getRuntime();
    if (query.oauthAccountKey) {
      // 账号存在性必须在 service 层授权；IPC 只能校验形状。先查凭证再注册克隆，
      // 避免失陷 renderer 用任意 `<base>#<n>` 让 Main 无界扩张 provider 注册表。
      if (!(await hasStoredAccount(runtime, query.oauthAccountKey))) {
        return { ok: false, models: [], error: 'Invalid query' };
      }
      ensureAccountProvider(runtime, query.oauthAccountKey);
      // getRuntime 在后台预热扩展 catalog；这里 await 同一份 promise，保证冷启动首查
      // 不会抢先把 unknown 写进 renderer 的无 TTL 缓存。
      await ensureProviderModelsRefreshed(runtime, query.oauthAccountKey);
      const catalog = runtime.getModels(query.oauthAccountKey) as readonly CatalogEntry[];
      const wanted = query.modelIds.length === 0 ? null : new Set(query.modelIds);
      const models: ModelMeta[] = [];
      const seen = new Set<string>();
      for (const model of catalog) {
        if (wanted && !wanted.has(model.id)) continue;
        seen.add(model.id);
        models.push(mapOauthModel(model));
      }
      if (wanted) {
        for (const modelId of query.modelIds) {
          if (!seen.has(modelId)) models.push({ modelId, source: 'unknown' });
        }
      }
      return { ok: true, models };
    }

    // 空 modelIds 是“列出整个订阅 catalog”，没有已授权账号时禁止走这条无界返回路径。
    if (query.modelIds.length === 0) {
      return { ok: false, models: [], error: 'Invalid query' };
    }

    const catalog = runtime.getModels() as readonly CatalogEntry[];
    return {
      ok: true,
      models: query.modelIds.map((modelId) =>
        mapCatalogFallback(
          modelId,
          catalog.find((entry) => entry.id === modelId)
        )
      ),
    };
  } catch (error) {
    return { ok: false, models: [], error: toErrorMessage(error) };
  }
}
