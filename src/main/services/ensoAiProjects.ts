import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Chromium Local Storage 的 value：首字节 0 = UTF-16LE，1 = UTF-8/Latin1 */
export function decodeLocalStorageValue(value: Buffer): string {
  if (value.length === 0) return '';
  const body = value.subarray(1);
  return value[0] === 0 ? body.toString('utf16le') : body.toString('utf8');
}

/** 解析 EnsoAI localStorage 的 enso-repositories：只保留本地仓库路径 */
export function parseEnsoAiRepositories(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const paths: string[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as { path?: unknown; kind?: unknown; id?: unknown };
    if (item.kind === 'remote') continue;
    if (typeof item.id === 'string' && item.id.startsWith('remote:')) continue;
    if (typeof item.path !== 'string' || !item.path.trim()) continue;
    if (!paths.includes(item.path)) paths.push(item.path);
  }
  return paths;
}

/** EnsoAI userData 的 Local Storage leveldb 目录 */
function ensoAiLeveldbDir(): string {
  const HOME = os.homedir();
  const relative = 'enso-ai/Local Storage/leveldb';
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    return path.join(appData, relative);
  }
  if (process.platform === 'linux') {
    return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), relative);
  }
  return path.join(HOME, 'Library', 'Application Support', relative);
}

/** 读取 EnsoAI 登记的本地仓库路径（leveldb 可能被占用，拷贝快照后读取） */
export async function readEnsoAiProjectPaths(leveldbDir = ensoAiLeveldbDir()): Promise<string[]> {
  if (!fs.existsSync(leveldbDir)) return [];

  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-recent-scan-'));
  try {
    fs.cpSync(leveldbDir, snapshot, {
      recursive: true,
      filter: (source) => path.basename(source) !== 'LOCK',
    });

    const { Level } = await import('level');
    const db = new Level<Buffer, Buffer>(snapshot, {
      keyEncoding: 'buffer',
      valueEncoding: 'buffer',
      createIfMissing: false,
    });

    try {
      await db.open();
      const paths: string[] = [];
      for await (const [key, value] of db.iterator()) {
        if (!key.toString('utf8').endsWith('\u0001enso-repositories')) continue;
        for (const repoPath of parseEnsoAiRepositories(decodeLocalStorageValue(value))) {
          if (!paths.includes(repoPath)) paths.push(repoPath);
        }
      }
      return paths;
    } finally {
      await db.close().catch(() => {});
    }
  } finally {
    fs.rmSync(snapshot, { recursive: true, force: true });
  }
}
