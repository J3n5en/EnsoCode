// 统一模型目录的 Main 侧合成与广播。
// settings.json 里的 OAuth 条目只留稀疏覆盖；「有哪些模型」由这里派生。
// Renderer 经 modelDirectory:get / modelDirectory:changed 订阅快照。

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from '@platform';
import type {
  DirectoryModel,
  DirectoryProvider,
  ModelDirectorySnapshot,
} from '@shared/modelDirectory';
import { parseModelDirectorySnapshot } from '@shared/modelDirectory';
import { withModelsDevOauthModels } from '@shared/modelsDevCatalog';
import { expandOauthCatalog } from '@shared/oauthCatalog';
import { IPC_CHANNELS, type ModelProvider, persistedSettingsState } from '@shared/types';
import { readSettings } from '../ipc/settings';
import { getModelsDevModels } from './modelsDevCatalog';
import { localUi } from './uiHost';

export interface DirectoryOAuthSource {
  id: string;
  label: string;
  models: readonly { id: string; name?: string }[];
}

const CACHE_NAME = 'model-directory-cache.json';
const CACHE_DEBOUNCE_MS = 500;

let snapshot: ModelDirectorySnapshot | undefined;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let cacheDirty = false;
/**
 * 绕过 runtime 的动态发现结果（目前只有 xAI 订阅探测，见 modelMeta.ts）。
 * 合成时并入对应分区并随缓存持久化——否则编辑器「拉取模型」看到的新模型
 * 保存时会被稀疏化当无意图行丢弃，清单又从目录里消失。
 */
const extraOauthModels = new Map<string, DirectoryModel[]>();
const listeners = new Set<(snapshot: ModelDirectorySnapshot) => void>();

function cachePath(): string {
  return join(app.getPath('userData'), CACHE_NAME);
}

function directoryModel(id: string, name?: string): DirectoryModel {
  const model: DirectoryModel = { id };
  if (typeof name === 'string' && name.length > 0 && name !== id) model.label = name;
  return model;
}

/**
 * 把 runtime OAuth 清单、settings 自定义条目和离线缓存合成一份快照。
 * revision / now 由调用方决定；本函数不比较新旧、不自行 bump。
 */
export function synthesizeModelDirectory(input: {
  oauthProviders: readonly DirectoryOAuthSource[];
  customProviders: readonly ModelProvider[];
  cached?: readonly DirectoryProvider[];
  extraOauthModels?: ReadonlyMap<string, readonly DirectoryModel[]>;
  revision: number;
  now: number;
}): ModelDirectorySnapshot {
  const cachedByKey = new Map(
    (input.cached ?? [])
      .filter((provider) => provider.kind === 'oauth')
      .map((provider) => [provider.key, provider])
  );
  const providers: DirectoryProvider[] = [];

  for (const source of input.oauthProviders) {
    if (!source.id) continue;
    const live = source.models
      .filter((model) => typeof model.id === 'string' && model.id.length > 0)
      .map((model) => directoryModel(model.id, model.name));
    const cached = cachedByKey.get(source.id);
    // runtime 可能只是静态 fallback；缺席不是动态模型已下线的证据。
    const models = new Map(live.map((model) => [model.id, model]));
    for (const model of [
      ...(cached?.models ?? []),
      ...(input.extraOauthModels?.get(source.id) ?? []),
    ]) {
      if (!models.has(model.id)) models.set(model.id, { ...model });
    }
    const section: DirectoryProvider = {
      key: source.id,
      kind: 'oauth',
      label: source.label,
      models: [...models.values()],
    };
    if (live.length > 0) section.discoveredAt = input.now;
    else if (cached?.discoveredAt !== undefined) section.discoveredAt = cached.discoveredAt;
    providers.push(section);
  }

  for (const provider of input.customProviders) {
    if (provider.oauthAccountKey) continue;
    if (!provider.id) continue;
    providers.push({
      key: provider.id,
      kind: 'custom',
      label: typeof provider.name === 'string' ? provider.name : provider.id,
      models: (provider.models ?? [])
        .filter((model) => model && typeof model.id === 'string' && model.id.length > 0)
        .map((model) => {
          const entry: DirectoryModel = { id: model.id };
          if (typeof model.label === 'string' && model.label.length > 0) entry.label = model.label;
          return entry;
        }),
    });
  }

  return { revision: input.revision, generatedAt: input.now, providers };
}

