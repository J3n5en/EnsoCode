import { formatUiElementRefLine, parseUiElementRefLine } from '@shared/browser/designMode';
import type { AttachedImage } from '@shared/types/agent';
import type { AgentTypeMentionCandidate, MentionCandidate } from '@shared/types/mentions';

export interface ComposerPayload {
  text: string;
  images: AttachedImage[];
  mentions: MentionCandidate[];
  recipient?: AgentTypeMentionCandidate;
}

export function extractMentionQuery(text: string, cursor: number): string | null {
  for (let index = cursor - 1; index >= 0; index--) {
    const character = text[index];
    if (character === '@') {
      const previous = index > 0 ? text[index - 1] : ' ';
      return previous === ' ' || previous === '\n' ? text.slice(index + 1, cursor) : null;
    }
    if (character === ' ' || character === '\n') return null;
  }
  return null;
}

export interface MentionPopupLayoutInput {
  /** @ token / 光标相对定位父级的 left */
  anchorLeft: number;
  containerWidth: number;
  popupWidth: number;
  flyoutWidth: number;
  flyoutGap: number;
}

export interface MentionPopupLayout {
  left: number;
  flyoutSide: 'left' | 'right';
}

/** 弹窗跟锚点，夹进容器；右侧放不下 flyout 时翻到左边 */
export function mentionPopupLayout(input: MentionPopupLayoutInput): MentionPopupLayout {
  const maxLeft = Math.max(0, input.containerWidth - input.popupWidth);
  const left = Math.min(Math.max(0, input.anchorLeft), maxLeft);
  const spaceRight = input.containerWidth - left - input.popupWidth - input.flyoutGap;
  return { left, flyoutSide: spaceRight >= input.flyoutWidth ? 'right' : 'left' };
}

export type PopupKeyAction =
  | { type: 'none' }
  | { type: 'move'; index: number }
  | { type: 'move-folder'; index: number }
  | { type: 'open-folder' }
  | { type: 'close-folder' }
  | { type: 'pick' }
  | { type: 'close' };

export function resolvePopupKeyAction(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  activeIndex: number;
  itemCount: number;
  folderOpen?: boolean;
  activeIsFolder?: boolean;
  folderIndex?: number;
  folderItemCount?: number;
}): PopupKeyAction {
  if (input.isComposing || input.itemCount === 0) return { type: 'none' };
  const pickKey = (input.key === 'Enter' && !input.shiftKey) || input.key === 'Tab';
  if (input.folderOpen) {
    // 退出判断必须在空列表判断之前：候选异步变空时 Escape 仍要能退出 folder，
    // 否则根级 close 永远走不到（folderOpen 还是 true），弹窗死锁。
    if (input.key === 'Escape' || input.key === 'ArrowLeft') return { type: 'close-folder' };
    const count = input.folderItemCount ?? 0;
    if (count === 0) return { type: 'none' };
    const index = input.folderIndex ?? 0;
    if (input.key === 'ArrowDown') return { type: 'move-folder', index: (index + 1) % count };
    if (input.key === 'ArrowUp') {
      return { type: 'move-folder', index: (index - 1 + count) % count };
    }
    if (pickKey) return { type: 'pick' };
    return { type: 'none' };
  }
  if (input.activeIsFolder && (input.key === 'ArrowRight' || pickKey)) {
    return { type: 'open-folder' };
  }
  if (input.key === 'ArrowDown') {
    return { type: 'move', index: (input.activeIndex + 1) % input.itemCount };
  }
  if (input.key === 'ArrowUp') {
    return {
      type: 'move',
      index: (input.activeIndex - 1 + input.itemCount) % input.itemCount,
    };
  }
  if (pickKey) return { type: 'pick' };
  if (input.key === 'Escape') return { type: 'close' };
  return { type: 'none' };
}

