import { CONTACT_OUTBOUND_MAX_CHARS } from './contact';

/**
 * 秘书的回复是 markdown，Telegram 只认它自己那套标记。
 * 这里转成 HTML（比 MarkdownV2 少一半转义坑），并按 4096 上限切条。
 */

export interface TelegramBlock {
  html: string;
  /** 代码块：切条时不能从中间断开 */
  pre: boolean;
}

export interface TelegramChunk {
  html: string;
  /** 解析失败时原样重发用 */
  plain: string;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/** 行内标记：先整体转义，再换标记，标记本身不含会被转义的字符 */
function inline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`\n]+)`/gu, (_m, code: string) => `<code>${code}</code>`);
  out = out.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)\)/gu,
    (_m, label: string, url: string) => `<a href="${url.replace(/"/gu, '&quot;')}">${label}</a>`
  );
  out = out.replace(/\*\*([^*\n]+)\*\*/gu, '<b>$1</b>');
  out = out.replace(/~~([^~\n]+)~~/gu, '<s>$1</s>');
  out = out.replace(/\*([^*\n]+)\*/gu, '<i>$1</i>');
  out = out.replace(/(^|[\s(（【])_([^_\n]+)_(?=[\s).,，。!?！？]|$)/gu, '$1<i>$2</i>');
  return out;
}

/** 表格按列宽对齐成等宽文本：Telegram 没有表格，但对齐后照样读得懂 */
function alignTable(rows: string[][]): string {
  const width = Math.max(...rows.map((row) => row.length), 1);
  const sizes = Array.from({ length: width }, (_v, column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length), 1)
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(sizes[column] ?? 1))
        .join('  ')
        .trimEnd()
    )
    .join('\n');
}

function tableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/u, '').replace(/\|$/u, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

const TABLE_SEPARATOR = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/u;
const FENCE = /^\s*(```|~~~)/u;

export function markdownToTelegramBlocks(markdown: string): TelegramBlock[] {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: TelegramBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (FENCE.test(line)) {
      const marker = (FENCE.exec(line)?.[1] ?? '```')[0];
      const body: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !new RegExp(`^\\s*${marker}{3}\\s*$`, 'u').test(lines[index] ?? '')
      ) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      blocks.push({ html: `<pre>${escapeHtml(body.join('\n'))}</pre>`, pre: true });
      continue;
    }
    if (/^\s*\|/u.test(line) && TABLE_SEPARATOR.test(lines[index + 1] ?? '')) {
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|/u.test(lines[index] ?? '')) {
        const row = lines[index] ?? '';
        if (!TABLE_SEPARATOR.test(row)) rows.push(tableRow(row));
        index += 1;
      }
      blocks.push({ html: `<pre>${escapeHtml(alignTable(rows))}</pre>`, pre: true });
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/u.exec(line);
    if (heading) {
      blocks.push({ html: `<b>${inline(heading[1] ?? '')}</b>`, pre: false });
      index += 1;
      continue;
    }
    if (/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/u.test(line)) {
      blocks.push({ html: '———', pre: false });
      index += 1;
      continue;
    }
    if (/^\s{0,3}>/u.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s{0,3}>/u.test(lines[index] ?? '')) {
        body.push((lines[index] ?? '').replace(/^\s{0,3}>\s?/u, ''));
        index += 1;
      }
      blocks.push({ html: `<blockquote>${body.map(inline).join('\n')}</blockquote>`, pre: false });
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/u.exec(line);
    if (bullet) {
      const indent = ' '.repeat(Math.min((bullet[1] ?? '').length, 6));
      blocks.push({ html: `${indent}• ${inline(bullet[2] ?? '')}`, pre: false });
      index += 1;
      continue;
    }
    const ordered = /^(\s*)(\d{1,3})[.)]\s+(.*)$/u.exec(line);
    if (ordered) {
      const indent = ' '.repeat(Math.min((ordered[1] ?? '').length, 6));
      blocks.push({ html: `${indent}${ordered[2]}. ${inline(ordered[3] ?? '')}`, pre: false });
      index += 1;
      continue;
    }
    blocks.push({ html: inline(line), pre: false });
    index += 1;
  }
  return blocks;
}

/** 在空格或换行处切，别切在标签中间 */
function hardSplit(text: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    const open = rest.lastIndexOf('<', cut);
    if (open !== -1 && rest.indexOf('>', open) > cut) cut = open;
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/** 超长代码块拆成几段 <pre>，内容一行不丢 */
function splitPre(html: string, limit: number): string[] {
  const inner = html.replace(/^<pre>/u, '').replace(/<\/pre>$/u, '');
  const budget = limit - '<pre></pre>'.length;
  const chunks: string[] = [];
  let current = '';
  for (const line of inner.split('\n')) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > budget) {
      if (current) chunks.push(current);
      current = line.length > budget ? '' : line;
      if (!current) chunks.push(...hardSplit(line, budget));
      continue;
    }
    current = next;
  }
  if (current) chunks.push(current);
  return chunks.map((chunk) => `<pre>${chunk}</pre>`);
}

export function packTelegramBlocks(
  blocks: TelegramBlock[],
  limit = CONTACT_OUTBOUND_MAX_CHARS
): string[] {
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current) chunks.push(current);
    current = '';
  };
  for (const block of blocks) {
    if (block.pre && block.html.length > limit) {
      flush();
      chunks.push(...splitPre(block.html, limit));
      continue;
    }
    const next = current ? `${current}\n${block.html}` : block.html;
    if (next.length > limit) {
      flush();
      current = block.html;
    } else {
      current = next;
    }
  }
  flush();
  return chunks.flatMap((chunk) => (chunk.length > limit ? hardSplit(chunk, limit) : [chunk]));
}

/** 已经是 HTML 的回复（只读命令）按行切条，不再过一遍 markdown */
export function packTelegramHtml(html: string, limit = CONTACT_OUTBOUND_MAX_CHARS): string[] {
  if (html.length <= limit) return [html];
  return packTelegramBlocks(
    html.split('\n').map((line) => ({ html: line, pre: false })),
    limit
  );
}

export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]+>/gu, '')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&amp;/gu, '&');
}

export function markdownToTelegramChunks(
  markdown: string,
  limit = CONTACT_OUTBOUND_MAX_CHARS
): TelegramChunk[] {
  return packTelegramBlocks(markdownToTelegramBlocks(markdown), limit).map((html) => ({
    html,
    plain: htmlToPlain(html),
  }));
}

export function markdownToTelegramHtml(markdown: string): string {
  return packTelegramBlocks(markdownToTelegramBlocks(markdown)).join('\n');
}
