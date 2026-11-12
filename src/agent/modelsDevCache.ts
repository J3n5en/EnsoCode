import { statSync } from 'node:fs';
import { readModelsDevCache } from '@shared/modelsDevCacheFile';
import type { ModelsDevModel } from '@shared/modelsDevCatalog';

let memo: { file: string; mtimeMs: number; models: readonly ModelsDevModel[] } | undefined;

/** worker 读 Main 写下的 models.dev 快照。没有路径或文件损坏时当空目录。 */
export function modelsDevModelsFromEnv(): readonly ModelsDevModel[] {
  const file = process.env.ENSO_MODELS_DEV_CACHE;
  if (!file) return [];
  try {
    const mtimeMs = statSync(file).mtimeMs;
    if (memo?.file === file && memo.mtimeMs === mtimeMs) return memo.models;
    const models = readModelsDevCache(file)?.models ?? [];
    memo = { file, mtimeMs, models };
    return models;
  } catch {
    return memo?.file === file ? memo.models : [];
  }
}
