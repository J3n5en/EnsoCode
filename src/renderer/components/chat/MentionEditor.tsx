import type {
  ChatMentionCandidate,
  FileMentionCandidate,
  UiElementMentionCandidate,
} from '@shared/types/mentions';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { extractTriggerQuery } from '../../plugins/triggers';
import {
  extractMentionQuery,
  fileMentionBasename,
  type MentionSegment,
  type QuoteSegment,
} from './mentionComposer';
import { quoteLineCount, quotePreview } from './quoteSelection';
import { extractSkillQuery } from './skillCompletion';

/**
 * contentEditable 提及编辑器:文件/会话以原子卡片(contenteditable=false)内联,
 * 浏览器原生把 cE=false 岛当单个单位——Backspace 整块删除、光标不可进入。
 * DOM 是编辑期唯一事实源,发送/存草稿时序列化为段列表。
 */

export interface MentionEditorState {
  /** 纯文本投影(卡片折叠为占位),驱动 hasContent/slash 检测 */
  plainText: string;
  /** 是否含提及卡片 */
  hasMentions: boolean;
  segments: MentionSegment[];
  /** 光标处的 @query(null = 无活动 token) */
  mentionQuery: string | null;
  /** 光标处的 /query(仅编辑器首节点文本;null = 无) */
  slashQuery: string | null;
  /** 光标处的 $query(null = 无活动技能 token) */
  skillQuery: string | null;
  /** 光标处的 #query，给插件补全(null = 无) */
  pluginQuery: string | null;
}

export interface MentionEditorHandle {
  focus(): void;
  isEmpty(): boolean;
  getSegments(): MentionSegment[];
  setSegments(segments: readonly MentionSegment[]): void;
  clear(): void;
  /** 用卡片替换光标处的 @token(无 token 则插在光标处),尾随一个空格 */
  insertMention(
    candidate: FileMentionCandidate | ChatMentionCandidate | UiElementMentionCandidate
  ): void;
  /** 仅移除光标处的 @token、/token、$token 或 #token */
  consumeToken(prefix: '@' | '/' | '$' | '#'): void;
  /** 在光标处插入文件卡片(拖拽文件用,无 token 语义) */
  insertFileChip(path: string, label?: string): void;
  /** 在光标处插入纯文本 */
  insertText(text: string): void;
  /** 在末尾追加选中文本引用块（默认折叠），光标落到其后 */
  insertQuote(quote: QuoteSegment): void;
  /** 活动 @ token 首字符的视口矩形，给 mention 弹窗锚点用 */
  getMentionAnchorRect(): DOMRect | null;
}

interface MentionEditorProps {
  placeholder: string;
  disabled?: boolean;
  className?: string;
  onStateChange: (state: MentionEditorState) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onPaste: (event: React.ClipboardEvent) => void;
  /** 纯文本粘贴拦截:返回 true 表示已接管,不再插入正文 */
  onPasteText?: (text: string) => boolean;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onChipActivate?: (segment: MentionSegment) => void;
  ariaProps?: React.AriaAttributes & { role?: string };
}

/** lucide FileText / History 的静态 path(卡片是命令式 DOM,不走 React 渲染) */
const ICON_SVG: Record<'file' | 'chat' | 'ui-element', string> = {
  file: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
  chat: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>',
  'ui-element':
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3a2 2 0 0 0-2 2"/><path d="M19 3a2 2 0 0 1 2 2"/><path d="M21 19a2 2 0 0 1-2 2"/><path d="M5 21a2 2 0 0 1-2-2"/><path d="M9 3h1"/><path d="M9 21h1"/><path d="M14 3h1"/><path d="M14 21h1"/><path d="M3 9v1"/><path d="M21 9v1"/><path d="M3 14v1"/><path d="M21 14v1"/></svg>',
};

const FOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';

