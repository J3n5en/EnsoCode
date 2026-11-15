/**
 * 秘书的 image_view：只读一张图片给模型看。
 *
 * 两条边界：
 * - 路径：先解析真实路径，再要求落在会话 worktree 根或系统临时目录里；
 *   用户主目录、项目检出、应用数据目录一律拒绝，符号链接穿越在解析后就被挡住。
 * - 内容：只认文件头，png / jpeg / webp / gif 之外的一律拒绝，单张上限 10MB。
 */
import { realpathSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { app } from '@platform';
import { type ImageFacts, readImageFacts } from '@shared/secretary/imageBytes';
import type { SecretaryAuditEntry } from '@shared/types/secretary';
import { appendAudit } from './audit';
import type { SecretaryOpHandler, SecretaryOpResult } from './tools';

export const IMAGE_VIEW_MAX_BYTES = 10 * 1024 * 1024;

export interface ImageViewDeps {
  /** 解析真实路径；不存在或不可读返回 null */
  realpath(target: string): Promise<string | null>;
  size(target: string): Promise<number | null>;
  read(target: string): Promise<Uint8Array | null>;
  /** 允许的根目录（真实路径）；测试注入假目录 */
  roots(): string[];
}

export type ImageViewOutcome =
  | { ok: true; path: string; size: number; facts: ImageFacts; data: string }
  | { ok: false; error: string };

/** 会话 worktree 根与系统临时目录：只有这三处允许秘书看图 */
export function defaultImageRoots(home = homedir()): string[] {
  return [path.join(home, 'project', 'worktree'), '/tmp', '/private/tmp', '/private/var/folders'];
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

/**
 * 解析并校验一个路径：越界、不存在、不是普通文件、太大、不是图片都在这里拒绝。
 * 只有全部通过才读字节，读到的字节只用于判断格式与尺寸。
 */
export async function readImageView(
  deps: ImageViewDeps,
  requested: string
): Promise<ImageViewOutcome> {
  const trimmed = requested.trim();
  if (!trimmed) return { ok: false, error: 'path is required' };
  // 相对路径没有可判定的边界，直接拒绝，不去猜秘书想的是哪个目录
  if (!path.isAbsolute(trimmed))
    return { ok: false, error: 'path must be absolute; give the full path of the image' };
  const resolved = await deps.realpath(trimmed);
  if (!resolved) return { ok: false, error: `no such file: ${trimmed}` };
  if (!inImageViewScope(resolved, deps.roots()))
    return {
      ok: false,
      error: `path is out of scope: ${resolved}. Only images under ~/project/worktree, /tmp, /private/tmp or /private/var/folders can be opened.`,
    };
  const size = await deps.size(resolved);
  if (size === null) return { ok: false, error: `no such file: ${resolved}` };
  if (size > IMAGE_VIEW_MAX_BYTES)
    return {
      ok: false,
      error: `image is too large: ${formatMegabytes(size)}, the limit is ${formatMegabytes(IMAGE_VIEW_MAX_BYTES)}`,
    };
  const bytes = await deps.read(resolved);
  if (!bytes) return { ok: false, error: `cannot read file: ${resolved}` };
  const facts = readImageFacts(bytes);
  if (!facts)
    return {
      ok: false,
      error: `not a supported image: ${resolved}. Only png, jpg, jpeg, webp and gif are accepted, judged by the file header, not by the extension.`,
    };
  return {
    ok: true,
    path: resolved,
    size: bytes.length,
    facts,
    data: Buffer.from(bytes).toString('base64'),
  };
}

export const realImageViewDeps: ImageViewDeps = {
  async realpath(target) {
    try {
      return await realpath(target);
    } catch {
      return null;
    }
  },
  async size(target) {
    try {
      const info = await stat(target);
      return info.isFile() ? info.size : null;
    } catch {
      return null;
    }
  },
  async read(target) {
    try {
      return await readFile(target);
    } catch {
      return null;
    }
  },
  roots: () => resolveRoots(defaultImageRoots()),
};

export interface ImageViewHandlerPorts {
  deps: ImageViewDeps;
  audit(entry: SecretaryAuditEntry): void;
  now(): number;
}

/**
 * 审计只记路径与大小，不记图片内容：模型看到的东西不进审计日志。
 */
export function createSecretaryImageViewHandler(ports: ImageViewHandlerPorts): SecretaryOpHandler {
  return async (params, ctx): Promise<SecretaryOpResult> => {
    const requested = typeof params.path === 'string' ? params.path : '';
    const outcome = await readImageView(ports.deps, requested);
    ports.audit({
      at: ports.now(),
      secretaryConversationId: ctx.secretaryConversationId,
      op: 'image_view',
      targetId: outcome.ok ? outcome.path : requested.slice(0, 1024),
      ok: outcome.ok,
      detail: outcome.ok
        ? `${outcome.size} bytes${outcome.facts.width && outcome.facts.height ? `, ${outcome.facts.width}x${outcome.facts.height}` : ''}`
        : outcome.error.slice(0, 200),
    });
    if (!outcome.ok) return { ok: false, error: outcome.error };
    return {
      ok: true,
      result: {
        path: outcome.path,
        size: outcome.size,
        format: outcome.facts.format,
        mimeType: outcome.facts.mimeType,
        width: outcome.facts.width,
        height: outcome.facts.height,
        data: outcome.data,
      },
    };
  };
}

export const secretaryImageViewHandler = createSecretaryImageViewHandler({
  deps: realImageViewDeps,
  audit: (entry) => appendAudit(path.join(app.getPath('userData'), 'secretary'), entry),
  now: () => Date.now(),
});
