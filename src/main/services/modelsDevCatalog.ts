import { join } from 'node:path';
import { app, net } from '@platform';
import { readModelsDevCache, writeModelsDevCache } from '@shared/modelsDevCacheFile';
import {
  MODELS_DEV_CACHE_NAME,
  MODELS_DEV_TTL_MS,
  MODELS_DEV_URL,
  type ModelsDevCache,
  type ModelsDevModel,
  modelsDevIsFresh,
  parseModelsDevPayload,
} from '@shared/modelsDevCatalog';
import type { ModelCatalogRefreshResult } from '@shared/types';

const FETCH_TIMEOUT_MS = 15_000;
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const MAX_BYTES = 32 * 1024 * 1024;

export interface ModelsDevFetchResult {
  status: number;
  etag?: string;
  body?: string;
}

function refreshResult(
  cache: ModelsDevCache | undefined,
  ok: boolean,
  fromCache: boolean,
  error?: string
): ModelCatalogRefreshResult {
  return {
    ok,
    modelCount: cache?.models.length ?? 0,
    ...(cache ? { fetchedAt: cache.fetchedAt } : {}),
    fromCache,
    ...(error ? { error } : {}),
  };
}

function failed(
  previous: ModelsDevCache | undefined,
  error: string
): { cache: ModelsDevCache | undefined; result: ModelCatalogRefreshResult } {
  return { cache: previous, result: refreshResult(previous, false, previous !== undefined, error) };
}

/**
 * 按 TTL 决定要不要打 models.dev。失败或空包不覆盖已有快照；304 只推进 fetchedAt。
 * 成功时把新快照原子写到 file。
 */
export async function runModelsDevRefresh(input: {
  file: string;
  previous: ModelsDevCache | undefined;
  now: number;
  force?: boolean;
  fetchCatalog: (request: { url: string; etag?: string }) => Promise<ModelsDevFetchResult>;
  ttlMs?: number;
  maxBytes?: number;
}): Promise<{ cache: ModelsDevCache | undefined; result: ModelCatalogRefreshResult }> {
  const previous = input.previous;
  if (!input.force && modelsDevIsFresh(previous, input.now, input.ttlMs)) {
    return { cache: previous, result: refreshResult(previous, true, true) };
  }
  let response: ModelsDevFetchResult;
  try {
    response = await input.fetchCatalog({ url: MODELS_DEV_URL, etag: previous?.etag });
  } catch (error) {
    return failed(previous, error instanceof Error ? error.message : String(error));
  }
  if (response.status === 304 && previous) {
    const next: ModelsDevCache = {
      ...previous,
      fetchedAt: input.now,
      ...(response.etag ? { etag: response.etag } : {}),
    };
    try {
      writeModelsDevCache(input.file, next);
    } catch (error) {
      return failed(previous, error instanceof Error ? error.message : String(error));
    }
    return { cache: next, result: refreshResult(next, true, false) };
  }
  const maxBytes = input.maxBytes ?? MAX_BYTES;
  if (
    response.status !== 200 ||
    typeof response.body !== 'string' ||
    response.body.length > maxBytes
  ) {
    return failed(previous, `models.dev HTTP ${response.status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return failed(previous, 'models.dev payload is not JSON');
  }
  const next = parseModelsDevPayload(parsed, input.now);
  if (!next) return failed(previous, 'models.dev payload has no chat models');
  if (response.etag) next.etag = response.etag;
  try {
    writeModelsDevCache(input.file, next);
  } catch (error) {
    return failed(previous, error instanceof Error ? error.message : String(error));
  }
  return { cache: next, result: refreshResult(next, true, false) };
}

let memory: ModelsDevCache | undefined;
let loaded = false;
let lastFailureAt = 0;
let tail: Promise<void> = Promise.resolve();
let scheduleStarted = false;

function cachePath(): string {
  return join(app.getPath('userData'), MODELS_DEV_CACHE_NAME);
}

function loadCache(): ModelsDevCache | undefined {
  if (!loaded) {
    loaded = true;
    memory = readModelsDevCache(cachePath());
  }
  return memory;
}

export function getModelsDevModels(): readonly ModelsDevModel[] {
  return loadCache()?.models ?? [];
}

async function fetchCatalog(request: {
  url: string;
  etag?: string;
}): Promise<ModelsDevFetchResult> {
  const { getProxyConfig } = await import('./proxyConfig');
  await getProxyConfig().whenReady();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (request.etag) headers['if-none-match'] = request.etag;
    const response = await net.fetch(request.url, { headers, signal: controller.signal });
    const etag = response.headers.get('etag') ?? undefined;
    if (response.status === 304) return { status: 304, etag };
    return { status: response.status, etag, body: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

export function ensureModelsDevCatalog(options?: {
  force?: boolean;
}): Promise<ModelCatalogRefreshResult> {
  const force = options?.force === true;
  let result: ModelCatalogRefreshResult = { ok: false, modelCount: 0, fromCache: false };
  const run = tail.then(async () => {
    const previous = loadCache();
    if (!force && !previous && lastFailureAt && Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) {
      result = {
        ok: false,
        modelCount: 0,
        fromCache: false,
        error: 'models.dev refresh backing off',
      };
      return;
    }
    const outcome = await runModelsDevRefresh({
      file: cachePath(),
      previous,
      now: Date.now(),
      force,
      fetchCatalog,
    });
    memory = outcome.cache;
    loaded = true;
    lastFailureAt = outcome.result.ok ? 0 : Date.now();
    result = outcome.result;
    if (outcome.result.ok && !outcome.result.fromCache) {
      void import('./modelDirectory')
        .then(({ refreshModelDirectory }) => refreshModelDirectory())
        .catch(() => {});
    }
  });
  tail = run.then(
    () => undefined,
    () => undefined
  );
  return run.then(() => result);
}

/** 手动刷新：忽略 TTL，成功后让统一目录重新合成。 */
export async function refreshModelCatalogNow(): Promise<ModelCatalogRefreshResult> {
  return ensureModelsDevCatalog({ force: true });
}

/** 启动后拉一次，之后每 4 小时检查。缓存仍新鲜时不会打网。 */
export function startModelsDevRefreshSchedule(): void {
  if (scheduleStarted) return;
  scheduleStarted = true;
  void ensureModelsDevCatalog();
  const timer = setInterval(() => {
    void ensureModelsDevCatalog();
  }, MODELS_DEV_TTL_MS);
  timer.unref?.();
}