const CHIP_CLASS: Record<'file' | 'chat' | 'ui-element', string> = {
  file: 'bg-success/15 text-success',
  chat: 'bg-warning/25 text-warning-foreground dark:bg-warning/15 dark:text-warning',
  'ui-element': 'bg-purple-500/15 text-purple-600 dark:text-purple-400',
};

const QUOTE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/></svg>';

interface QuoteLabels {
  title: (lines: number) => string;
  truncated: (lines: number) => string;
  expand: string;
  remove: string;
}

/** 引用块卡片的正文：折叠只显示前几行，展开显示全文并在限高内滚动；发送一律取 data-text 全文 */
function renderQuoteBody(chip: HTMLElement, labels: QuoteLabels): void {
  const text = chip.dataset.text ?? '';
  const expanded = chip.dataset.expanded === 'true';
  const { preview, clipped } = quotePreview(text);
  const body = chip.querySelector<HTMLElement>('[data-quote-body]');
  if (body) {
    body.textContent = expanded ? text : clipped ? `${preview}\n…` : preview;
    body.className = cn(
      'mt-0.5 block whitespace-pre-wrap break-words text-foreground/80',
      expanded ? 'max-h-32 overflow-y-auto overscroll-contain' : 'max-h-16 overflow-hidden'
    );
  }
  chip.querySelector('[data-quote-toggle]')?.remove();
  if (!expanded && clipped) {
    const toggle = document.createElement('span');
    toggle.dataset.quoteToggle = '';
    toggle.className = 'shrink-0 text-muted-foreground/80';
    toggle.textContent = labels.expand;
    chip.querySelector('[data-quote-remove]')?.before(toggle);
  }
}

function buildQuoteChip(segment: QuoteSegment, labels: QuoteLabels): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.contentEditable = 'false';
  chip.dataset.mentionKind = 'quote';
  chip.dataset.text = segment.text;
  if (segment.originalLines) chip.dataset.originalLines = String(segment.originalLines);
  chip.className =
    'my-1 block cursor-pointer rounded-md border-l-2 border-brand/50 bg-muted/60 px-2 py-1 text-xs select-none';
  const head = document.createElement('span');
  head.className = 'flex items-center gap-1.5 text-muted-foreground';
  const icon = document.createElement('span');
  icon.className = 'shrink-0 inline-flex';
  icon.innerHTML = QUOTE_SVG;
  const title = document.createElement('span');
  title.className = 'min-w-0 flex-1 truncate';
  title.textContent = labels.title(quoteLineCount(segment.text));
  head.append(icon, title);
  if (segment.originalLines) {
    const badge = document.createElement('span');
    badge.dataset.quoteTruncated = '';
    badge.className =
      'shrink-0 rounded bg-warning/20 px-1 text-warning-foreground dark:text-warning';
    badge.textContent = labels.truncated(segment.originalLines);
    head.appendChild(badge);
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.dataset.quoteRemove = '';
  remove.setAttribute('aria-label', labels.remove);
  remove.className = 'shrink-0 rounded-sm px-1 opacity-70 hover:opacity-100';
  remove.textContent = '×';
  head.appendChild(remove);
  const body = document.createElement('span');
  body.dataset.quoteBody = '';
  chip.append(head, body);
  renderQuoteBody(chip, labels);
  return chip;
}

