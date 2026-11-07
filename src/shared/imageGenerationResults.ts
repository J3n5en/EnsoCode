import { IMAGE_EXTENSIONS } from './localImage';

const extensions = new Set<string>(IMAGE_EXTENSIONS);

function isPreviewPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.includes('\0')) return false;
  const normalized = value.replaceAll('\\', '/');
  return (
    !normalized.startsWith('//') &&
    (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) &&
    extensions.has(normalized.slice(normalized.lastIndexOf('.') + 1).toLowerCase())
  );
}

/** 跨 worker 的图片元数据只含本地图片路径，不接受 URL 或网络共享。 */
export function parseGeneratedImagePaths(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 640 || !value.every(isPreviewPath)) return null;
  return [...new Set(value)];
}

/** 从 ImageGen 的 JSON 回执提取已落盘图片，也用于恢复旧会话。 */
export function imageGenerationPreviewPaths(output: string): string[] {
  try {
    const value = JSON.parse(output);
    if (!value || !Array.isArray(value.items)) return [];
    return [
      ...new Set<string>(
        value.items.flatMap((item: unknown) => {
          if (!item || typeof item !== 'object') return [];
          const entry = item as Record<string, unknown>;
          return entry.status === 'success' &&
            isPreviewPath(entry.path) &&
            typeof entry.mimeType === 'string' &&
            entry.mimeType.startsWith('image/')
            ? [entry.path]
            : [];
        })
      ),
    ].slice(0, 10);
  } catch {
    return [];
  }
}
