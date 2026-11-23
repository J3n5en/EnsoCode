import type { QuoteSegment } from './mentionComposer';

/** 超过即截断：约两屏代码，足够追问一段；更长的整段内容应走粘贴（≥5 万字转附件）或 @文件 */
export const QUOTE_MAX_LINES = 200;
/** 单行超长（压缩 JSON 等）的兜底上限 */
export const QUOTE_MAX_CHARS = 20_000;
const PREVIEW_LINES = 3;

const FENCE_LINE = /^```/gm;
const FENCE = /^```/;

/** 引用的行数：代码块按代码行计，包裹的围栏行不算 */
export function quoteLineCount(text: string): number {
  return text.split('\n').filter((line) => !FENCE.test(line)).length;
}

export function buildQuoteSegment(raw: string): QuoteSegment | null {
  const text = raw.replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '');
  if (!text.trim()) return null;
  const lines = text.split('\n');
  const total = quoteLineCount(text);
  if (total <= QUOTE_MAX_LINES && text.length <= QUOTE_MAX_CHARS) {
    return { type: 'quote', text };
  }
  let end = 0;
  for (let count = 0; end < lines.length; end++) {
    if (!FENCE.test(lines[end]) && ++count > QUOTE_MAX_LINES) break;
  }
  let kept = lines.slice(0, end).join('\n').slice(0, QUOTE_MAX_CHARS);
  // 截断切开了代码围栏就补上收尾，不让后面的正文被吞进代码块
  if ((kept.match(FENCE_LINE)?.length ?? 0) % 2 === 1) kept += '\n```';
  return { type: 'quote', text: kept, originalLines: total };
}

export function quotePreview(text: string): { preview: string; clipped: boolean } {
  const lines = text.split('\n');
  if (lines.length <= PREVIEW_LINES) return { preview: text, clipped: false };
  return { preview: lines.slice(0, PREVIEW_LINES).join('\n'), clipped: true };
}

/** 引用正文按代码围栏切段，气泡里代码段按代码块样式渲染 */
export function splitQuoteFences(
  text: string
): ({ type: 'text'; text: string } | { type: 'code'; code: string })[] {
  const parts: ({ type: 'text'; text: string } | { type: 'code'; code: string })[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/^```[^\n]*\n([\s\S]*?)\n?^```[ \t]*$/gm)) {
    const before = text.slice(cursor, match.index).replace(/^\n|\n$/g, '');
    if (before) parts.push({ type: 'text', text: before });
    parts.push({ type: 'code', code: match[1] });
    cursor = match.index + match[0].length;
  }
  const rest = text.slice(cursor).replace(/^\n/, '');
  if (rest || parts.length === 0) parts.push({ type: 'text', text: rest });
  return parts;
}

const CODE_BLOCK = '[data-enso="code-block"]';
/** 消息行里的界面元素（模型抬头、悬停操作条）：拖选越界时不进引用 */
const SKIP = '[data-quote-skip]';
const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'LI',
  'UL',
  'OL',
  'TR',
  'TABLE',
  'BLOCKQUOTE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'PRE',
]);

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

function fence(code: string, language: string | undefined): string {
  return `\`\`\`${language ?? ''}\n${code.replace(/\n+$/, '')}\n\`\`\``;
}

/** 片段里含代码块时自己拼文本：代码块转围栏，按钮等控件跳过，块级元素断行 */
function fragmentText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (!(node.nodeType === 1 || node.nodeType === 11)) return '';
  const element = node.nodeType === 1 ? (node as Element) : null;
  if (element?.tagName === 'BUTTON' || element?.matches(SKIP)) return '';
  if (element?.tagName === 'BR') return '\n';
  if (element?.matches(CODE_BLOCK)) {
    const code = element.querySelector('pre')?.textContent ?? element.textContent ?? '';
    return `\n${fence(code, element.getAttribute('data-language') ?? undefined)}\n`;
  }
  const inner = [...node.childNodes].map(fragmentText).join('');
  return element && BLOCK_TAGS.has(element.tagName) ? `${inner}\n` : inner;
}

/**
 * 当前选区 → 引用原文。只认时间线内、同一条消息内的非空选区：
 * 跨消息会把工具行、时间戳等界面元素一起带进来，且无法说明出处，不支持。
 */
export function selectionQuoteText(selection: Selection | null, container: Element): string | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const anchor = elementOf(selection.anchorNode);
  const focus = elementOf(selection.focusNode);
  if (!anchor || !focus || !container.contains(anchor) || !container.contains(focus)) return null;
  const row = anchor.closest('[data-nav-key]');
  if (!row || row !== focus.closest('[data-nav-key]')) return null;
  const plain = selection.toString();
  if (!plain.trim()) return null;
  const range = selection.getRangeAt(0);
  const codeBlock = elementOf(range.commonAncestorContainer)?.closest(CODE_BLOCK);
  if (codeBlock) return fence(plain, codeBlock.getAttribute('data-language') ?? undefined);
  const fragment = range.cloneContents();
  if (!fragment.querySelector(`${CODE_BLOCK}, ${SKIP}`)) return plain;
  return fragmentText(fragment)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface QuoteAnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const EDGE = 8;
const GAP = 6;

/**
 * 浮动按钮位置（fixed 坐标）：桌面放选区上方居中，放不下翻到下方；
 * 窄屏系统选择菜单在选区上方，按钮优先放下方。会盖住 obstacles（消息操作行等）时
 * 先换到另一侧，再往障碍物旁边让开，再贴到选区左右；都不行才退回默认位置。始终在视口内。
 */
export function quoteButtonPosition(
  rect: QuoteAnchorRect,
  viewport: { width: number; height: number },
  size: { width: number; height: number },
  mobile: boolean,
  obstacles: QuoteAnchorRect[] = []
): { top: number; left: number } {
  const clamp = (value: number, max: number) => Math.min(Math.max(EDGE, value), max);
  const maxTop = viewport.height - size.height - EDGE;
  const maxLeft = viewport.width - size.width - EDGE;
  const above = rect.top - size.height - GAP;
  const below = rect.bottom + GAP;
  const center = clamp((rect.left + rect.right) / 2 - size.width / 2, maxLeft);
  const tops = (mobile ? [below, above] : [above, below]).filter(
    (top) => top >= EDGE && top <= maxTop
  );
  const blocker = (top: number, left: number) =>
    obstacles.find(
      (o) =>
        left < o.right && left + size.width > o.left && top < o.bottom && top + size.height > o.top
    );
  const candidates: { top: number; left: number }[] = tops.map((top) => ({ top, left: center }));
  for (const top of tops) {
    const hit = blocker(top, center);
    if (hit)
      candidates.push({ top, left: hit.right + GAP }, { top, left: hit.left - size.width - GAP });
  }
  const middle = clamp((rect.top + rect.bottom) / 2 - size.height / 2, maxTop);
  candidates.push(
    { top: middle, left: rect.right + GAP },
    { top: middle, left: rect.left - size.width - GAP }
  );
  const fits = ({ top, left }: { top: number; left: number }) =>
    top >= EDGE && top <= maxTop && left >= EDGE && left <= maxLeft && !blocker(top, left);
  const found = candidates.find(fits);
  if (found) return found;
  return { top: clamp(mobile || above < EDGE ? below : above, maxTop), left: center };
}
