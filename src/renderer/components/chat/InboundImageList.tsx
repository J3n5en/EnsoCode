import { toLocalImageUrl } from '@shared/localImage';
import type { InboundImageEntry, InboundImageRejection } from '@shared/secretary/inboundImages';
import { ImageIcon } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { ZoomableImage } from './ZoomableImage';

const REJECTION_KEY: Record<InboundImageRejection, string> = {
  'too-large': 'over 10 MB, not saved',
  'not-image': 'not a png / jpeg / webp / gif image, not saved',
  unavailable: 'could not be saved',
};

function fileName(path: string): string {
  return path.split(/[\\/]/u).pop() ?? path;
}

/**
 * 秘书图片路径行的界面形态：已有缩略图的那张不再重复；
 * 没有缩略图的显示成「图片 N」小标签，点开看原图；收不下的显示成一行提示。
 */
export function InboundImageList({
  entries,
  thumbnails = 0,
  align = 'end',
}: {
  entries: readonly InboundImageEntry[];
  /** 气泡上方已渲染的缩略图张数，与 `[图片 N]` 一一对应 */
  thumbnails?: number;
  align?: 'start' | 'end';
}) {
  const { t } = useI18n();
  const chips = entries.filter(
    (entry): entry is Extract<InboundImageEntry, { path: string }> =>
      'path' in entry && entry.index > thumbnails
  );
  const notes = entries.filter(
    (entry): entry is Extract<InboundImageEntry, { rejected: InboundImageRejection }> =>
      'rejected' in entry
  );
  if (chips.length === 0 && notes.length === 0) return null;
  return (
    <div
      data-enso="inbound-images"
      className={cn('flex flex-col gap-1', align === 'end' ? 'items-end' : 'items-start')}
    >
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((entry) => (
            <ZoomableImage
              key={entry.index}
              src={toLocalImageUrl(entry.path)}
              title={fileName(entry.path)}
              frameClassName="inline-flex h-6 items-center gap-1 rounded-md bg-muted px-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <ImageIcon className="size-3 shrink-0" />
              <span>{t('Image {{n}}', { n: entry.index })}</span>
            </ZoomableImage>
          ))}
        </div>
      )}
      {notes.map((entry) => (
        <p key={entry.index} className="text-xs text-muted-foreground">
          {t('Image {{n}} not accepted: {{reason}}', {
            n: entry.index,
            reason: t(REJECTION_KEY[entry.rejected]),
          })}
        </p>
      ))}
    </div>
  );
}
