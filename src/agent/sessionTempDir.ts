import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, utimesSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

/** 会话专属临时目录 `<系统 Temp>/enso/<会话>[/<子会话>]`：只在这棵树里建、删，不碰系统 Temp 根 */
export const SESSION_TEMP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export const sessionTempRoot = (tmp: string = tmpdir()): string => path.join(tmp, 'enso');

/** 合法 id 原样保留便于辨认；含非法字符 / 过长 / 空串一律换成 16 位哈希，杜绝穿越与碰撞 */
function segment(id: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id)
    ? id
    : createHash('sha256').update(id).digest('hex').slice(0, 16);
}

const inside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** 子会话 `<父>::<子>` 嵌在父会话目录下；Temp 不可用或落在项目 / 用户目录时返回 null */
export function sessionTempDir(
  sessionId: string,
  opts: { cwd: string; tmp?: string; home?: string }
): string | null {
  const tmp = opts.tmp ?? tmpdir();
  if (!tmp || !path.isAbsolute(tmp)) return null;
  const root = sessionTempRoot(path.resolve(tmp));
  const home = path.resolve(opts.home ?? homedir());
  if (path.resolve(tmp) === home || inside(path.resolve(opts.cwd), root)) return null;
  const [conversation = '', ...rest] = sessionId.split('::');
  const parts = [segment(conversation), ...(rest.length ? [segment(rest.join('::'))] : [])];
  return path.join(root, ...parts);
}

/** 建目录并刷新所属会话目录的 mtime（保留期按它算），顺带节流地异步清理过期目录；全程不抛错 */
export function ensureSessionTempDir(dir: string, root: string = sessionTempRoot()): void {
  if (!inside(root, dir)) return;
  const top = path.join(root, path.relative(root, dir).split(path.sep)[0] ?? '');
  if (top === root) return;
  try {
    mkdirSync(dir, { recursive: true });
    const now = new Date();
    utimesSync(top, now, now);
  } catch {}
  const at = Date.now();
  if (at - (lastPrune.get(root) ?? 0) < PRUNE_INTERVAL_MS) return;
  lastPrune.set(root, at);
  void pruneSessionTempDirs(root, { keep: top });
}
const lastPrune = new Map<string, number>();

/** 删掉 enso 根下超过保留期的会话目录；只看根下一层真实目录，链接与文件不动 */
export async function pruneSessionTempDirs(
  root: string,
  opts: { keep?: string; now?: number; maxAgeMs?: number } = {}
): Promise<void> {
  const cutoff = (opts.now ?? Date.now()) - (opts.maxAgeMs ?? SESSION_TEMP_RETENTION_MS);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const dir = path.join(root, entry);
    if (opts.keep && path.resolve(dir) === path.resolve(opts.keep)) continue;
    try {
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.mtimeMs >= cutoff) continue;
      await rm(dir, { recursive: true, force: true });
    } catch {}
  }
}

/** 删除会话（含子会话）的临时目录；越界或空 id 什么都不删 */
export function removeSessionTempDir(conversationId: string, tmp: string = tmpdir()): void {
  if (!conversationId || !tmp || !path.isAbsolute(tmp)) return;
  const root = sessionTempRoot(tmp);
  const dir = path.join(root, segment(conversationId));
  if (path.dirname(dir) !== root) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}
