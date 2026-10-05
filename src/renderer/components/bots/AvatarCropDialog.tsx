import { ImagePlus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { Slider } from '@/components/ui/slider';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { readDataUrl, renderSquare } from './avatarImage';

const VIEW = 256;
const MAX_ZOOM = 4;

/** 上传（选图 → 裁切）与移除按钮；onPick 拿到 512×512 PNG data URL */
export function AvatarButtons({
  hasImage,
  nested = false,
  disabled = false,
  onPick,
  onRemove,
}: {
  hasImage: boolean;
  nested?: boolean;
  disabled?: boolean;
  onPick: (dataUrl: string) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap gap-1.5">
      <Button
        size="xs"
        variant="outline"
        disabled={disabled}
        onClick={() => fileRef.current?.click()}
      >
        <ImagePlus />
        {t('Upload avatar')}
      </Button>
      {hasImage && (
        <Button size="xs" variant="ghost" disabled={disabled} onClick={onRemove}>
          <X />
          {t('Remove avatar')}
        </Button>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          readDataUrl(file).then(setSource, () =>
            addToast({ type: 'error', title: t('This image cannot be used as an avatar.') })
          );
        }}
      />
      <AvatarCropDialog
        source={source}
        nested={nested}
        onCancel={() => setSource(null)}
        onDone={(dataUrl) => {
          setSource(null);
          onPick(dataUrl);
        }}
      />
    </div>
  );
}

interface View {
  zoom: number;
  x: number;
  y: number;
}

/** 圆形裁切：拖动平移、滚轮 / 滑块缩放，输出 512×512 PNG data URL */
export function AvatarCropDialog({
  source,
  nested = false,
  onCancel,
  onDone,
}: {
  source: string | null;
  nested?: boolean;
  onCancel: () => void;
  onDone: (dataUrl: string) => void;
}) {
  const { t } = useI18n();
  const imageRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });

  // biome-ignore lint/correctness/useExhaustiveDependencies: 换图时重置
  useEffect(() => {
    setSize(null);
    setView({ zoom: 1, x: 0, y: 0 });
  }, [source]);

  const scale = (zoom: number) => (size ? (VIEW / Math.min(size.w, size.h)) * zoom : 1);
  const clamp = (next: View): View => {
    if (!size) return next;
    const s = scale(next.zoom);
    const maxX = (size.w * s - VIEW) / 2;
    const maxY = (size.h * s - VIEW) / 2;
    return {
      zoom: next.zoom,
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y)),
    };
  };
  const zoomTo = (zoom: number) =>
    setView((current) => clamp({ ...current, zoom: Math.max(1, Math.min(MAX_ZOOM, zoom)) }));

  const confirm = () => {
    const image = imageRef.current;
    if (!image || !size) return;
    const s = scale(view.zoom);
    const side = VIEW / s;
    onDone(
      renderSquare(
        image,
        size.w / 2 - side / 2 - view.x / s,
        size.h / 2 - side / 2 - view.y / s,
        side
      )
    );
  };

  const s = scale(view.zoom);
  return (
    <Dialog open={source !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-sm" zIndexLevel={nested ? 'nested' : 'base'}>
        <DialogHeader>
          <DialogTitle>{t('Crop avatar')}</DialogTitle>
          <DialogDescription>{t('Drag to move, scroll to zoom.')}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col items-center gap-4">
          <div
            data-avatar-crop
            className="relative cursor-grab touch-none select-none overflow-hidden rounded-lg bg-muted active:cursor-grabbing"
            style={{ width: VIEW, height: VIEW }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
            }}
            onPointerMove={(event) => {
              const last = drag.current;
              if (!last || last.id !== event.pointerId) return;
              drag.current = { ...last, x: event.clientX, y: event.clientY };
              setView((current) =>
                clamp({
                  ...current,
                  x: current.x + event.clientX - last.x,
                  y: current.y + event.clientY - last.y,
                })
              );
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onWheel={(event) => zoomTo(view.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1))}
          >
            {source && (
              <img
                ref={imageRef}
                src={source}
                alt=""
                draggable={false}
                onLoad={(event) =>
                  setSize({
                    w: event.currentTarget.naturalWidth,
                    h: event.currentTarget.naturalHeight,
                  })
                }
                onError={() => {
                  addToast({ type: 'error', title: t('This image cannot be used as an avatar.') });
                  onCancel();
                }}
                className="pointer-events-none absolute top-1/2 left-1/2 max-w-none"
                style={
                  size
                    ? {
                        width: size.w * s,
                        height: size.h * s,
                        transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px)`,
                      }
                    : { visibility: 'hidden' }
                }
              />
            )}
            <span className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_9999px_rgb(0_0_0/0.55)] ring-2 ring-white/80" />
          </div>
          <Slider
            min={1}
            max={MAX_ZOOM}
            step={0.01}
            value={view.zoom}
            aria-label={t('Zoom')}
            onValueChange={(value) => zoomTo(Array.isArray(value) ? value[0] : value)}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t('Cancel')}
          </Button>
          <Button size="sm" disabled={!size} onClick={confirm}>
            {t('Use this avatar')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
