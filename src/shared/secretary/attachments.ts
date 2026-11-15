/**
 * session_send 转发图片：投递的是路径，不是字节。
 * 目标会话自己用 image_view 读，所以追加的引用块必须把路径写全，并说清怎么用。
 */

export interface ForwardedImage {
  /** 解析后的真实路径 */
  path: string;
  size: number;
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
