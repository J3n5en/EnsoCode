import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { parseCompactReserveTokens } from '@shared/compactionSettings';

type Settings = Record<string, unknown>;

const LOCK_ATTEMPTS = 10;
const LOCK_DELAY_MS = 20;
/** 与 pi 所用 proper-lockfile 的默认过期时间一致 */
const LOCK_STALE_MS = 10_000;

function isRecord(value: unknown): value is Settings {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 不存在返回 {}；内容损坏返回 undefined */
function readSettingsFile(file: string): Settings | undefined {
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 与 pi（proper-lockfile，realpath:false）共用 `<file>.lock` 目录锁 */
function acquireLock(file: string): (() => void) | undefined {
  const lock = `${file}.lock`;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      mkdirSync(lock);
      return () => rmdirSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock);
      } catch {
        // 锁刚被释放
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_DELAY_MS);
    }
  }
  return undefined;
}

/** pi 全局 settings.json 里当前的 compaction.reserveTokens；未设置或非法返回 null */
export function readCompactReserveTokens(file: string): number | null {
  const compaction = readSettingsFile(file)?.compaction;
  const value = isRecord(compaction) ? compaction.reserveTokens : undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 写入或删除（null）compaction.reserveTokens，保留文件其余内容；文件损坏时不覆盖 */
export function writeCompactReserveTokens(
  file: string,
  value: unknown
): { ok: true } | { ok: false; error: 'invalid-value' | 'invalid-file' | 'locked' } {
  const reserveTokens = parseCompactReserveTokens(value);
  if (reserveTokens === undefined) return { ok: false, error: 'invalid-value' };
  mkdirSync(dirname(file), { recursive: true });
  const release = acquireLock(file);
  if (!release) return { ok: false, error: 'locked' };
  try {
    const settings = readSettingsFile(file);
    if (!settings) return { ok: false, error: 'invalid-file' };
    const compaction = isRecord(settings.compaction) ? { ...settings.compaction } : {};
    if (reserveTokens === null) delete compaction.reserveTokens;
    else compaction.reserveTokens = reserveTokens;
    const next: Settings = { ...settings, compaction };
    if (Object.keys(compaction).length === 0) delete next.compaction;
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    renameSync(tmp, file);
    return { ok: true };
  } finally {
    release();
  }
}
