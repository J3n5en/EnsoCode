import {
  type CatalogModelEntry,
  findCatalogModelById,
  positiveFiniteNumber,
} from '@shared/modelCatalog';
import {
  findModelsDevModel,
  mergeCatalogEntry,
  withModelsDevOauthModels,
} from '@shared/modelsDevCatalog';
import { supportedProjectThinkingLevels } from '@shared/modelThinking';
import { expandOauthCatalog, mergeFetchedOauthModels } from '@shared/oauthCatalog';
import { ensureAccountProvider } from '@shared/piAccounts';
import {
  type ModelMeta,
  type ModelMetaQuery,
  type ModelMetaResult,
  providerIdOfAccountKey,
} from '@shared/types';
import { getModelsDevModels } from './modelsDevCatalog';
import { ensureProviderModelsRefreshed, getRuntime, hasStoredAccount } from './oauthProviders';
import { fetchXaiSubscriptionModels } from './xaiModels';

const XAI_PROVIDER_ID = 'xai';

function attachWindow(meta: ModelMeta, model: CatalogModelEntry): void {
  const contextWindow = positiveFiniteNumber(model.contextWindow);
  if (contextWindow !== undefined) meta.contextWindow = contextWindow;
  const maxTokens = positiveFiniteNumber(model.maxTokens);
  if (maxTokens !== undefined) meta.maxTokens = maxTokens;
}

function mapOauthModel(model: CatalogModelEntry): ModelMeta {
  const meta: ModelMeta = {
    modelId: model.id,
    reasoning: model.reasoning,
    thinkingLevels: supportedProjectThinkingLevels({
      reasoning: model.reasoning === true,
      thinkingLevelMap: model.thinkingLevelMap,
    }),
    source: 'catalog',
  };
  attachWindow(meta, model);
  return meta;
}

function mapCatalogFallback(modelId: string, catalog: CatalogModelEntry | undefined): ModelMeta {
  if (!catalog) return { modelId, source: 'unknown' };
  // 与 spawn 同表精确 id 反查：命中则带上 catalog 的 reasoning / 档位 / 窗口。
  // 行覆盖由 renderer 用 resolveCustomModelCapabilities 叠，不在这条查询里算。
  const meta: ModelMeta = { modelId, source: 'catalog-fallback' };
  if (typeof catalog.reasoning === 'boolean') {
    meta.reasoning = catalog.reasoning;
    meta.thinkingLevels = supportedProjectThinkingLevels({
      reasoning: catalog.reasoning,
      thinkingLevelMap: catalog.thinkingLevelMap,
    });
  }
  attachWindow(meta, catalog);
  return meta;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function oauthAccessToken(
  runtime: Awaited<ReturnType<typeof getRuntime>>,
  accountKey: string
): Promise<string | undefined> {
  try {
    const auth = await runtime.getAuth(accountKey);
    const token = auth?.auth.apiKey;
    return typeof token === 'string' && token.trim() ? token.trim() : undefined;
  } catch {
    return undefined;
  }
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
      // 不会抢先把 unknown 写进 renderer 的无 TTL 缓存。空 modelIds 即用户「拉取模型」，强制重拉。
      await ensureProviderModelsRefreshed(runtime, query.oauthAccountKey, {
        force: query.modelIds.length === 0,
      });
      const providerId = providerIdOfAccountKey(query.oauthAccountKey);
      let catalog = expandOauthCatalog(
        providerId,
        runtime.getModels(query.oauthAccountKey) as readonly CatalogModelEntry[]
      );
      if (providerId === XAI_PROVIDER_ID && query.modelIds.length === 0) {
        const token = await oauthAccessToken(runtime, query.oauthAccountKey);
        if (token) {
          try {
            const fetched = await fetchXaiSubscriptionModels(token);
            catalog = mergeFetchedOauthModels(
              catalog,
              fetched.map((model) => model.id)
            );
            // xAI 探测绕过 runtime，结果必须并入统一目录——否则编辑器拉取到的
            // 新模型在保存时被稀疏化丢弃、picker 也看不到（复审 Major-2）
            void import('./modelDirectory')
              .then(({ noteDiscoveredOauthModels }) =>
                noteDiscoveredOauthModels(XAI_PROVIDER_ID, fetched)
              )
              .catch(() => {});
          } catch {
            // 上游失败仍用 pi catalog + overlay，不让设置页拉取整条失败
          }
        }
      }
      catalog = withModelsDevOauthModels(providerId, catalog, getModelsDevModels());
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

    const catalog = runtime.getModels() as readonly CatalogModelEntry[];
    const devModels = getModelsDevModels();
    return {
      ok: true,
      models: query.modelIds.map((modelId) =>
        mapCatalogFallback(
          modelId,
          mergeCatalogEntry(
            findCatalogModelById(catalog, modelId),
            findModelsDevModel(devModels, modelId)
          )
        )
      ),
    };
  } catch (error) {
    return { ok: false, models: [], error: toErrorMessage(error) };
  }
}
