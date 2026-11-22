import type { FilesReadImageResult } from '@shared/types/filesWorkspace';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

const IMAGE_REL = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;

export function isImageRel(rel: string): boolean {
  return IMAGE_REL.test(rel);
}

/** data URL 超过该长度先不渲染：几 MB 的 base64 直接塞进 img 会卡住渲染进程 */
export const IMAGE_INLINE_MAX_CHARS = 4 * 1024 * 1024;

const CHECKERBOARD = {
  backgroundImage: 'repeating-conic-gradient(rgb(128 128 128 / 0.18) 0% 25%, transparent 0% 50%)',
  backgroundSize: '16px 16px',
};

type ImageState =
  | { status: 'loading' }
  | { status: 'error'; tooLarge: boolean }
  | { status: 'ready'; dataUrl: string };

export function FileImageViewer({
  rel,
  version,
  resolveImage,
  onOpenSource,
}: {
  rel: string;
  version: number;
  resolveImage: (rel: string) => Promise<FilesReadImageResult>;
  onOpenSource: () => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<ImageState>({ status: 'loading' });
  const [fit, setFit] = useState(true);
  // 与取图结果分开存：重新取图（含写入途中短暂读失败）后已点开的大图不退回「点击加载」
  const [forced, setForced] = useState(false);

  useEffect(() => {
    void version;
    let alive = true;
    // 重新取图期间保留旧图，不闪回加载态
    resolveImage(rel).then(
      (result) => {
        if (!alive) return;
        setState((prev) =>
          !result.ok
            ? { status: 'error', tooLarge: result.error === 'too-large' }
            : prev.status === 'ready' && prev.dataUrl === result.dataUrl
              ? prev
              : { status: 'ready', dataUrl: result.dataUrl }
        );
      },
      () => {
        if (alive) setState({ status: 'error', tooLarge: false });
      }
    );
    return () => {
      alive = false;
    };
  }, [rel, version, resolveImage]);

  if (state.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('Loading...')}
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
        <span>
          {state.tooLarge
            ? t('The image is too large to preview.')
            : t('Unable to preview this image.')}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={onOpenSource}>
          {t('Open in code editor')}
        </Button>
      </div>
    );
  }
  if (state.dataUrl.length > IMAGE_INLINE_MAX_CHARS && !forced) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <Button type="button" variant="outline" size="sm" onClick={() => setForced(true)}>
          {t('Image is too large. Click to load.')}
        </Button>
      </div>
    );
  }
  return (
    <div className="relative h-full">
      <div className="absolute top-2 right-2 z-10">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={fit ? t('Actual size') : t('Fit to window')}
          onClick={() => setFit((value) => !value)}
        >
          {fit ? <Maximize2 className="h-3.5 w-3.5" /> : <Minimize2 className="h-3.5 w-3.5" />}
          {fit ? t('Actual size') : t('Fit to window')}
        </Button>
      </div>
      <div className="h-full overflow-auto p-4" style={CHECKERBOARD}>
        <button
          type="button"
          className={cn(
            fit
              ? 'flex h-full w-full cursor-zoom-in items-center justify-center'
              : 'm-auto block w-max cursor-zoom-out'
          )}
          onClick={() => setFit((value) => !value)}
        >
          <img
            src={state.dataUrl}
            alt={rel}
            data-fit={fit ? 'contain' : 'actual'}
            className={fit ? 'max-h-full max-w-full object-contain' : 'max-w-none'}
          />
        </button>
      </div>
    </div>
  );
}
