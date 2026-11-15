/**
 * image_view 的唯一实现：秘书会话（Main 侧 op）与编码会话（worker 侧工具）共用。
 *
 * 两条边界：
 * - 路径：先解析真实路径，再要求落在调用方给的根目录里；符号链接穿越在解析后就被挡住。
 * - 内容：只认文件头，png / jpeg / webp / gif 之外的一律拒绝，单张上限 10MB。
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { type ImageFacts, readImageFacts } from './imageBytes';

export const IMAGE_VIEW_MAX_BYTES = 10 * 1024 * 1024;

/** 判断格式只需文件头：jpeg 的 SOF 段最远也就几十 KB，不必把整张图读进内存 */
const HEAD_BYTES = 64 * 1024;

export interface ImageViewDeps {
  /** 解析真实路径；不存在或不可读返回 null */
  realpath(target: string): Promise<string | null>;
  size(target: string): Promise<number | null>;
  read(target: string): Promise<Uint8Array | null>;
  /** 只读文件头；缺省时退回整份读取 */
  head?(target: string, maxBytes: number): Promise<Uint8Array | null>;
  /** 允许的根目录（真实路径）；调用方按会话决定 */
  roots(): string[];
}

/** 只校验不返回字节：session_send 转发图片时用它，不把图片读进 Main 内存 */
export type ImageViewProbe =
  | { ok: true; path: string; size: number; facts: ImageFacts }
  | { ok: false; error: string };

export type ImageViewOutcome =
  | { ok: true; path: string; size: number; facts: ImageFacts; data: string }
  | { ok: false; error: string };

/** 系统临时目录：任何会话都可以看图的地方 */
export function systemImageRoots(): string[] {
  return ['/tmp', '/private/tmp', '/private/var/folders'];
}

/** 秘书的白名单：会话 worktree 根加系统临时目录 */
export function defaultImageRoots(home = homedir()): string[] {
  return [path.join(home, 'project', 'worktree'), ...systemImageRoots()];
}

/**
 * 应用自己存放用户图片的目录：bot / 群聊里用户发的截图按内容哈希存在
 * userData/bot-chats/<chatId>/media 下，这是用户图片唯一落盘的地方。
 */
export function appUserImageDirs(userData: string): string[] {
  return [path.join(userData, 'bot-chats')];
}

/**
 * 根目录本身也要解析真实路径：~/project 若是符号链接，解析后的图片路径
 * 就落不到未解析的根下面，白名单会误伤。
 */
export function resolveRoots(roots: readonly string[]): string[] {
  return roots.map((root) => {
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  });
}

/** 前缀比较必须按目录边界：/tmpfoo 不算在 /tmp 里 */
export function isUnderRoot(target: string, root: string): boolean {
  const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target === root || target.startsWith(normalizedRoot);
}

export function inImageViewScope(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => isUnderRoot(target, root));
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function scopeError(resolved: string, roots: readonly string[]): string {
  const allowed = roots.length > 0 ? roots.join(', ') : '(none)';
  return `path is out of scope: ${resolved}. Allowed roots: ${allowed}`;
}

/** 越界、不存在、不是普通文件、太大都在这里拒绝；只有全部通过才读文件头 */
async function validate(
  deps: ImageViewDeps,
  requested: string
): Promise<{ ok: true; path: string; size: number } | { ok: false; error: string }> {
  const trimmed = requested.trim();
  if (!trimmed) return { ok: false, error: 'path is required' };
  // 相对路径没有可判定的边界，直接拒绝，不去猜调用方想的是哪个目录
  if (!path.isAbsolute(trimmed))
    return { ok: false, error: 'path must be absolute; give the full path of the image' };
  const resolved = await deps.realpath(trimmed);
  if (!resolved) return { ok: false, error: `no such file: ${trimmed}` };
  const roots = deps.roots();
  if (!inImageViewScope(resolved, roots)) return { ok: false, error: scopeError(resolved, roots) };
  const size = await deps.size(resolved);
  if (size === null) return { ok: false, error: `no such file: ${resolved}` };
  if (size > IMAGE_VIEW_MAX_BYTES)
    return {
      ok: false,
      error: `image is too large: ${formatMegabytes(size)}, the limit is ${formatMegabytes(IMAGE_VIEW_MAX_BYTES)}`,
    };
  return { ok: true, path: resolved, size };
}

async function readHead(deps: ImageViewDeps, target: string): Promise<Uint8Array | null> {
  if (deps.head) return deps.head(target, HEAD_BYTES);
  const bytes = await deps.read(target);
  if (!bytes) return null;
  return bytes.length > HEAD_BYTES ? bytes.subarray(0, HEAD_BYTES) : bytes;
}

function notAnImage(resolved: string): { ok: false; error: string } {
  return {
    ok: false,
    error: `not a supported image: ${resolved}. Only png, jpg, jpeg, webp and gif are accepted, judged by the file header, not by the extension.`,
  };
}

/** 只校验并读出元数据，不返回图片字节 */
export async function probeImageView(
  deps: ImageViewDeps,
  requested: string
): Promise<ImageViewProbe> {
  const valid = await validate(deps, requested);
  if (!valid.ok) return valid;
  const head = await readHead(deps, valid.path);
  if (!head) return { ok: false, error: `cannot read file: ${valid.path}` };
  const facts = readImageFacts(head);
  if (!facts) return notAnImage(valid.path);
  return { ok: true, path: valid.path, size: valid.size, facts };
}

/** 校验并读出整张图（base64），给模型看 */
export async function readImageView(
  deps: ImageViewDeps,
  requested: string
): Promise<ImageViewOutcome> {
  const valid = await validate(deps, requested);
  if (!valid.ok) return valid;
  const bytes = await deps.read(valid.path);
  if (!bytes) return { ok: false, error: `cannot read file: ${valid.path}` };
  const facts = readImageFacts(bytes);
  if (!facts) return notAnImage(valid.path);
  return {
    ok: true,
    path: valid.path,
    size: bytes.length,
    facts,
    data: Buffer.from(bytes).toString('base64'),
  };
}
