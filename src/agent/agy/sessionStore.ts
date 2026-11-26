import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function agySessionStorePath(sessionDir: string): string {
  return path.join(sessionDir, 'agy-sessions.json');
}

export function readAgySessionId(file: string, ensoSessionId: string): string | undefined {
  const map = readMap(file);
  const id = map[ensoSessionId];
  return typeof id === 'string' && id ? id : undefined;
}

export function writeAgySessionId(file: string, ensoSessionId: string, agySessionId: string): void {
  const map = readMap(file);
  map[ensoSessionId] = agySessionId;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(map)}\n`);
}

export function clearAgySessionId(file: string, ensoSessionId: string): void {
  const map = readMap(file);
  if (!(ensoSessionId in map)) return;
  delete map[ensoSessionId];
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(map)}\n`);
}

function readMap(file: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const map: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value) map[key] = value;
    }
    return map;
  } catch {
    return {};
  }
}
