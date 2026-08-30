import type { ChatMentionCandidate, FileMentionCandidate } from '@shared/types/mentions';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { cn } from '@/lib/utils';
import { extractMentionQuery, type MentionSegment } from './mentionComposer';

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
  /** 光标处的 @query(null = 无活动 token) */
  mentionQuery: string | null;
  /** 光标处的 /query(仅编辑器首节点文本;null = 无) */
  slashQuery: string | null;
}

export interface MentionEditorHandle {
  focus(): void;
  isEmpty(): boolean;
  getSegments(): MentionSegment[];
  setSegments(segments: readonly MentionSegment[]): void;
  clear(): void;
  /** 用卡片替换光标处的 @token(无 token 则插在光标处),尾随一个空格 */
  insertMention(candidate: FileMentionCandidate | ChatMentionCandidate): void;
  /** 仅移除光标处的 @token 或 /token(agent recipient、slash 选中用) */
  consumeToken(prefix: '@' | '/'): void;
  /** 在光标处插入文件卡片(拖拽文件用,无 token 语义) */
  insertFileChip(path: string): void;
}

interface MentionEditorProps {
  placeholder: string;
  disabled?: boolean;
  className?: string;
  onStateChange: (state: MentionEditorState) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onPaste: (event: React.ClipboardEvent) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  ariaProps?: React.AriaAttributes & { role?: string };
}

/** lucide FileText / History 的静态 path(卡片是命令式 DOM,不走 React 渲染) */
const ICON_SVG: Record<'file' | 'chat', string> = {
  file: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
  chat: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>',
};

const CHIP_CLASS: Record<'file' | 'chat', string> = {
  file: 'bg-success/15 text-success',
  chat: 'bg-warning/25 text-warning-foreground dark:bg-warning/15 dark:text-warning',
};

function buildChip(segment: Exclude<MentionSegment, { type: 'text' }>): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.contentEditable = 'false';
  chip.dataset.mentionKind = segment.type;
  if (segment.type === 'file') {
    chip.dataset.path = segment.path;
    chip.title = segment.path;
  } else {
    chip.dataset.label = segment.label;
    chip.dataset.sessionFile = segment.sessionFile;
  }
  chip.className = cn(
    // align-middle + leading-4：与正文（含 CJK）光学居中，与气泡侧 InlineMentionCard 同参数
    'mx-0.5 inline-flex max-w-52 items-center gap-1 rounded-md px-1.5 py-0.5 align-middle text-xs font-medium leading-4 select-none',
    CHIP_CLASS[segment.type]
  );
  const icon = document.createElement('span');
  icon.className = 'shrink-0 inline-flex';
  icon.innerHTML = ICON_SVG[segment.type];
  chip.appendChild(icon);
  const label = document.createElement('span');
  label.className = 'truncate';
  label.textContent =
    segment.type === 'file' ? segment.path.split('/').at(-1) || segment.path : segment.label;
  chip.appendChild(label);
  return chip;
}

function segmentFromChip(chip: HTMLElement): MentionSegment | null {
  if (chip.dataset.mentionKind === 'file' && chip.dataset.path) {
    return { type: 'file', path: chip.dataset.path };
  }
  if (chip.dataset.mentionKind === 'chat' && chip.dataset.label && chip.dataset.sessionFile) {
    return { type: 'chat', label: chip.dataset.label, sessionFile: chip.dataset.sessionFile };
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
 * setSelectedTextRange；光标已在最左端时再按一次，WebKit 会把折叠选区从文本
 * 节点挪到元素节点锚点（如 (root, 0)），这种选区不绘制光标——表现为「光标消失」。
 * 把元素锚点的折叠选区规范回相邻文本节点的等价位置即可恢复。
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
      onCompositionStart,
      onCompositionEnd,
      ariaProps,
    },
    ref
  ) {
    const rootRef = useRef<HTMLDivElement>(null);

    // 修复 iOS IME 光标键在最左端把选区推成元素锚点导致光标消失（见 normalizedCaretRange）
    useEffect(() => {
      const handler = () => {
        const root = rootRef.current;
        if (!root || document.activeElement !== root) return;
        const selection = window.getSelection();
        if (!selection) return;
        const range = normalizedCaretRange(root, selection);
        if (!range) return;
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
      const caret = caretContext(root);
      if (caret) {
        const before = caret.node.textContent?.slice(0, caret.offset) ?? '';
        mentionQuery = extractMentionQuery(before, before.length);
        // slash 仅当光标在首个文本节点、且 token 从 0 开始
        if (mentionQuery === null && caret.node === root.firstChild && /^\/[^\s]*$/.test(before)) {
          slashQuery = before.slice(1);
        }
      }
      onStateChange({ plainText, hasMentions, mentionQuery, slashQuery });
    }, [onStateChange]);

    /** 光标处活动 token 的范围(@ 或 /) */
    const activeTokenRange = useCallback(
      (prefix: '@' | '/'): { node: Text; start: number; end: number } | null => {
        const root = rootRef.current;
        if (!root) return null;
        const caret = caretContext(root);
        if (!caret) return null;
        const before = caret.node.textContent?.slice(0, caret.offset) ?? '';
        if (prefix === '@') {
          const query = extractMentionQuery(before, before.length);
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
              root.appendChild(buildChip(segment));
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
          insertNodeAtCaret(
            () =>
              buildChip(
                candidate.kind === 'file'
                  ? { type: 'file', path: candidate.relativePath }
                  : { type: 'chat', label: candidate.label, sessionFile: candidate.sessionFile }
              ),
            true
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
        insertFileChip: (path) => {
          insertNodeAtCaret(() => buildChip({ type: 'file', path }), false);
        },
      }),
      [activeTokenRange, emitState, insertNodeAtCaret]
    );

    return (
      <div
        ref={rootRef}
        contentEditable={!disabled}
        // biome-ignore lint/a11y/useSemanticElements: contentEditable 富文本输入没有语义等价元素
        role={ariaProps?.role ?? 'textbox'}
        aria-placeholder={placeholder}
        data-placeholder={placeholder}
        {...ariaProps}
        onInput={emitState}
        onKeyDown={(event) => {
          // Shift+Enter 不拦截：浏览器原生 insertLineBreak 会处理末尾双 <br> 占位等
          // 边界（手工插 \n/<br> 后尾部光标会被折回，后续输入位置错乱）；
          // 序列化端 walkSegments 已把 <br>/块元素降级为 '\n'
          onKeyDown(event);
        }}
        onKeyUp={emitState}
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
          const selection = window.getSelection();
          if (!selection || selection.rangeCount === 0) return;
          const range = selection.getRangeAt(0);
          range.deleteContents();
          const node = document.createTextNode(text);
          range.insertNode(node);
          placeCaretAfter(node);
          emitState();
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
