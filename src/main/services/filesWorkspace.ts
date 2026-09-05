import {
  existsSync,
  type FSWatcher,
  watch as fsWatch,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { sniffImageMime } from '@shared/imageSniff';
import { PREVIEW_IMAGE_MAX_BYTES } from '@shared/markdownPreviewImage';

export const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  'target',
]);

export const MAX_FILE_BYTES = 2_000_000;
/** Files 面板编辑器上限：整文件 Shiki 会卡死 UI */
export const EDITOR_MAX_BYTES = 256_000;

export interface DirEntry {
  name: string;
  kind: 'file' | 'dir';
}

export function resolveUnderCwd(cwd: string, rel: string | undefined): string | null {
  if (
    rel &&
    (path.isAbsolute(rel) || path.win32.isAbsolute(rel) || rel.includes('\\') || rel.includes('\0'))
  )
    return null;
  const root = path.resolve(cwd);
  const target = rel == null || rel === '' || rel === '.' ? root : path.resolve(root, rel);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return null;
  return target;
}

export function resolveLocalUnderCwd(cwd: string, rel: string | undefined): string | null {
  const abs = resolveUnderCwd(cwd, rel);
  if (!abs) return null;
  try {
    const root = realpathSync(cwd);
    let existing = abs;
    while (true) {
      try {
        lstatSync(existing);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
        const parent = path.dirname(existing);
        if (parent === existing) return null;
        existing = parent;
      }
    }
    const relative = path.relative(root, realpathSync(existing));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return null;
    return abs;
  } catch {
    return null;
  }
}

/** 单层文件/目录名：禁止分隔符与 `.` / `..` */
export function assertEntryName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  return true;
}

export type FilesMutateError = 'invalid-path' | 'invalid-name' | 'exists' | 'unavailable';

export function joinUnderCwd(
  cwd: string,
  parentRel: string | undefined,
  name: string
): string | null {
  if (!assertEntryName(name)) return null;
  const parent = resolveLocalUnderCwd(cwd, parentRel);
  if (!parent) return null;
  return resolveLocalUnderCwd(cwd, parentRel ? `${parentRel}/${name}` : name);
}

export function createLocalFile(abs: string): FilesMutateError | null {
  try {
    if (existsSync(abs)) return 'exists';
    writeFileSync(abs, '', { flag: 'wx' });
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    return 'unavailable';
  }
}

export function createLocalDir(abs: string): FilesMutateError | null {
  try {
    if (existsSync(abs)) return 'exists';
    mkdirSync(abs);
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    return 'unavailable';
  }
}

export function renameLocal(fromAbs: string, toAbs: string): FilesMutateError | null {
  try {
    if (!existsSync(fromAbs)) return 'unavailable';
    if (lstatSync(toAbs, { throwIfNoEntry: false })) return 'exists';
    renameSync(fromAbs, toAbs);
    return null;
  } catch {
    return 'unavailable';
  }
}

export function removeLocal(abs: string, cwd: string): FilesMutateError | null {
  if (path.resolve(abs) === path.resolve(cwd)) return 'invalid-path';
  try {
    if (!existsSync(abs)) return 'unavailable';
    rmSync(abs, { recursive: true, force: false });
    return null;
  } catch {
    return 'unavailable';
  }
}

export class RefCountWatchers {
  private readonly map = new Map<string, { n: number; stop: () => void }>();

  get size(): number {
    return this.map.size;
  }

  acquire(key: string, start: () => () => void): void {
    const existing = this.map.get(key);
    if (existing) {
      existing.n += 1;
      return;
    }
    this.map.set(key, { n: 1, stop: start() });
  }

  release(key: string): void {
    const existing = this.map.get(key);
    if (!existing) return;
    existing.n -= 1;
    if (existing.n > 0) return;
    existing.stop();
    this.map.delete(key);
  }

  releaseAll(match: (key: string) => boolean): void {
    for (const [key, entry] of [...this.map]) {
      if (!match(key)) continue;
      entry.stop();
      this.map.delete(key);
    }
  }
}

export function listLocalDir(abs: string): DirEntry[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DirEntry[] = [];
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..') continue;
    if (entry.isDirectory()) {
      if (IGNORED_DIR_NAMES.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;
      out.push({ name: entry.name, kind: 'dir' });
    } else if (entry.isFile()) {
      out.push({ name: entry.name, kind: 'file' });
    }
  }
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

export function readLocalFile(
  abs: string
): { ok: true; content: string } | { ok: false; error: 'too-large' | 'binary' | 'unavailable' } {
  try {
    const stat = statSync(abs);
    if (!stat.isFile()) return { ok: false, error: 'unavailable' };
    if (stat.size > EDITOR_MAX_BYTES) return { ok: false, error: 'too-large' };
    const buf = readFileSync(abs);
    if (buf.includes(0)) return { ok: false, error: 'binary' };
    return { ok: true, content: buf.toString('utf8') };
  } catch {
    return { ok: false, error: 'unavailable' };
  }
}

/** Files 面板 Markdown 预览的图片读取：按 mime 编码为 data URL，越限拒绝 */
export function readLocalImage(
  abs: string,
  mime: string,
  maxBytes: number = PREVIEW_IMAGE_MAX_BYTES
):
  | { ok: true; dataUrl: string }
  | { ok: false; error: 'too-large' | 'unavailable' | 'unsupported' } {
  try {
    const stat = statSync(abs);
    if (!stat.isFile()) return { ok: false, error: 'unavailable' };
    if (stat.size > maxBytes) return { ok: false, error: 'too-large' };
    const buf = readFileSync(abs);
    // 不信任扩展名/声明的 mime：内容魔数必须与它匹配，防把 SVG/HTML 改个 `.png` 后缀当位图混过去
    if (sniffImageMime(buf) !== mime) return { ok: false, error: 'unsupported' };
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  } catch {
    return { ok: false, error: 'unavailable' };
  }
}

export function writeLocalFile(abs: string, content: string): boolean {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) return false;
  try {
    writeFileSync(abs, content, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function watchLocalFile(abs: string, onChange: () => void): () => void {
  let watcher: FSWatcher | null = null;
  try {
    watcher = fsWatch(abs, () => onChange());
  } catch {
    return () => undefined;
  }
  return () => {
    watcher?.close();
    watcher = null;
  };
}
