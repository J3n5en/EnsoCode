import { toLocalImageUrl } from '@shared/localImage';

/** 工具结果里的图片块：按引用传递原 base64，展开时才拼成 data URL */
export interface ToolImage {
  data: string;
  mimeType: string;
}

export interface ImageViewFacts {
  path: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
}

const VIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** 结果里第一个可显示的图片块，返回原对象以保持引用稳定（行 memo 靠它判等） */
export function toolImageOf(content: readonly unknown[]): ToolImage | undefined {
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const image = part as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (image.type !== 'image' || typeof image.data !== 'string' || !image.data) continue;
    if (typeof image.mimeType === 'string' && VIEWABLE.has(image.mimeType)) {
      return image as ToolImage;
    }
  }
  return undefined;
}

const num = (value: unknown) => (typeof value === 'number' ? value : null);

/** image_view 的元数据文本（可能带一行追加的 <source_reference>，只认第一行 JSON） */
export function parseImageViewFacts(output: string | null): ImageViewFacts | null {
  const line = output?.split('\n', 1)[0]?.trim();
  if (!line?.startsWith('{')) return null;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object') return null;
  const value = record as Record<string, unknown>;
  return {
    path: typeof value.path === 'string' && value.path ? value.path : null,
    size: num(value.size),
    width: num(value.width),
    height: num(value.height),
  };
}

const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u;

/**
 * 缩略图地址：优先用结果里的图片字节（远程客户端、文件已删也能看）。
 * 没有字节时只对成功调用、工具自己校验过并回报的绝对路径走 local-image 通道；
 * 调用参数里的路径没经过校验，不用。
 */
export function toolImageSrc(
  image: ToolImage | undefined,
  path: string | null | undefined,
  ok: boolean
): string | null {
  if (!ok) return null;
  if (image) return `data:${image.mimeType};base64,${image.data}`;
  return path && ABSOLUTE.test(path) ? toLocalImageUrl(path) : null;
}
