import type { AttachedImage } from '@shared/types/agent';
import type { MentionSegment } from './mentionComposer';
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
        ...(injected.text
          ? [{ type: 'text' as const, text: `${hasText ? '\n\n' : ''}${injected.text}` }]
          : []),
      ],
      images: [...current.images, ...(injected.images ?? [])],
    };
  }
  const parsed = splitSlashChain(injected.text ?? '');
  return {
    slashes: parsed.slashes,
    segments: parsed.rest ? [{ type: 'text', text: parsed.rest }] : [],
    images: [...(append ? current.images : []), ...(injected.images ?? [])],
  };
}
