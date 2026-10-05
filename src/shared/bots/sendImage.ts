/** 成员用 send_image 发进聊天的图：每条回复最多 4 张，只认 send_image 工具结果 */
export const SEND_IMAGE_PER_REPLY = 4;
export const SEND_IMAGE_CAPTION_MAX = 200;

export function imageSendErrorText(error: string): string | undefined {
  switch (error) {
    case 'image-quota':
      return 'Chat image storage is full (200MiB). Message not sent.';
    case 'image-too-large':
      return 'An image is still over 10MiB after compression. Message not sent.';
    case 'image-not-image':
      return 'An attachment is not a supported image. Message not sent.';
    case 'image-storage':
      return 'Could not save the images. Message not sent. Please try again.';
    default:
      return undefined;
  }
}

/** upload：人在群聊里随消息发的图（不出现在 send_image 结果里） */
export type BotMediaSource = 'file' | 'web' | 'desktop' | 'upload';
export type BotMediaError = 'too-large' | 'quota';

/** ok：已复制到聊天 media 目录；失败项只保留可展示的两类（压不下来 / 群空间已满） */
export type BotMediaItem =
  | { ok: true; mediaId: string; source: BotMediaSource; name?: string; caption?: string }
  | { ok: false; error: BotMediaError; source: BotMediaSource; name?: string; caption?: string };

const MEDIA_ID_RE = /^[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/;
const SOURCES: readonly string[] = ['file', 'web', 'desktop'];
const ERRORS: readonly string[] = ['too-large', 'quota'];

export const isMediaId = (value: unknown): value is string =>
  typeof value === 'string' && MEDIA_ID_RE.test(value);

const optionalText = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

/** 结果是单行 JSON；withSourceReference 会在其后追加 <source_reference> 行 */
export function parseSendImageResult(text: string): BotMediaItem | null {
  let value: unknown;
  try {
    value = JSON.parse(text.split('\n', 1)[0]);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.source !== 'string' || !SOURCES.includes(raw.source)) return null;
  const source = raw.source as BotMediaSource;
  const name = optionalText(raw.name, 1024);
  const caption = optionalText(raw.caption, SEND_IMAGE_CAPTION_MAX);
  const extra = { ...(name ? { name } : {}), ...(caption ? { caption } : {}) };
  if (raw.ok === true && isMediaId(raw.mediaId))
    return { ok: true, mediaId: raw.mediaId, source, ...extra };
  if (raw.ok === false && typeof raw.error === 'string' && ERRORS.includes(raw.error))
    return { ok: false, error: raw.error as BotMediaError, source, ...extra };
  return null;
}

interface MessageLike {
  role: string;
  toolName?: string;
  content: readonly { type: string; text?: string }[] | unknown;
}

function resultText(message: MessageLike): string {
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part: { type?: string; text?: unknown }) =>
      part?.type === 'text' && typeof part.text === 'string' ? part.text : ''
    )
    .join('');
}

/** 一轮消息里 send_image 的结果（正文里的同形文本不算），按 mediaId 去重，最多 4 张 */
export function sendImageItems(messages: readonly MessageLike[]): BotMediaItem[] {
  const out: BotMediaItem[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (out.length >= SEND_IMAGE_PER_REPLY) break;
    if (message.role !== 'toolResult' || message.toolName !== 'send_image') continue;
    const item = parseSendImageResult(resultText(message));
    if (!item) continue;
    if (item.ok) {
      if (seen.has(item.mediaId)) continue;
      seen.add(item.mediaId);
    }
    out.push(item);
  }
  return out;
}