function buildChip(
  segment: Exclude<MentionSegment, { type: 'text' }>,
  labels: QuoteLabels
): HTMLSpanElement {
  if (segment.type === 'quote') return buildQuoteChip(segment, labels);
  const chip = document.createElement('span');
  chip.contentEditable = 'false';
  chip.dataset.mentionKind = segment.type;
  if (segment.type === 'file') {
    chip.dataset.path = segment.path;
    if (segment.label) chip.dataset.label = segment.label;
    chip.title = segment.path;
  } else if (segment.type === 'chat') {
    chip.dataset.label = segment.label;
    chip.dataset.sessionFile = segment.sessionFile;
    if (segment.conversationId) chip.dataset.conversationId = segment.conversationId;
  } else {
    chip.dataset.id = segment.id;
    chip.dataset.label = segment.label;
    chip.dataset.path = segment.path;
    chip.dataset.text = segment.text;
    chip.dataset.imageId = segment.imageId;
    chip.title = `${segment.path}${segment.text ? ` · ${segment.text}` : ''}`;
  }
  chip.className = cn(
    // align-middle + leading-4：与正文（含 CJK）光学居中，与气泡侧 InlineMentionCard 同参数
    'mx-0.5 inline-flex max-w-52 items-center gap-1 rounded-md px-1.5 py-0.5 align-middle text-xs font-medium leading-4 select-none',
    CHIP_CLASS[segment.type]
  );
  const icon = document.createElement('span');
  icon.className = 'shrink-0 inline-flex';
  icon.innerHTML =
    segment.type === 'file' && /[\\/]$/.test(segment.path) ? FOLDER_SVG : ICON_SVG[segment.type];
  chip.appendChild(icon);
  const label = document.createElement('span');
  label.className = 'truncate';
  label.textContent =
    segment.type === 'file' ? (segment.label ?? fileMentionBasename(segment.path)) : segment.label;
  chip.appendChild(label);
  return chip;
}

function segmentFromChip(chip: HTMLElement): MentionSegment | null {
  if (chip.dataset.mentionKind === 'quote' && chip.dataset.text) {
    const originalLines = Number(chip.dataset.originalLines);
    return {
      type: 'quote',
      text: chip.dataset.text,
      ...(originalLines > 0 ? { originalLines } : {}),
    };
  }
  if (chip.dataset.mentionKind === 'file' && chip.dataset.path) {
    return {
      type: 'file',
      path: chip.dataset.path,
      ...(chip.dataset.label ? { label: chip.dataset.label } : {}),
    };
  }
  if (chip.dataset.mentionKind === 'chat' && chip.dataset.label && chip.dataset.sessionFile) {
    return {
      type: 'chat',
      label: chip.dataset.label,
      sessionFile: chip.dataset.sessionFile,
      ...(chip.dataset.conversationId ? { conversationId: chip.dataset.conversationId } : {}),
    };
  }
  if (
    chip.dataset.mentionKind === 'ui-element' &&
    chip.dataset.label &&
    chip.dataset.path &&
    chip.dataset.text
  ) {
    return {
      type: 'ui-element',
      id: chip.dataset.id ?? '',
      label: chip.dataset.label,
      path: chip.dataset.path,
      text: chip.dataset.text,
      imageId: chip.dataset.imageId ?? '',
    };
  }
  return null;
}

function walkSegments(root: HTMLElement): MentionSegment[] {
  const segments: MentionSegment[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const last = segments.at(-1);
    if (last?.type === 'text') last.text += text;
    else segments.push({ type: 'text', text });
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(node.textContent ?? '');
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.mentionKind) {
      const segment = segmentFromChip(node);
      if (segment) segments.push(segment);
      return;
    }
    if (node.tagName === 'BR') {
      pushText('\n');
      return;
    }
    // 意外包裹层(粘贴残留等):按块级换行降级
    const isBlock = node.tagName === 'DIV' || node.tagName === 'P';
    if (isBlock && segments.length > 0) pushText('\n');
    for (const child of node.childNodes) visit(child);
  };
  for (const child of root.childNodes) visit(child);
  return segments;
}

/** 光标所在 text node 与其前缀文本(卡片是节点边界,token 不会跨卡片) */
function caretContext(root: HTMLElement): { node: Text; offset: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
  const { anchorNode, anchorOffset } = selection;
  if (!anchorNode || !root.contains(anchorNode)) return null;
  if (anchorNode.nodeType !== Node.TEXT_NODE) return null;
  return { node: anchorNode as Text, offset: anchorOffset };
}

