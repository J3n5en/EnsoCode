/**
 * 用户发给秘书的图片落盘后，以路径行追加在消息末尾，秘书据此用 session_send 的 attachments 原图转发。
 * 收不下的图片也占一行写明原因，不静默丢掉。界面比对乐观回显时按同一格式剥掉这一块。
 */
import type { ContactLang } from './contact';

export type InboundImageRejection = 'too-large' | 'not-image' | 'unavailable';

export type InboundImageLine = { path: string } | { rejected: InboundImageRejection };

const REJECTION_TEXT: Record<InboundImageRejection, string> = {
  'too-large': '超过 10MB，没有保存',
  'not-image': '不是 png / jpeg / webp / gif 图片，没有保存',
  unavailable: '没能保存',
};

export function formatInboundImageLines(lines: readonly InboundImageLine[]): string {
  return lines
    .map((line, index) =>
      'path' in line
        ? `[图片 ${index + 1}] ${line.path}`
        : `[图片 ${index + 1} 未收下] ${REJECTION_TEXT[line.rejected]}`
    )
    .join('\n');
}

export function appendInboundImageLines(text: string, lines: readonly InboundImageLine[]): string {
  if (lines.length === 0) return text;
  const block = formatInboundImageLines(lines);
  return text ? `${text}\n\n${block}` : block;
}

/** 一行路径行的正则源码：入站包裹的解析器拼进自己的正则 */
export const INBOUND_IMAGE_LINE = String.raw`\[图片 \d+(?: 未收下)?\] [^\n]*`;
const TRAILING_BLOCK = new RegExp(
  String.raw`(?:^|\n\n)${INBOUND_IMAGE_LINE}(?:\n${INBOUND_IMAGE_LINE})*$`,
  'u'
);

export function stripInboundImageLines(text: string): string {
  return text.replace(TRAILING_BLOCK, '');
}

/** 从路径行里取回已保存的图片路径 */
export function parseInboundImagePaths(block: string): string[] {
  return [...block.matchAll(/^\[图片 \d+\] (.+)$/gmu)].map((match) => match[1] as string);
}

/** 手机上收不下图片时回给对方的一句话 */
export function inboundImageNotice(
  rejected: readonly InboundImageRejection[],
  lang: ContactLang
): string {
  const tooLarge = rejected.includes('too-large');
  const notImage = rejected.includes('not-image');
  if (lang === 'zh') {
    const why = [tooLarge ? '超过 10MB' : '', notImage ? '不是图片' : ''].filter(Boolean);
    return `有 ${rejected.length} 个附件没收下${why.length ? `（${why.join('、')}）` : ''}。只收 10MB 以内的 png / jpeg / webp / gif 图片。`;
  }
  const why = [tooLarge ? 'over 10 MB' : '', notImage ? 'not an image' : ''].filter(Boolean);
  return `${rejected.length} attachment(s) were not accepted${why.length ? ` (${why.join(', ')})` : ''}. Only png, jpeg, webp or gif images up to 10 MB are accepted.`;
}
