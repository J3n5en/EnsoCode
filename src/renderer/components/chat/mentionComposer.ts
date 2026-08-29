import type { AttachedImage } from '@shared/types/agent';
import type {
  AgentTypeMentionCandidate,
  ChatMentionCandidate,
  FileMentionCandidate,
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

export function unresolvedMentionToken(
  text: string,
  mentions: readonly MentionCandidate[]
): string | null {
  const resolvedPaths = mentions
    .filter((mention): mention is FileMentionCandidate => mention.kind === 'file')
    .map((mention) => mention.relativePath)
    .sort((left, right) => right.length - left.length);
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '@') continue;
    const previous = index > 0 ? text[index - 1] : ' ';
    if (previous !== ' ' && previous !== '\n') continue;
    const resolved = resolvedPaths.find((path) => {
      if (!text.startsWith(path, index + 1)) return false;
      const following = text[index + path.length + 1];
      return following === undefined || /[\s),.;!?]/.test(following);
    });
    if (resolved) {
      index += resolved.length;
      continue;
    }
    return /^[^\s]*/.exec(text.slice(index + 1))?.[0] ?? '';
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

export function createComposerPayload(input: {
  text: string;
  slash: string | null;
  images: AttachedImage[];
  mentions: MentionCandidate[];
  recipient?: AgentTypeMentionCandidate;
}): ComposerPayload {
  const content = input.text.trim();
  const base = input.slash ? (content ? `${input.slash} ${content}` : input.slash) : content;
  // 文件/会话 mention 都走 chip 形态不占文本 token（色块 tag 无法在 textarea 内渲染，
  // 且会话标题含空格会破坏 @ 解析），发送时统一追加：文件给 @path token，
  // 会话只给 jsonl 路径，agent 自己按需 read，不内联不摘要。
  const refs = [
    ...input.mentions
      .filter((mention): mention is FileMentionCandidate => mention.kind === 'file')
      .map((mention) => `@${mention.relativePath}`),
    ...input.mentions
      .filter((mention): mention is ChatMentionCandidate => mention.kind === 'chat')
      .map(
        (mention) =>
          `[Referenced past chat "${mention.label}" — transcript file: ${mention.sessionFile} (pi session jsonl; read it if relevant)]`
      ),
  ];
  return {
    text: refs.length > 0 ? `${base}\n\n${refs.join('\n')}` : base,
    images: input.images,
    mentions: input.mentions,
    ...(input.recipient ? { recipient: input.recipient } : {}),
  };
}
