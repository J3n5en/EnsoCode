import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  type BotMediaError,
  type BotMediaSource,
  isMediaId,
  SEND_IMAGE_CAPTION_MAX,
} from '@shared/bots/sendImage';
import type { BotChat } from '@shared/types/bot';
import { resolveArtifactFile } from './artifacts';

export const MEDIA_FILE_MAX = 10 * 1024 * 1024;
export const MEDIA_CHAT_QUOTA = 200 * 1024 * 1024;
/** 读入内存前的硬上限：再大的原图不尝试压缩 */
const MEDIA_READ_MAX = 64 * 1024 * 1024;
const SCREENSHOT_KEEP = 3;
const PATH_MAX = 1024;

export type ImageExt = 'png' | 'jpg' | 'gif' | 'webp';

/** 按文件头判断格式，不信扩展名；SVG 等文本格式不收 */
export function sniffImage(data: Buffer): ImageExt | null {
  if (
    data.length >= 8 &&
    data.readUInt32BE(0) === 0x89504e47 &&
    data.readUInt32BE(4) === 0x0d0a1a0a
  )
    return 'png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString('latin1'))) return 'gif';
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'webp';
  return null;
}

export interface CachedScreenshot {
  data: Buffer;
  source: Exclude<BotMediaSource, 'file'>;
}

/** 按会话缓存最近 3 张截图（新的在前）；会话数 LRU 封顶，只在内存 */
export class ScreenshotCache {
  private readonly sessions = new Map<string, CachedScreenshot[]>();

  constructor(private readonly maxSessions = 16) {}

  push(sessionId: string, shot: CachedScreenshot): void {
    const list = [shot, ...(this.sessions.get(sessionId) ?? [])].slice(0, SCREENSHOT_KEEP);
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, list);
    while (this.sessions.size > this.maxSessions)
      this.sessions.delete(this.sessions.keys().next().value as string);
  }

  /** nth：1 = 最近一张 */
  pick(sessionId: string, nth: number): CachedScreenshot | undefined {
    return this.sessions.get(sessionId)?.[nth - 1];
  }
}

function regularFile(file: string): { size: number } | null {
  try {
    const stat = lstatSync(file);
    return stat.isFile() ? { size: stat.size } : null;
  } catch {
    return null;
  }
}

/** media 目录里的图片文件：id 必须是内容哈希名，且是普通文件（不跟符号链接） */
export function mediaFile(dir: string, mediaId: string): string | null {
  if (!isMediaId(mediaId)) return null;
  const file = path.join(dir, mediaId);
  return regularFile(file) ? file : null;
}

/** 工作区内的图片：只收相对路径，解析符号链接后仍须在根内 */
export function resolveWorkspaceImage(root: string, rel: string): string | null {
  if (!rel || rel.length > PATH_MAX || path.isAbsolute(rel) || rel.startsWith('~')) return null;
  return resolveArtifactFile(root, rel);
}

/** 工作区外的图片：只收绝对路径（worker 已按审批档位确认），解析后须是普通文件 */
function resolveOutsideImage(file: string): string | null {
  if (file.length > PATH_MAX || !path.isAbsolute(file)) return null;
  try {
    const target = realpathSync(file);
    return regularFile(target) ? target : null;
  } catch {
    return null;
  }
}

function mediaUsage(dir: string): number {
  let total = 0;
  try {
    for (const name of readdirSync(dir)) total += regularFile(path.join(dir, name))?.size ?? 0;
  } catch {
    // 目录还没建
  }
  return total;
}

export interface StoreOptions {
  /** 超过单张上限时压缩；失败返回 null */
  compress(data: Buffer): Buffer | null;
  fileMax?: number;
  quota?: number;
}

export type StoreResult =
  | { ok: true; mediaId: string }
  | { ok: false; error: BotMediaError | 'not-image' };

/** 按内容哈希复制进聊天 media 目录：同图去重；满额拒收、不删旧图 */
export function storeMedia(dir: string, input: Buffer, options: StoreOptions): StoreResult {
  const fileMax = options.fileMax ?? MEDIA_FILE_MAX;
  const quota = options.quota ?? MEDIA_CHAT_QUOTA;
  let data = input;
  let ext = sniffImage(data);
  if (!ext) return { ok: false, error: 'not-image' };
  if (data.length > fileMax) {
    const compressed = options.compress(data);
    const compressedExt = compressed ? sniffImage(compressed) : null;
    if (!compressed || !compressedExt || compressed.length > fileMax)
      return { ok: false, error: 'too-large' };
    data = compressed;
    ext = compressedExt;
  }
  const mediaId = `${createHash('sha256').update(data).digest('hex')}.${ext}`;
  const file = path.join(dir, mediaId);
  if (regularFile(file)) return { ok: true, mediaId };
  if (mediaUsage(dir) + data.length > quota) return { ok: false, error: 'quota' };
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
  return { ok: true, mediaId };
}

