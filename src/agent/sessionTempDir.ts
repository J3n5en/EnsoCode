import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  type Stats,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

/**
 * 会话专属临时目录 `<系统 Temp>/enso-session-temp[-uid]/<会话>[/<子会话>]`。
 * 删除只认能证明归属的目录：根是真实目录（非链接 / junction）、realpath 正好落在 Temp 下、
 * 有归属标记文件、POSIX 上属主是当前用户；会话目录是根下一层的真实目录。任一条不满足就拒删并记日志。
 */
export const SESSION_TEMP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const ROOT_MARKER = '.enso-session-temp-root';
const MARKER_TEXT = 'EnsoCode session temp root\n';
const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const uid = typeof process.getuid === 'function' ? process.getuid() : -1;

export const sessionTempRoot = (tmp: string = tmpdir()): string =>
  path.join(tmp, uid >= 0 ? `enso-session-temp-${uid}` : 'enso-session-temp');

/** 合法 id 原样保留便于辨认；含非法字符 / 过长 / 空串一律换成 16 位哈希，杜绝穿越与碰撞 */
function segment(id: string): string {
  return SEGMENT.test(id) ? id : createHash('sha256').update(id).digest('hex').slice(0, 16);
}

const inside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const refuse = (target: string, reason: string): null => {
  console.warn(`[session-temp] refuse to delete ${target}: ${reason}`);
  return null;
};

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/** 可用的 Temp：非空绝对路径，且不是文件系统根 */
const usableTemp = (tmp: string): boolean =>
  !!tmp && path.isAbsolute(tmp) && path.parse(path.resolve(tmp)).root !== path.resolve(tmp);

/** 根目录形状校验：真实目录、属主是自己、realpath 后正好是 realpath(Temp)/<根名>；返回 realpath */
function realRootOf(root: string): string | null {
  let st: Stats;
  try {
    st = lstatSync(root);
  } catch (error) {
    return isMissing(error) ? null : refuse(root, String(error));
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return refuse(root, 'not a real directory');
  if (uid >= 0 && st.uid !== uid) return refuse(root, `owned by uid ${st.uid}`);
  try {
    const real = realpathSync(root);
    const expected = path.join(realpathSync(path.dirname(root)), path.basename(root));
    return real === expected ? real : refuse(root, `resolves to ${real}`);
  } catch (error) {
    return refuse(root, String(error));
  }
}

/** 归属已证明的根目录 realpath；不存在时静默返回 null */
function ownedRoot(root: string): string | null {
  const real = realRootOf(root);
  if (!real) return null;
  try {
    const marker = path.join(real, ROOT_MARKER);
    if (lstatSync(marker).isFile() && readFileSync(marker, 'utf8') === MARKER_TEXT) return real;
  } catch {}
  return refuse(root, 'missing ownership marker');
}

/** 根下一层、名字合法、非链接的真实目录；不存在时静默返回 null */
function ownedSessionDir(realRoot: string, name: string): string | null {
  const dir = path.join(realRoot, name);
  if (!SEGMENT.test(name)) return refuse(dir, 'invalid name');
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return refuse(dir, 'not a real directory');
    return path.dirname(realpathSync(dir)) === realRoot ? dir : refuse(dir, 'escapes root');
  } catch (error) {
    return isMissing(error) ? null : refuse(dir, String(error));
  }
}

/** 建根目录并写归属标记；根已被链接等形式占用时不认领，返回 null */
export function claimSessionTempRoot(root: string = sessionTempRoot()): string | null {
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
  }
  const real = realRootOf(root);
  if (!real) return null;
  try {
    writeFileSync(path.join(real, ROOT_MARKER), MARKER_TEXT, { flag: 'wx' });
  } catch {}
  return ownedRoot(root);
}

/** 子会话 `<父>::<子>` 嵌在父会话目录下；Temp 不可用或落在项目 / 用户目录时返回 null */
export function sessionTempDir(
  sessionId: string,
  opts: { cwd: string; tmp?: string; home?: string }
): string | null {
  const tmp = opts.tmp ?? tmpdir();
  if (!usableTemp(tmp)) return null;
  const root = sessionTempRoot(path.resolve(tmp));
  const home = path.resolve(opts.home ?? homedir());
  if (path.resolve(tmp) === home || inside(path.resolve(opts.cwd), root)) return null;
  const [conversation = '', ...rest] = sessionId.split('::');
  const parts = [segment(conversation), ...(rest.length ? [segment(rest.join('::'))] : [])];
  return path.join(root, ...parts);
}

/** 建目录并刷新所属会话目录的 mtime（保留期按它算），顺带节流地异步清理过期目录；全程不抛错 */
export function ensureSessionTempDir(dir: string, root: string = sessionTempRoot()): void {
  if (!inside(root, dir) || path.resolve(dir) === path.resolve(root)) return;
  const realRoot = claimSessionTempRoot(root);
  if (!realRoot) return;
  const rel = path.relative(root, dir);
  const top = path.join(realRoot, rel.split(path.sep)[0] ?? '');
  try {
    if (lstatSync(top, { throwIfNoEntry: false })?.isSymbolicLink()) return;
    mkdirSync(path.join(realRoot, rel), { recursive: true });
    const now = new Date();
    utimesSync(top, now, now);
  } catch {}
  const at = Date.now();
  if (at - (lastPrune.get(root) ?? 0) < PRUNE_INTERVAL_MS) return;
  lastPrune.set(root, at);
  void pruneSessionTempDirs(root, { keep: top });
}
const lastPrune = new Map<string, number>();

/** 删掉根下超过保留期的会话目录；根归属不成立时什么都不删 */
export async function pruneSessionTempDirs(
  root: string,
  opts: { keep?: string; now?: number; maxAgeMs?: number } = {}
): Promise<void> {
  const realRoot = ownedRoot(root);
  if (!realRoot) return;
  const cutoff = (opts.now ?? Date.now()) - (opts.maxAgeMs ?? SESSION_TEMP_RETENTION_MS);
  let keep = opts.keep;
  try {
    if (keep) keep = realpathSync(keep);
  } catch {}
  let entries: string[];
  try {
    entries = await readdir(realRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === ROOT_MARKER) continue;
    const dir = ownedSessionDir(realRoot, entry);
    if (!dir || dir === keep) continue;
    try {
      if ((await stat(dir)).mtimeMs >= cutoff) continue;
      await rm(dir, { recursive: true, force: true });
    } catch {}
  }
}

/** 删除会话（含子会话）的临时目录；Temp、根或会话目录的归属任一条不成立就拒删 */
export function removeSessionTempDir(conversationId: string, tmp: string = tmpdir()): void {
  if (!conversationId) return void refuse(`(empty id) in ${tmp}`, 'empty conversation id');
  if (!usableTemp(tmp)) return void refuse(`${conversationId} in ${tmp || '(empty)'}`, 'bad temp');
  const realRoot = ownedRoot(sessionTempRoot(tmp));
  const dir = realRoot && ownedSessionDir(realRoot, segment(conversationId));
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[session-temp] failed to delete ${dir}`, error);
  }
}