function readCustomProviders(): ModelProvider[] {
  try {
    const providers = persistedSettingsState(readSettings()?.['enso-settings'])?.providers;
    if (!Array.isArray(providers)) return [];
    const custom: ModelProvider[] = [];
    for (const item of providers) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const provider = item as Partial<ModelProvider>;
      if (typeof provider.id !== 'string' || provider.id.length === 0) continue;
      if (provider.oauthAccountKey) continue;
      if (!Array.isArray(provider.models)) continue;
      custom.push(provider as ModelProvider);
    }
    return custom;
  } catch {
    return [];
  }
}

/** 磁盘缓存只留 OAuth 分区；坏文件当空，不让一次损坏挡住启动。 */
export function loadCachedOAuthProviders(): DirectoryProvider[] {
  try {
    const file = cachePath();
    if (!existsSync(file)) return [];
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const parsed = parseModelDirectorySnapshot({
      revision: 0,
      generatedAt: 0,
      providers: (raw as { providers?: unknown }).providers,
    });
    return (parsed?.providers ?? []).filter((provider) => provider.kind === 'oauth');
  } catch {
    return [];
  }
}

function oauthFallback(): DirectoryProvider[] {
  const memory = snapshot?.providers.filter((provider) => provider.kind === 'oauth') ?? [];
  return memory.length > 0 ? memory : loadCachedOAuthProviders();
}

function semanticKey(providers: readonly DirectoryProvider[]): string {
  return JSON.stringify(
    providers.map((provider) => ({
      key: provider.key,
      kind: provider.kind,
      label: provider.label,
      models: provider.models,
    }))
  );
}

function broadcast(next: ModelDirectorySnapshot): void {
  for (const contents of localUi()?.allContents() ?? []) {
    contents.send(IPC_CHANNELS.MODEL_DIRECTORY_CHANGED, next);
  }
}

function notifyListeners(next: ModelDirectorySnapshot): void {
  for (const listener of listeners) {
    try {
      listener(next);
    } catch {
      // listener 异常不拖垮目录
    }
  }
}

/** 目录内容变化后通知 Main 内部订阅者（例如把快照推给 agent worker）。 */
export function onModelDirectoryChanged(
  listener: (snapshot: ModelDirectorySnapshot) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function atomicWriteCache(providers: readonly DirectoryProvider[]): void {
  const target = cachePath();
  const tempPath = `${target}.tmp`;
  const oauth = providers.filter((provider) => provider.kind === 'oauth');
  writeFileSync(tempPath, JSON.stringify({ providers: oauth }), 'utf8');
  renameSync(tempPath, target);
}

export function flushModelDirectoryCache(options?: { retry?: boolean }): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (!cacheDirty || !snapshot) return;
  try {
    atomicWriteCache(snapshot.providers);
    cacheDirty = false;
  } catch {
    // 缓存是派生数据；写失败留 dirty 并重排一次防抖（before-quit 路径不重排），
    // 避免只能等下次提交/退出
    if (options?.retry !== false) scheduleCacheWrite();
  }
}

function scheduleCacheWrite(): void {
  cacheDirty = true;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flushModelDirectoryCache();
  }, CACHE_DEBOUNCE_MS);
}

/** 内容（不含 discoveredAt / revision）变化才 bump、广播、排缓存写。 */
function commitIfChanged(providers: DirectoryProvider[], now: number): void {
  if (snapshot && semanticKey(snapshot.providers) === semanticKey(providers)) return;
  const revision = (snapshot?.revision ?? 0) + 1;
  snapshot = { revision, generatedAt: now, providers };
  broadcast(snapshot);
  notifyListeners(snapshot);
  scheduleCacheWrite();
}