/** chat 引用行格式：发送侧（createEditorPayload/serializeSegments）与渲染侧（splitInlineMentions/splitMentionRefs）共享，两边必须同步改 */
function chatRefLine(label: string, sessionFile: string): string {
  // 标题可能含 "/[/]/换行（旧版污染残留或用户自定义），嵌入前必须净化，
  // 否则惰性 "(.+?)" 会在内层引号提前结束，破坏解析与标题折叠
  const safe =
    label
      .replace(/["[\]\n]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'untitled';
  return `[Referenced past chat "${safe}" — transcript file: ${sessionFile} (pi session jsonl; read it if relevant)]`;
}
const CHAT_REF_LINE =
  /^\[Referenced past chat "(.+)" — transcript file: (.+) \(pi session jsonl; read it if relevant\)\]$/;
const FILE_REF_LINE = /^@(\S.*)$/;

export interface SentMentionRefs {
  body: string;
  files: string[];
  chats: { label: string; sessionFile: string }[];
}

export type InlineSegment = { type: 'text'; text: string } | { type: 'file'; path: string };

/** 编辑器段模型：文本 / 文件卡片 / 会话卡片 / Design Mode 选区 */
export type MentionSegment =
  | { type: 'text'; text: string }
  | { type: 'file'; path: string }
  | { type: 'chat'; label: string; sessionFile: string }
  | { type: 'ui-element'; id: string; label: string; path: string; text: string; imageId: string };

/** 编辑器段 → wire text：文件原位 @path，会话/选区原位内联引用块 */
export function serializeSegments(segments: readonly MentionSegment[]): string {
  return segments
    .map((segment) => {
      if (segment.type === 'text') return segment.text;
      if (segment.type === 'file') return `@${segment.path}`;
      if (segment.type === 'chat') return chatRefLine(segment.label, segment.sessionFile);
      return formatUiElementRefLine(segment);
    })
    .join('');
}

const INLINE_CHAT_REF =
  /\[Referenced past chat "(.+?)" — transcript file: (.+?) \(pi session jsonl; read it if relevant\)\]/g;
const INLINE_UI_REF = /\[Selected UI element "([^"]*)" — path: (.*?); text: (.*?)\]/g;

/** 把引用块折叠成 @标题，供标题/纯文本展示用（引用块原文不得污染标题） */
export function mentionDisplayText(text: string): string {
  return text
    .replace(INLINE_CHAT_REF, (_match, label: string) => `@${label}`)
    .replace(INLINE_UI_REF, (_match, label: string) => `@${label}`);
}

/**
 * wire text → 段：全文扫描内联 chat 引用块与 @文件 token，供气泡原位渲染卡片。
 * 与 serializeSegments 互为逆；旧格式尾部追加的引用块同样能解到（历史消息兼容）。
 */
type InlineRefHit = { index: number; length: number; segment: MentionSegment };

function nextInlineRef(text: string, from: number): InlineRefHit | null {
  INLINE_CHAT_REF.lastIndex = from;
  INLINE_UI_REF.lastIndex = from;
  const chat = INLINE_CHAT_REF.exec(text);
  const ui = INLINE_UI_REF.exec(text);
  const chatHit: InlineRefHit | null = chat
    ? {
        index: chat.index,
        length: chat[0].length,
        segment: { type: 'chat', label: chat[1], sessionFile: chat[2] },
      }
    : null;
  const parsedUi = ui ? parseUiElementRefLine(ui[0]) : null;
  const uiHit: InlineRefHit | null =
    ui && parsedUi
      ? {
          index: ui.index,
          length: ui[0].length,
          segment: { type: 'ui-element', id: '', ...parsedUi, imageId: '' },
        }
      : null;
  if (chatHit && uiHit) return chatHit.index <= uiHit.index ? chatHit : uiHit;
  return chatHit ?? uiHit;
}

export function splitInlineMentions(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let cursor = 0;
  let hit = nextInlineRef(text, 0);
  while (hit) {
    const before = text.slice(cursor, hit.index);
    for (const segment of splitInlineFileTokens(before)) {
      if (segment.type === 'text' && segment.text === '') continue;
      segments.push(segment);
    }
    segments.push(hit.segment);
    cursor = hit.index + hit.length;
    hit = nextInlineRef(text, cursor);
  }
  const tail = text.slice(cursor);
  if (tail || segments.length === 0) {
    for (const segment of splitInlineFileTokens(tail)) {
      if (segment.type === 'text' && segment.text === '' && segments.length > 0) continue;
      segments.push(segment);
    }
  }
  return segments;
}

/** 内联文件 token：带扩展名才算（@src/main.ts、@.DS_Store、@.gitignore），
 * 避免误伤 @types/node 这类 npm scope（无点） */
const INLINE_FILE_TOKEN = /^[\w./-]*\.[\w-]{1,16}(?:#L\d+(?:-L\d+)?)?$/;
const FILE_LINE_REF = /#L\d+(?:-L\d+)?$/;

export function stripFileLineRef(path: string): string {
  return path.replace(FILE_LINE_REF, '');
}

/**
 * 把文本拆成普通段与内联 @文件 段，供发出的气泡原位渲染成 tag（Cursor 式）。
 * 启发式识别（气泡只有文本没有结构化元数据）：@ 前是空白/行首，
 * token 剥掉句尾标点后末段带扩展名。邮箱（@ 前非空白）、npm scope 不误伤。
 */
export function splitInlineFileTokens(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let plain = '';
  let index = 0;
  while (index < text.length) {
    const at = text.indexOf('@', index);
    if (at === -1) {
      plain += text.slice(index);
      break;
    }
    const previous = at > 0 ? text[at - 1] : ' ';
    const raw = /^\S*/.exec(text.slice(at + 1))?.[0] ?? '';
    const token = raw.replace(/[),.;!?]+$/, '');
    if ((previous === ' ' || previous === '\n') && token && INLINE_FILE_TOKEN.test(token)) {
      plain += text.slice(index, at);
      if (plain) {
        segments.push({ type: 'text', text: plain });
        plain = '';
      }
      segments.push({ type: 'file', path: token });
      index = at + 1 + token.length;
    } else {
      plain += text.slice(index, at + 1);
      index = at + 1;
    }
  }
  if (plain) segments.push({ type: 'text', text: plain });
  return segments.length > 0 ? segments : [{ type: 'text', text }];
}

/**
 * 从发出的消息里剥出尾部引用块，供气泡把它们渲染回 chip。
 * 只当尾部连续行全部是引用行、且前面有空行分隔时才剥，
 * 避免误伤用户正文里碰巧以 @ 或方括号开头的段落。
 */
export function splitMentionRefs(text: string): SentMentionRefs {
  const none = { body: text, files: [], chats: [] };
  const lines = text.split('\n');
  const files: string[] = [];
  const chats: { label: string; sessionFile: string }[] = [];
  let index = lines.length - 1;
  for (; index >= 0; index--) {
    const line = lines[index];
    const chat = CHAT_REF_LINE.exec(line);
    if (chat) {
      chats.unshift({ label: chat[1], sessionFile: chat[2] });
      continue;
    }
    if (FILE_REF_LINE.test(line)) {
      files.unshift(line.slice(1));
      continue;
    }
    break;
  }
  if (files.length + chats.length === 0) return none;
  // 引用块必须紧跟一个空行分隔符（发送侧用 \n\n 拼接），否则视为正文
  if (index < 0 || lines[index].trim() !== '') return none;
  return { body: lines.slice(0, index).join('\n').trimEnd(), files, chats };
}

/** 编辑器段 → 发送 payload：wire text 内联序列化，mentions 从段派生 */
export function createEditorPayload(input: {
  segments: readonly MentionSegment[];
  slash: string | null;
  images: AttachedImage[];
  recipient?: AgentTypeMentionCandidate;
}): ComposerPayload {
  const content = serializeSegments(input.segments).trim();
  const mentions: MentionCandidate[] = input.segments
    .filter((segment) => segment.type !== 'text')
    .map((segment) => {
      if (segment.type === 'file') {
        return {
          kind: 'file' as const,
          id: segment.path,
          label: segment.path.split('/').at(-1) || segment.path,
          relativePath: stripFileLineRef(segment.path),
        };
      }
      if (segment.type === 'chat') {
        return {
          kind: 'chat' as const,
          id: segment.sessionFile,
          label: segment.label,
          sessionFile: segment.sessionFile,
        };
      }
      return {
        kind: 'ui-element' as const,
        id: segment.id,
        label: segment.label,
        path: segment.path,
        text: segment.text,
        imageId: segment.imageId,
      };
    });
  if (input.recipient) mentions.push(input.recipient);
  return {
    text: input.slash ? (content ? `${input.slash} ${content}` : input.slash) : content,
    images: input.images.map(({ data, mimeType }) => ({ data, mimeType })),
    mentions,
    ...(input.recipient ? { recipient: input.recipient } : {}),
  };
}
