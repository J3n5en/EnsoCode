import type { AttachedImage } from '@shared/types/agent';
import type {
  AgentTypeMentionCandidate,
  ChatMentionCandidate,
  MentionCandidate,
} from '@shared/types/mentions';

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

/** chat 引用行格式：发送侧（createComposerPayload）与渲染侧（splitMentionRefs）共享，两边必须同步改 */
function chatRefLine(label: string, sessionFile: string): string {
  return `[Referenced past chat "${label}" — transcript file: ${sessionFile} (pi session jsonl; read it if relevant)]`;
}
const CHAT_REF_LINE =
  /^\[Referenced past chat "(.+)" — transcript file: (.+) \(pi session jsonl; read it if relevant\)\]$/;
const FILE_REF_LINE = /^@(\S.*)$/;

export interface SentMentionRefs {
  body: string;
  files: string[];
  chats: { label: string; sessionFile: string }[];
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

export function createComposerPayload(input: {
  text: string;
  slash: string | null;
  images: AttachedImage[];
  mentions: MentionCandidate[];
  recipient?: AgentTypeMentionCandidate;
}): ComposerPayload {
  const content = input.text.trim();
  const base = input.slash ? (content ? `${input.slash} ${content}` : input.slash) : content;
  // 文件 @ 是内联 token（有位置/顺序语义，留在用户输入原位）；会话是附件性质
  // 无位置语义、标题含空格也做不了 token，发送时追加引用块：只给 jsonl 路径，
  // agent 自己按需 read，不内联不摘要。
  const refs = input.mentions
    .filter((mention): mention is ChatMentionCandidate => mention.kind === 'chat')
    .map((mention) => chatRefLine(mention.label, mention.sessionFile));
  return {
    text: refs.length > 0 ? `${base}\n\n${refs.join('\n')}` : base,
    images: input.images,
    mentions: input.mentions,
    ...(input.recipient ? { recipient: input.recipient } : {}),
  };
}
