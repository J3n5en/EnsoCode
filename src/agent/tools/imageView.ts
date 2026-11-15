/**
 * 编码会话的 image_view：与秘书同一套实现（@shared/secretary/imageView），
 * 只是白名单换成会话自己的 worktree / 检出根、系统临时目录与应用存放用户图片的目录。
 *
 * 秘书会话不用这一份：它的 image_view 走 Main 侧 op 并写审计。
 */
import { open, readFile, realpath, stat } from 'node:fs/promises';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  type ImageViewDeps,
  readImageView,
  resolveRoots,
  systemImageRoots,
} from '@shared/secretary/imageView';

export interface ImageViewToolOptions {
  /** 会话自己的工作目录：worktree 会话是 worktree 根，检出会话是项目目录 */
  cwd: string;
  /** 应用自己存放用户图片的目录，由 Main 经 ENSO_USER_IMAGE_DIRS 下发 */
  userImageDirs?: readonly string[];
}

export function imageViewRoots(options: ImageViewToolOptions): string[] {
  return resolveRoots([options.cwd, ...systemImageRoots(), ...(options.userImageDirs ?? [])]);
}

export const localImageViewDeps: Omit<ImageViewDeps, 'roots'> = {
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
};

export function createImageViewTool(options: ImageViewToolOptions): ToolDefinition {
  const roots = imageViewRoots(options);
  const deps: ImageViewDeps = { ...localImageViewDeps, roots: () => roots };
  return {
    name: 'image_view',
    label: 'image_view',
    description:
      "Open one image file and look at it yourself. Only images under this session's own working directory, /tmp, /private/tmp, /private/var/folders or the app chat image directory can be opened; every other path, including the user home and other project checkouts, is refused. Only png, jpg, jpeg, webp and gif are accepted, judged by the file header, not the extension, up to 10MB. Returns the image plus its size and pixel dimensions. Use it when a message points at a screenshot or image path, before you describe or change anything on screen.",
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          maxLength: 1024,
          description: 'Absolute path of the image, e.g. /tmp/shot.png',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const raw = (params as { path?: unknown } | undefined)?.path;
      const requested = typeof raw === 'string' ? raw : '';
      const outcome = await readImageView(deps, requested);
      if (!outcome.ok) {
        return {
          content: [{ type: 'text' as const, text: outcome.error }],
          details: undefined,
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              path: outcome.path,
              size: outcome.size,
              width: outcome.facts.width,
              height: outcome.facts.height,
              mimeType: outcome.facts.mimeType,
            }),
          },
          { type: 'image' as const, data: outcome.data, mimeType: outcome.facts.mimeType },
        ],
        details: undefined,
      };
    },
  } as ToolDefinition;
}