export interface SendImageDeps {
  chat(chatId: string): BotChat | undefined;
  mediaDir(chatId: string): string;
  /** 会话所属项目的本地根；SSH 等不可用时为 null */
  workspaceRoot(): string | null;
  screenshots: ScreenshotCache;
  compress(data: Buffer): Buffer | null;
  limits?: { fileMax?: number; quota?: number };
}

export type SendImageResult =
  | {
      ok: true;
      mediaId: string;
      source: BotMediaSource;
      name?: string;
      caption?: string;
      message: string;
    }
  | {
      ok: false;
      error: string;
      source?: BotMediaSource;
      name?: string;
      caption?: string;
      message?: string;
    };

const fail = (error: string): SendImageResult => ({ ok: false, error });

/** worker 的 send_image：chatId 只取会话权威绑定，且必须是该成员在该聊天的当前（非委派）会话 */
export function sendImage(
  deps: SendImageDeps,
  conversationId: string,
  binding: { botId: string; chatId: string | null; delegationId?: string },
  params: Record<string, unknown>
): SendImageResult {
  const chat = binding.chatId ? deps.chat(binding.chatId) : undefined;
  if (
    !chat ||
    binding.delegationId ||
    !chat.members.includes(binding.botId) ||
    chat.sessions[binding.botId]?.conversationId !== conversationId
  )
    return fail('send_image is only available in your current chat session.');
  const { path: rel, screenshot, caption: rawCaption } = params;
  const hasPath = rel !== undefined;
  const hasShot = screenshot !== undefined;
  if (hasPath === hasShot) return fail('Pass exactly one of path or screenshot.');
  if (rawCaption !== undefined && typeof rawCaption !== 'string')
    return fail('caption must be a string.');
  const caption = rawCaption?.trim().slice(0, SEND_IMAGE_CAPTION_MAX) || undefined;
  let data: Buffer;
  let source: BotMediaSource;
  let name: string | undefined;
  if (hasPath) {
    if (typeof rel !== 'string' || !rel.trim()) return fail('path must be a non-empty string.');
    const root = deps.workspaceRoot();
    if (!root) return fail('Workspace images are not available in this chat.');
    const target = rel.trim();
    const outside = path.isAbsolute(target);
    const file = outside ? resolveOutsideImage(target) : resolveWorkspaceImage(root, target);
    if (!file)
      return fail(
        outside
          ? 'Image file not found.'
          : 'Image not found inside the workspace. Use a workspace-relative path, or an absolute path for files outside the workspace.'
      );
    source = 'file';
    name = outside ? file : path.relative(realRoot(root), file) || path.basename(file);
    if (statSync(file).size > MEDIA_READ_MAX)
      return { ok: false, error: 'too-large', source, name, ...(caption ? { caption } : {}) };
    data = readFileSync(file);
  } else {
    if (!Number.isInteger(screenshot) || (screenshot as number) < 1 || (screenshot as number) > 3)
      return fail('screenshot must be 1, 2 or 3 (1 = the most recent).');
    const shot = deps.screenshots.pick(conversationId, screenshot as number);
    if (!shot)
      return fail(
        'No such recent screenshot in this session. Take one with browser_screenshot (or computer) first.'
      );
    data = shot.data;
    source = shot.source;
  }
  const stored = storeMedia(deps.mediaDir(chat.id), data, {
    compress: deps.compress,
    ...deps.limits,
  });
  const extra = { ...(name ? { name } : {}), ...(caption ? { caption } : {}) };
  if (stored.ok)
    return {
      ok: true,
      mediaId: stored.mediaId,
      source,
      ...extra,
      message: 'Image posted under your reply. Do not repeat the mediaId in your reply text.',
    };
  if (stored.error === 'not-image') return fail('Not a PNG, JPEG, GIF or WebP image.');
  return {
    ok: false,
    error: stored.error,
    source,
    ...extra,
    message:
      stored.error === 'quota'
        ? 'The chat image storage (200 MiB) is full; the image was not sent. Tell the user.'
        : 'The image is over 10 MiB even after compression; it was not sent.',
  };
}

function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}
