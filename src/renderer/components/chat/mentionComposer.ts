import type { AttachedImage } from '@shared/types/agent';
import type {
  AgentTypeMentionCandidate,
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
  | { type: 'pick' }
  | { type: 'close' };

export function resolvePopupKeyAction(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  activeIndex: number;
  itemCount: number;
}): PopupKeyAction {
  if (input.isComposing || input.itemCount === 0) return { type: 'none' };
  if (input.key === 'ArrowDown') {
    return { type: 'move', index: (input.activeIndex + 1) % input.itemCount };
  }
  if (input.key === 'ArrowUp') {
    return {
      type: 'move',
      index: (input.activeIndex - 1 + input.itemCount) % input.itemCount,
    };
  }
  if ((input.key === 'Enter' && !input.shiftKey) || input.key === 'Tab') return { type: 'pick' };
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
  return {
    text: input.slash ? (content ? `${input.slash} ${content}` : input.slash) : content,
    images: input.images,
    mentions: input.mentions,
    ...(input.recipient ? { recipient: input.recipient } : {}),
  };
}
