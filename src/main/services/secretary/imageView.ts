/**
 * 秘书的 image_view：只读一张图片给模型看。
 *
 * 校验与读取都在 @shared/secretary/imageView 里，编码会话的 image_view 用的是同一套；
 * 这里只补秘书自己的白名单（会话 worktree 根、系统临时目录、应用存放用户图片的目录）与审计。
 */
import { open, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { app } from '@platform';
import {
  appUserImageDirs,
  defaultImageRoots,
  type ImageViewDeps,
  readImageView,
  resolveRoots,
} from '@shared/secretary/imageView';
import type { SecretaryAuditEntry } from '@shared/types/secretary';
import { appendAudit } from './audit';
import type { SecretaryOpHandler, SecretaryOpResult } from './tools';

export {
  defaultImageRoots,
  IMAGE_VIEW_MAX_BYTES,
  type ImageViewDeps,
  type ImageViewOutcome,
  inImageViewScope,
  isUnderRoot,
  readImageView,
  resolveRoots,
} from '@shared/secretary/imageView';

export const userImageDirs = (userData = app.getPath('userData')): string[] =>
  appUserImageDirs(userData);

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
  async head(target, maxBytes) {
    try {
      const handle = await open(target, 'r');
      try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  },
  roots: () => resolveRoots([...defaultImageRoots(), ...userImageDirs()]),
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