/**
 * iOS 第三方键盘（搜狗等）的光标移动键不发 KeyEvent，走 UITextInput 的
 * setSelectedTextRange，到达边界后再按会越界，有两种形态：
 * a) 折叠选区从文本节点挪到元素节点锚点（如 (root, 0)），WebKit 不绘制光标；
 * b) 选区直接被推出编辑器到周围 DOM（光标「滑出输入框」）。
 * 形态 a 由本函数规范回相邻文本节点的等价位置；形态 b 在 selectionchange
 * 监听里拉回最近一次编辑器内的位置。
 */
function normalizedCaretRange(root: HTMLElement, selection: Selection): Range | null {
  if (selection.rangeCount === 0 || !selection.isCollapsed) return null;
  const { anchorNode, anchorOffset } = selection;
  if (!anchorNode || anchorNode.nodeType === Node.TEXT_NODE) return null;
  if (anchorNode !== root && !root.contains(anchorNode)) return null;
  const children = anchorNode.childNodes;
  const after = children[anchorOffset];
  const before = anchorOffset > 0 ? children[anchorOffset - 1] : undefined;
  const target =
    after?.nodeType === Node.TEXT_NODE
      ? { node: after as Text, offset: 0 }
      : before?.nodeType === Node.TEXT_NODE
        ? { node: before as Text, offset: (before as Text).length }
        : null;
  if (!target) return null;
  const range = document.createRange();
  range.setStart(target.node, target.offset);
  range.collapse(true);
  return range;
}

function isMentionChip(node: Node | null | undefined): node is HTMLElement {
  return node instanceof HTMLElement && Boolean(node.dataset.mentionKind);
}

function isIgnorableText(node: Node | null | undefined): node is Text {
  return node instanceof Text && !/[^\s\u00a0]/.test(node.textContent ?? '');
}

function chipBesideCaret(root: HTMLElement, side: 'before' | 'after'): HTMLElement | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
  const { anchorNode, anchorOffset } = selection;
  if (!anchorNode || !root.contains(anchorNode)) return null;

  if (anchorNode.nodeType === Node.TEXT_NODE) {
    const text = anchorNode.textContent ?? '';
    if (side === 'before') {
      if (/[^\s\u00a0]/.test(text.slice(0, anchorOffset))) return null;
      let current: Node | null = anchorNode.previousSibling;
      while (isIgnorableText(current)) current = current.previousSibling;
      return isMentionChip(current) ? current : null;
    }
    if (/[^\s\u00a0]/.test(text.slice(anchorOffset))) return null;
    let current: Node | null = anchorNode.nextSibling;
    while (isIgnorableText(current)) current = current.nextSibling;
    return isMentionChip(current) ? current : null;
  }

  const children = anchorNode.childNodes;
  if (side === 'before') {
    let index = anchorOffset - 1;
    while (index >= 0 && isIgnorableText(children[index])) index -= 1;
    const node = index >= 0 ? children[index] : null;
    return isMentionChip(node) ? node : null;
  }
  let index = anchorOffset;
  while (index < children.length && isIgnorableText(children[index])) index += 1;
  const node = children[index];
  return isMentionChip(node) ? node : null;
}

