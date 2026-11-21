/**
 * 用户发给秘书的图片落盘后，以路径行追加在消息末尾，秘书据此用 session_send 的 attachments 原图转发。
 * 收不下的图片也占一行写明原因，不静默丢掉。界面比对乐观回显时按同一格式剥掉这一块。
 */

import { SECRETARY_IMAGES_REL } from '../resources';
import type { ContactLang } from './contact';

export type InboundImageRejection = 'too-large' | 'not-image' | 'unavailable';

export type InboundImageLine = { path: string } | { rejected: InboundImageRejection };

/** 界面解析回来的一行：index 即 `[图片 N]` 的 N */
export type InboundImageEntry =
  | { index: number; path: string }
  | { index: number; rejected: InboundImageRejection };

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

const REJECTION_OF = new Map(
  Object.entries(REJECTION_TEXT).map(([kind, text]) => [text, kind as InboundImageRejection])
);

function isSavedImagePath(value: string): boolean {
  const normalized = value.replace(/\\/gu, '/');
  return (
    /^(?:\/|[A-Za-z]:\/)/u.test(normalized) && normalized.includes(`/${SECRETARY_IMAGES_REL}/`)
  );
}

/**
 * 严格按 formatInboundImageLines 的格式解析一整块：从 1 连续编号，
 * 路径须在秘书图片目录下，原因须是固定文案；有一行对不上就整块不认。
 */
export function parseInboundImageEntries(block: string): InboundImageEntry[] | null {
  const entries: InboundImageEntry[] = [];
  for (const [i, row] of block.split('\n').entries()) {
    const match = /^\[图片 (\d+)( 未收下)?\] (.+)$/u.exec(row);
    if (!match || Number(match[1]) !== i + 1) return null;
    const value = match[3] as string;
    if (match[2]) {
      const rejected = REJECTION_OF.get(value);
      if (!rejected) return null;
      entries.push({ index: i + 1, rejected });
    } else {
      if (!isSavedImagePath(value)) return null;
      entries.push({ index: i + 1, path: value });
    }
  }
  return entries;
}

// 路径块之后 pi 可能再追加 `[Image …]` 转换提示
const DISPLAY_BLOCK = new RegExp(
  String.raw`(?:^|\n\n)(${INBOUND_IMAGE_LINE}(?:\n${INBOUND_IMAGE_LINE})*)` +
    String.raw`((?:\n\n\[Image[^\n]*\](?:\n\[Image[^\n]*\])*)?)$`,
  'u'
);

/** 界面用：把正文末尾 Main 追加的路径块拆出来，正文其余部分（含 pi 提示）原样返回 */
export function splitInboundImageBlock(
  text: string
): { text: string; entries: InboundImageEntry[] } | null {
  const match = DISPLAY_BLOCK.exec(text);
  if (!match) return null;
  const entries = parseInboundImageEntries(match[1] as string);
  if (!entries) return null;
  const body = text.slice(0, match.index);
  const hints = match[2] ?? '';
  return { text: body ? `${body}${hints}` : hints.replace(/^\n\n/u, ''), entries };
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
