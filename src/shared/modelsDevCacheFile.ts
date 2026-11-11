import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type ModelsDevCache, parseModelsDevCache } from './modelsDevCatalog';

export function readModelsDevCache(file: string): ModelsDevCache | undefined {
  try {
    if (!existsSync(file)) return undefined;
    return parseModelsDevCache(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

export function writeModelsDevCache(file: string, cache: ModelsDevCache): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache));
  renameSync(tmp, file);
}
