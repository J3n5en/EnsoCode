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
import { useI18n } from '@/i18n';

/**
 * 只通过 img 展示经 workspaceFiles.readImage 授权读取的图片（含 SVG），不内联 SVG，也不接收磁盘或远程 URL。
 *
 * Display images (including SVG) authorized by workspaceFiles.readImage only via img, never inline SVG, disk or remote URLs.
 */
export function WorkspaceImagePreview({
  image,
  onClose,
}: {
  image: { rel: string; dataUrl: string } | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      open={image !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('Image preview')}</DialogTitle>
          <DialogDescription className="break-all">{image?.rel}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[70vh]">
          {image && (
            <img
              src={image.dataUrl}
              alt={image.rel}
              className="mx-auto max-h-[65vh] max-w-full object-contain"
            />
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
