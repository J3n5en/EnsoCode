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

/** Telegram 只接受这几种 href，其余（file://、conversation://…）发过去整条 400 */
const TELEGRAM_HREF = /^(?:https?:\/\/|tg:\/\/|mailto:)/iu;
/** 占位槽的分隔符；用户输入里的 NUL 先剔掉，不会撞槽 */
const NUL = String.fromCharCode(0);
const SLOT = new RegExp(`${NUL}(\\d+)${NUL}`, 'gu');
const TAG = /<(\/?)([a-z][a-z0-9-]*)[^>]*>/giu;

/** 片段里的标签是否成对且正确嵌套 */
function balanced(html: string): boolean {
  const stack: string[] = [];
  for (const match of html.matchAll(TAG)) {
    const name = match[2] ?? '';
    if (match[1]) {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

/**
 * 行内标记：代码和链接先整体换成占位槽（内容不再参与后续替换），
 * 其余文本整体转义后再换粗体/删除线/斜体，最后把槽填回去。
 */
function inline(text: string): string {
  const slots: string[] = [];
  const slot = (html: string) => {
    slots.push(html);
    return `${NUL}${slots.length - 1}${NUL}`;
  };
  const restore = (html: string): string => {
    let out = html;
    // 槽最多嵌两层（链接文字里的行内代码）；兜底剔掉残留 NUL，避免死循环
    for (let depth = 0; depth < 4 && out.includes(NUL); depth += 1) {
      out = out.replace(SLOT, (_m, index: string) => slots[Number(index)] ?? '');
    }
    return out.split(NUL).join('');
  };
  let out = text.split(NUL).join('');
  out = out.replace(/`([^`\n]+)`/gu, (_m, code: string) =>
    slot(`<code>${escapeHtml(code)}</code>`)
  );
  out = escapeHtml(out);
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/gu, (_m, label: string, url: string) => {
    if (TELEGRAM_HREF.test(url)) {
      return slot(`<a href="${url.replace(/"/gu, '&quot;')}">${restore(label)}</a>`);
    }
    if (/^file:\/\//iu.test(url)) {
      return slot(`<code>${restore(label).replace(/<\/?code>/gu, '')}</code>`);
    }
    return label;
  });
  // 每一步只包住本身成对的片段，保证结果始终是合法嵌套
  // pattern 固定两组：(前导)(正文)
  const wrap = (pattern: RegExp, tag: string) => {
    out = out.replace(pattern, (match: string, lead: string, body: string) =>
      balanced(body) ? `${lead}<${tag}>${body}</${tag}>` : match
    );
  };
  wrap(/()\*\*([^*\n]+)\*\*/gu, 'b');
  wrap(/()~~([^~\n]+)~~/gu, 's');
  wrap(/()\*([^*\n]+)\*/gu, 'i');
  wrap(/(^|[\s(（【])_([^_\n]+)_(?=[\s).,，。!?！？]|$)/gu, 'i');
  return restore(out);
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
      const title = inline(heading[1] ?? '').replace(/<\/?b>/gu, '');
      blocks.push({ html: `<b>${title}</b>`, pre: false });
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

interface OpenTag {
  name: string;
  text: string;
}

const closeTags = (stack: OpenTag[]) =>
  stack
    .slice()
    .reverse()
    .map((tag) => `</${tag.name}>`)
    .join('');
const reopenTags = (stack: OpenTag[]) => stack.map((tag) => tag.text).join('');

/**
 * 超长单段硬切：按「标签 / 实体 / 单个字符」切词，绝不切在标签或实体中间；
 * 切点处仍开着的标签在本段末尾补闭合，下一段开头原样重开，每段都是合法 HTML。
 * 优先切在空白处。
 */
function hardSplit(text: string, limit: number): string[] {
  const tokens = text.match(/<[^>]*>|&#?[a-z0-9]+;|[\s\S]/giu) ?? [];
  const pieces: string[] = [];
  let stack: OpenTag[] = [];
  let current = '';
  let contentStart = 0;
  let closeCost = 0;
  let lastBreak: { pos: number; next: number; stack: OpenTag[] } | null = null;

  const start = (nextStack: OpenTag[]) => {
    stack = nextStack;
    current = reopenTags(stack);
    contentStart = current.length;
    closeCost = closeTags(stack).length;
    lastBreak = null;
  };
  const emit = (body: string, openStack: OpenTag[]) => {
    const trimmed = body.trimEnd();
    // 只剩标签没有正文的段不发
    if (!trimmed.replace(/<[^>]*>/gu, '').trim()) return;
    pieces.push(`${trimmed}${closeTags(openStack)}`);
  };

  start([]);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? '';
    // 段首不留空白
    if (current.length === contentStart && /^\s$/u.test(token)) {
      index += 1;
      continue;
    }
    const tag = /^<(\/?)([a-z][a-z0-9-]*)[^>]*>$/iu.exec(token);
    const closing = tag?.[1] === '/';
    const extra = tag && !closing ? `</${tag[2]}>`.length : 0;
    const fits = current.length + token.length + closeCost + extra <= limit;
    if (!closing && !fits && current.length > contentStart) {
      const cut: { pos: number; next: number; stack: OpenTag[] } | null = lastBreak;
      if (cut && cut.pos - contentStart >= (limit - contentStart) / 2) {
        emit(current.slice(0, cut.pos), cut.stack);
        index = cut.next;
        start(cut.stack);
      } else {
        emit(current, stack);
        start(stack.slice());
      }
      continue;
    }
    if (tag && closing) {
      const top = stack[stack.length - 1];
      if (top && top.name === tag[2]) {
        stack = stack.slice(0, -1);
        closeCost -= token.length;
      }
    } else if (tag) {
      stack = [...stack, { name: tag[2] ?? '', text: token }];
      closeCost += extra;
    } else if (/^\s$/u.test(token)) {
      lastBreak = { pos: current.length, next: index + 1, stack };
    }
    current += token;
    index += 1;
  }
  emit(current, stack);
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
