import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { isPluginId } from '@shared/extensionPlugins/manifest';

export const README_MAX_BYTES = 256 * 1024;

export type ReadmeResult = { ok: true; markdown: string } | { ok: false; error: string };

const inside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export function parseReadmeRequest(
  raw: unknown
): { id: string; from: 'installed' | 'market' } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as { id?: unknown; from?: unknown };
  if (!isPluginId(rec.id)) return null;
  if (rec.from !== 'installed' && rec.from !== 'market') return null;
  return { id: rec.id, from: rec.from };
}

export function readPackageReadme(packageDir: string): ReadmeResult {
  let base: string;
  try {
    base = realpathSync(packageDir);
  } catch {
    return { ok: false, error: '没有使用说明' };
  }
  const target = resolve(base, 'README.md');
  try {
    const info = statSync(target);
    if (!info.isFile()) return { ok: false, error: '没有使用说明' };
    if (info.size > README_MAX_BYTES) return { ok: false, error: '使用说明过大' };
    const real = realpathSync(target);
    if (!inside(base, real)) return { ok: false, error: '没有使用说明' };
    return { ok: true, markdown: readFileSync(real, 'utf8') };
  } catch {
    return { ok: false, error: '没有使用说明' };
  }
}
