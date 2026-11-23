import type { AttachedImage } from '@shared/types/agent';
import { type MentionSegment, splitQuoteBlocks } from './mentionComposer';
import { splitSlashChain } from './slashChain';

interface Draft {
  segments: MentionSegment[];
  images: AttachedImage[];
  slashes: string[];
}

export function applyInjectedDraft(
  current: Draft,
  injected: { text?: string; images?: AttachedImage[] },
  append = false
): Draft {
  const hasText = current.segments.some(
    (segment) => segment.type !== 'text' || segment.text.length > 0
  );
  if (append && (hasText || current.slashes.length > 0)) {
    return {
      slashes: current.slashes,
      segments: [
        ...current.segments,
        ...(injected.text ? splitQuoteBlocks(`${hasText ? '\n\n' : ''}${injected.text}`) : []),
      ],
      images: [...current.images, ...(injected.images ?? [])],
    };
  }
  const parsed = splitSlashChain(injected.text ?? '');
  return {
    slashes: parsed.slashes,
    segments: parsed.rest ? splitQuoteBlocks(parsed.rest) : [],
    images: [...(append ? current.images : []), ...(injected.images ?? [])],
  };
}
