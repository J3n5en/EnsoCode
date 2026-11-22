/**
 * 秘书转发图片（session_send / session_create / todo_item_dispatch）：
 * 目标模型能看图时，图片作为图片块随消息发出，正文末尾留 `[图片 N] 路径` 方便再引用；
 * 不能看图时只给路径，并说清怎么用 image_view 看。
 */
import { formatInboundImageLines } from './inboundImages';

export interface ForwardedImage {
  /** 解析后的真实路径 */
  path: string;
  size: number;
}

/** 已读出字节的转发图片 */
export interface LoadedImage extends ForwardedImage {
  data: string;
  mimeType: string;
}

/** 等待中的派发真正开始时已读不到的图 */
export interface UnavailableImage {
  path: string;
  reason: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 追加在消息末尾的图片引用块 */
export function formatAttachmentBlock(images: readonly ForwardedImage[], canView: boolean): string {
  const lines = images.map((image, index) => `[图片 ${index + 1}] ${image.path}`);
  lines.push(
    canView
      ? '用 image_view 查看这些图片。'
      : '当前会话无法查看图片（没有 image_view），请让用户把图片贴进对话或放进工作区。'
  );
  return lines.join('\n');
}

/** 审计用的一行摘要：只记路径与大小，不记图片内容 */
export function describeForwardedImages(images: readonly ForwardedImage[]): string {
  return images.map((image) => `${image.path} (${formatSize(image.size)})`).join(', ');
}

function unavailableNote(unavailable: readonly UnavailableImage[]): string {
  if (unavailable.length === 0) return '';
  const lines = unavailable.map((item) => `- ${item.path}（${item.reason}）`);
  return `\n\n以下图片在派发开始时已不可用，没有附上：\n${lines.join('\n')}`;
}

/**
 * 拼出要投递的消息。路径块必须在正文最末，界面才能按 `[图片 N]` 拆出来换成缩略图。
 * inline：目标模型能看图；canView：不能看图时目标会话有没有 image_view。
 */
export function forwardedMessage(
  text: string,
  images: readonly LoadedImage[],
  options: { inline: boolean; canView: boolean; unavailable?: readonly UnavailableImage[] }
): { text: string; images?: { data: string; mimeType: string }[] } {
  const body = `${text}${unavailableNote(options.unavailable ?? [])}`;
  if (images.length === 0) return { text: body };
  if (!options.inline)
    return { text: `${body}\n\n${formatAttachmentBlock(images, options.canView)}` };
  return {
    text: `${body}\n\n${formatInboundImageLines(images.map((image) => ({ path: image.path })))}`,
    images: images.map((image) => ({ data: image.data, mimeType: image.mimeType })),
  };
}
