import { useEffect, useState } from 'react';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { addToast } from '@/components/ui/toast';
import { useOverlayGuard } from '@/hooks/useOverlayGuard';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';

interface ZoomableImageProps {
  src: string;
  className?: string;
  /** 点击区域；需要把图片限制在父级宽度内时传 `block w-full` */
  frameClassName?: string;
  onError?: () => void;
}

/** CSP connect-src 不放行 data:，data URL 本地解码；local-image: 走 fetch（协议已开 CORS） */
async function imageBlob(src: string): Promise<Blob> {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(src);
  if (!match) return (await fetch(src)).blob();
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: match[1] });
}

/** Chromium 剪贴板只稳定支持 image/png，其它格式先转码 */
async function copyImageToClipboard(src: string): Promise<void> {
  const blob = await imageBlob(src);
  let png = blob;
  if (blob.type !== 'image/png') {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    bitmap.close();
    png = await canvas.convertToBlob({ type: 'image/png' });
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

/** 消息里的图片：点击全屏预览，点遮罩或 Esc 关闭；右键复制图片 */
export function ZoomableImage({ src, className, frameClassName, onError }: ZoomableImageProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  useOverlayGuard(open);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const copy = () => {
    copyImageToClipboard(src).then(
      () => addToast({ type: 'success', title: t('Image copied') }),
      (error: unknown) =>
        addToast({
          type: 'error',
          title: t('Could not copy image'),
          description: error instanceof Error ? error.message : String(error),
        })
    );
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <button
              type="button"
              onClick={() => setOpen(true)}
              className={cn('cursor-zoom-in', frameClassName)}
            >
              <img src={src} alt="" className={className} onError={onError} />
            </button>
          }
          onContextMenu={(event) => event.stopPropagation()}
        />
        <ContextMenuPopup className="min-w-36">
          <ContextMenuItem closeOnClick onClick={copy}>
            {t('Copy image')}
          </ContextMenuItem>
        </ContextMenuPopup>
      </ContextMenu>
      {open && (
        <button
          type="button"
          onClick={() => setOpen(false)}
          className={cn(
            'fixed inset-0 flex cursor-zoom-out items-center justify-center bg-black/75'
          )}
          style={{ zIndex: Z_INDEX.NESTED_MODAL_BACKDROP }}
          data-enso-float=""
        >
          <img src={src} alt="" className="max-h-[92vh] max-w-[92vw] rounded-lg object-contain" />
        </button>
      )}
    </>
  );
}