function removeMentionChip(chip: HTMLElement, root: HTMLElement): void {
  const next = chip.nextSibling;
  if (isIgnorableText(next)) next.remove();
  const prev = chip.previousSibling;
  chip.remove();
  if (prev) {
    placeCaretAfter(prev);
    return;
  }
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStart(root, 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function placeCaretAfter(node: Node): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

export const MentionEditor = forwardRef<MentionEditorHandle, MentionEditorProps>(
  function MentionEditor(
    {
      placeholder,
      disabled,
      className,
      onStateChange,
      onKeyDown,
      onPaste,
      onPasteText,
      onCompositionStart,
      onCompositionEnd,
      onChipActivate,
      ariaProps,
    },
    ref
  ) {
    const { t } = useI18n();
    const rootRef = useRef<HTMLDivElement>(null);
    const labels: QuoteLabels = {
      title: (count) => t('Quote · {{count}} lines', { count }),
      truncated: (count) => t('Truncated · original {{count}} lines', { count }),
      expand: t('Click to expand'),
      remove: t('Remove quote'),
    };
    const labelsRef = useRef(labels);
    labelsRef.current = labels;
    /** 最近一次落在编辑器内文本节点上的光标，选区被 IME 推出去时用它拉回 */
    const lastCaretRef = useRef<{ node: Text; offset: number } | null>(null);

    // 展开的引用块：点它以外的任何地方就缩回
    useEffect(() => {
      const handler = (event: Event) => {
        const target = event.target as Node | null;
        for (const chip of rootRef.current?.querySelectorAll<HTMLElement>(
          '[data-mention-kind="quote"][data-expanded]'
        ) ?? []) {
          if (target && chip.contains(target)) continue;
          delete chip.dataset.expanded;
          renderQuoteBody(chip, labelsRef.current);
        }
      };
      document.addEventListener('pointerdown', handler);
      return () => document.removeEventListener('pointerdown', handler);
    }, []);

    // 修复 iOS IME 光标键的两种越界形态（见 normalizedCaretRange 注释）。
    // 用户点击编辑器外会先转移焦点，activeElement 守卫保证不干扰正常交互。
    useEffect(() => {
      const handler = () => {
        const root = rootRef.current;
        if (!root || document.activeElement !== root) return;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return;
        const anchor = selection.anchorNode;
        if (anchor && (anchor === root || root.contains(anchor))) {
          const normalized = normalizedCaretRange(root, selection);
          if (normalized) {
            selection.removeAllRanges();
            selection.addRange(normalized);
          } else if (anchor.nodeType === Node.TEXT_NODE) {
            lastCaretRef.current = { node: anchor as Text, offset: selection.anchorOffset };
          }
          return;
        }
        // 焦点还在编辑器而选区已在外面：IME 把光标推出去了，拉回最近位置
        const last = lastCaretRef.current;
        const range = document.createRange();
        if (last?.node.isConnected && root.contains(last.node)) {
          range.setStart(last.node, Math.min(last.offset, last.node.length));
          range.collapse(true);
        } else {
          range.selectNodeContents(root);
          range.collapse(true);
        }
        selection.removeAllRanges();
        selection.addRange(range);
      };
      document.addEventListener('selectionchange', handler);
      return () => document.removeEventListener('selectionchange', handler);
    }, []);

    const emitState = useCallback(() => {
      const root = rootRef.current;
      if (!root) return;
      const segments = walkSegments(root);
      const plainText = segments
        .map((segment) => (segment.type === 'text' ? segment.text : '\uFFFC'))
        .join('');
      const hasMentions = segments.some((segment) => segment.type !== 'text');
      let mentionQuery: string | null = null;
      let slashQuery: string | null = null;
      let skillQuery: string | null = null;
      let pluginQuery: string | null = null;
      const caret = caretContext(root);
      if (caret) {
        const before = caret.node.textContent?.slice(0, caret.offset) ?? '';
        mentionQuery = extractMentionQuery(before, before.length);
        if (mentionQuery === null) skillQuery = extractSkillQuery(before, before.length);
        if (mentionQuery === null && skillQuery === null) pluginQuery = extractTriggerQuery(before);
        // slash 仅当光标在首个文本节点、且 token 从 0 开始
        if (mentionQuery === null && caret.node === root.firstChild && /^\/[^\s]*$/.test(before)) {
          slashQuery = before.slice(1);
        }
      }
      onStateChange({
        plainText,
        hasMentions,
        segments,
        mentionQuery,
        slashQuery,
        skillQuery,
        pluginQuery,
      });
    }, [onStateChange]);

    /** 光标处活动 token 的范围(@、/、$ 或 #) */
    const activeTokenRange = useCallback(
      (prefix: '@' | '/' | '$' | '#'): { node: Text; start: number; end: number } | null => {
        const root = rootRef.current;
        if (!root) return null;
        const caret = caretContext(root);
        if (!caret) return null;
        const before = caret.node.textContent?.slice(0, caret.offset) ?? '';
        if (prefix === '#') {
          const query = extractTriggerQuery(before);
          if (query === null) return null;
          return { node: caret.node, start: before.length - query.length - 1, end: caret.offset };
        }
        if (prefix === '@' || prefix === '$') {
          const query =
            prefix === '@'
              ? extractMentionQuery(before, before.length)
              : extractSkillQuery(before, before.length);
          if (query === null) return null;
          return { node: caret.node, start: before.length - query.length - 1, end: caret.offset };
        }
        if (caret.node !== root.firstChild || !/^\/[^\s]*$/.test(before)) return null;
        return { node: caret.node, start: 0, end: caret.offset };
      },
      []
    );

    const insertNodeAtCaret = useCallback(
      (build: () => Node, replaceToken: boolean) => {
        const root = rootRef.current;
        if (!root) return;
        root.focus();
        const range = document.createRange();
        const token = replaceToken ? activeTokenRange('@') : null;
        if (token) {
          range.setStart(token.node, token.start);
          range.setEnd(token.node, token.end);
          range.deleteContents();
        } else {
          const caret = caretContext(root);
          if (caret) {
            range.setStart(caret.node, caret.offset);
            range.collapse(true);
          } else {
            range.selectNodeContents(root);
            range.collapse(false);
          }
        }
        const node = build();
        range.insertNode(node);
        const space = document.createTextNode('\u00a0');
        node.parentNode?.insertBefore(space, node.nextSibling);
        placeCaretAfter(space);
        emitState();
      },
      [activeTokenRange, emitState]
    );

    useImperativeHandle(
      ref,
      () => ({
        focus: () => rootRef.current?.focus(),
        isEmpty: () => {
          const root = rootRef.current;
          if (!root) return true;
          const segments = walkSegments(root);
          return !segments.some(
            (segment) => segment.type !== 'text' || segment.text.trim().length > 0
          );
        },
        getSegments: () => (rootRef.current ? walkSegments(rootRef.current) : []),
        setSegments: (segments) => {
          const root = rootRef.current;
          if (!root) return;
          root.textContent = '';
          for (const segment of segments) {
            if (segment.type === 'text') {
              root.appendChild(document.createTextNode(segment.text));
            } else {
              root.appendChild(buildChip(segment, labelsRef.current));
            }
          }
          emitState();
        },
        clear: () => {
          const root = rootRef.current;
          if (!root) return;
          root.textContent = '';
          emitState();
        },
        insertMention: (candidate) => {
          const segment =
            candidate.kind === 'file'
              ? { type: 'file' as const, path: candidate.relativePath }
              : candidate.kind === 'chat'
                ? {
                    type: 'chat' as const,
                    label: candidate.label,
                    sessionFile: candidate.sessionFile,
                    conversationId: candidate.id,
                  }
                : {
                    type: 'ui-element' as const,
                    id: candidate.id,
                    label: candidate.label,
                    path: candidate.path,
                    text: candidate.text,
                    imageId: candidate.imageId,
                  };
          insertNodeAtCaret(
            () => buildChip(segment, labelsRef.current),
            candidate.kind !== 'ui-element'
          );
        },
        consumeToken: (prefix) => {
          const token = activeTokenRange(prefix);
          if (!token) return;
          const range = document.createRange();
          range.setStart(token.node, token.start);
          range.setEnd(token.node, token.end);
          range.deleteContents();
          emitState();
        },
        insertFileChip: (path, label) => {
          insertNodeAtCaret(
            () => buildChip({ type: 'file', path, ...(label ? { label } : {}) }, labelsRef.current),
            false
          );
        },
        insertText: (text) => {
          insertNodeAtCaret(() => document.createTextNode(text), false);
        },
        insertQuote: (quote) => {
          const root = rootRef.current;
          if (!root) return;
          // 焦点已在时间线上，原光标不可靠：统一追加到末尾，接着就能写追问
          const space = document.createTextNode('\u00a0');
          root.append(buildChip(quote, labelsRef.current), space);
          root.focus();
          window.getSelection()?.collapse(space, space.length);
          root.scrollTop = root.scrollHeight;
          emitState();
        },
        getMentionAnchorRect: () => {
          const token = activeTokenRange('@');
          if (!token) return null;
          const range = document.createRange();
          range.setStart(token.node, token.start);
          range.setEnd(token.node, Math.min(token.start + 1, token.node.length));
          return range.getBoundingClientRect();
        },
      }),
      [activeTokenRange, emitState, insertNodeAtCaret]
    );

    return (
      // biome-ignore lint/a11y/useAriaPropsSupportedByRole: contentEditable 输入必须是 textbox，aria-placeholder 无原生等价
      <div
        ref={rootRef}
        contentEditable={!disabled}
        role={ariaProps?.role ?? 'textbox'}
        aria-placeholder={placeholder}
        data-placeholder={placeholder}
        {...ariaProps}
        onInput={emitState}
        onKeyDown={(event) => {
          if (
            !event.nativeEvent.isComposing &&
            (event.key === 'Backspace' || event.key === 'Delete')
          ) {
            const root = rootRef.current;
            const chip =
              root && chipBesideCaret(root, event.key === 'Backspace' ? 'before' : 'after');
            if (chip && root) {
              event.preventDefault();
              removeMentionChip(chip, root);
              emitState();
              return;
            }
          }
          // Shift+Enter 不拦截：浏览器原生 insertLineBreak 会处理末尾双 <br> 占位等
          // 边界（手工插 \n/<br> 后尾部光标会被折回，后续输入位置错乱）；
          // 序列化端 walkSegments 已把 <br>/块元素降级为 '\n'
          onKeyDown(event);
        }}
        onClick={(event) => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          const chip = target.closest('[data-mention-kind]');
          if (!(chip instanceof HTMLElement) || !rootRef.current?.contains(chip)) return;
          if (chip.dataset.mentionKind === 'quote') {
            if (target.closest('[data-quote-remove]')) {
              removeMentionChip(chip, rootRef.current);
              emitState();
            } else if (chip.dataset.expanded !== 'true') {
              chip.dataset.expanded = 'true';
              renderQuoteBody(chip, labelsRef.current);
            }
            return;
          }
          if (!onChipActivate) return;
          const segment = segmentFromChip(chip);
          if (segment) onChipActivate(segment);
        }}
        onKeyUp={(event) => {
          if (event.key !== 'Escape') emitState();
        }}
        onMouseUp={emitState}
        onPaste={(event) => {
          if (event.clipboardData.files.length > 0) {
            onPaste(event);
            return;
          }
          // 强制纯文本粘贴,防止外来 HTML 污染段模型
          event.preventDefault();
          const text = event.clipboardData.getData('text/plain');
          if (!text) return;
          if (onPasteText?.(text)) return;
          document.execCommand('insertText', false, text);
        }}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={() => {
          onCompositionEnd();
          emitState();
        }}
        className={cn(
          // min-h-10 对齐旧 textarea rows={2}（text-sm 行高 20px × 2）
          'max-h-40 min-h-10 min-w-0 flex-1 overflow-y-auto pt-0.5 text-sm break-words whitespace-pre-wrap outline-none',
          'empty:before:pointer-events-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]',
          disabled && 'opacity-60',
          className
        )}
      />
    );
  }
);