function materializeOffline(now: number): ModelDirectorySnapshot {
  const cached = loadCachedOAuthProviders();
  return synthesizeModelDirectory({
    oauthProviders: cached.map((provider) => ({
      id: provider.key,
      label: provider.label,
      models: [],
    })),
    customProviders: readCustomProviders(),
    cached,
    revision: 1,
    now,
  });
}

export function getModelDirectorySnapshot(): ModelDirectorySnapshot {
  snapshot ??= materializeOffline(Date.now());
  return snapshot;
}

async function loadLiveOAuthProviders(): Promise<DirectoryOAuthSource[] | undefined> {
  try {
    const { getRuntime } = await import('./oauthProviders');
    const runtime = await getRuntime();
    const live: DirectoryOAuthSource[] = [];
    for (const provider of runtime.getProviders()) {
      if (!provider.auth?.oauth || provider.id.includes('#')) continue;
      const oauthName =
        typeof provider.auth.oauth === 'object' ? provider.auth.oauth.name : undefined;
      const models = withModelsDevOauthModels(
        provider.id,
        expandOauthCatalog(provider.id, provider.getModels()),
        getModelsDevModels()
      ).map((model) => ({
        id: model.id,
        name: 'name' in model && typeof model.name === 'string' ? model.name : undefined,
      }));
      live.push({
        id: provider.id,
        label: oauthName || provider.name,
        models,
      });
    }
    return live;
  } catch {
    return undefined;
  }
}

export async function refreshModelDirectory(): Promise<void> {
  const cached = oauthFallback();
  const live = await loadLiveOAuthProviders();
  const oauthProviders =
    live ??
    cached.map((provider) => ({
      id: provider.key,
      label: provider.label,
      models: [] as { id: string; name?: string }[],
    }));
  const now = Date.now();
  const next = synthesizeModelDirectory({
    oauthProviders,
    customProviders: readCustomProviders(),
    cached,
    extraOauthModels,
    revision: snapshot?.revision ?? 0,
    now,
  });
  commitIfChanged(next.providers, now);
}

/**
 * 记录绕过 runtime 的动态发现结果（如 xAI 订阅探测），并入目录并广播。
 * 用当前快照作 live 输入重合成；幂等，无新增 id 时不产生变更。
 */
export function noteDiscoveredOauthModels(
  providerId: string,
  models: readonly { id: string; label?: string }[]
): void {
  if (!providerId || models.length === 0) return;
  const existing = extraOauthModels.get(providerId) ?? [];
  const known = new Set(existing.map((model) => model.id));
  const fresh: DirectoryModel[] = [];
  for (const model of models) {
    if (!model.id || known.has(model.id)) continue;
    known.add(model.id);
    fresh.push(directoryModel(model.id, model.label));
  }
  if (fresh.length === 0) return;
  extraOauthModels.set(providerId, [...existing, ...fresh]);
  const current = getModelDirectorySnapshot();
  const now = Date.now();
  const next = synthesizeModelDirectory({
    oauthProviders: current.providers
      .filter((provider) => provider.kind === 'oauth')
      .map((provider) => ({
        id: provider.key,
        label: provider.label,
        models: provider.models.map((model) => ({ id: model.id, name: model.label })),
      })),
    customProviders: readCustomProviders(),
    cached: loadCachedOAuthProviders(),
    extraOauthModels,
    revision: current.revision,
    now,
  });
  commitIfChanged(next.providers, now);
}

/** settings 变更只重合成自定义分区；OAuth 分区沿用内存 / 缓存，不打 runtime。 */
export function notifyModelDirectorySettingsChanged(): void {
  try {
    const current = getModelDirectorySnapshot();
    const oauth = current.providers.filter((provider) => provider.kind === 'oauth');
    const custom = synthesizeModelDirectory({
      oauthProviders: [],
      customProviders: readCustomProviders(),
      revision: current.revision,
      now: Date.now(),
    }).providers;
    commitIfChanged([...oauth, ...custom], Date.now());
  } catch {
    // 目录是派生投影；合成失败不能把 settings 写成功路径拖成失败
  }
}
