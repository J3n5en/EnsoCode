/**
 * 选中文本引用块的 wire 形态（发给模型的上下文）：
 *   <quote>\n正文\n</quote>
 *   <quote truncated="true" original-lines="N">\n前若干行\n</quote>
 * 界面一律解析后渲染，标签不得原样展示；正文里的 </quote> 转义为 <\/quote>。
 */
export interface QuoteBlock {
  text: string;
  /** 有值 = 已截断，原文总行数 */
  originalLines?: number;
}

export const INLINE_QUOTE_REF =
  /<quote(?: truncated="true" original-lines="(\d+)")?>\n([\s\S]*?)\n<\/quote>/g;

export function formatQuoteBlock(quote: QuoteBlock): string {
  const attrs = quote.originalLines
    ? ` truncated="true" original-lines="${quote.originalLines}"`
    : '';
  return `<quote${attrs}>\n${quote.text.replace(/<\/quote>/g, '<\\/quote>')}\n</quote>`;
}

export function quoteFromMatch(match: RegExpMatchArray): QuoteBlock {
  const text = match[2].replace(/<\\\/quote>/g, '</quote>');
  return match[1] ? { text, originalLines: Number(match[1]) } : { text };
}

export function hasQuoteBlock(text: string): boolean {
  return text.search(INLINE_QUOTE_REF) >= 0;
}

/** 引用块 → Markdown 引用（复制 / 纯文本展示） */
export function quotesAsMarkdown(text: string): string {
  return text.replace(INLINE_QUOTE_REF, (...args) => {
    const quote = quoteFromMatch(args as unknown as RegExpMatchArray);
    const body = quote.text.replace(/^/gm, '> ');
    return quote.originalLines ? `${body}\n> …` : body;
  });
}

/** 标题用：去掉引用块；只剩引用时退回引用正文 */
export function withoutQuoteBlocks(text: string): string {
  const rest = text.replace(INLINE_QUOTE_REF, '').trim();
  if (rest) return rest;
  return [...text.matchAll(INLINE_QUOTE_REF)].map((m) => quoteFromMatch(m).text).join('\n');
}
