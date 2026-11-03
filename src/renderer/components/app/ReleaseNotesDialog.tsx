import type { UpdateStatus } from '@shared/types/updater';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { markdownComponents } from '@/components/chat/Markdown';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/i18n';

const REMARK_PLUGINS = [remarkGfm];
// GitHub release 的 releaseNotes 是 HTML，先 raw 解析再按默认白名单清洗
const REHYPE_PLUGINS = [rehypeRaw, rehypeSanitize];

/** 升级前查看更新日志：available 可下载，downloaded 可重启安装，其余只读 */
export function ReleaseNotesDialog({
  open,
  onOpenChange,
  status,
  canDownload = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: UpdateStatus | null;
  canDownload?: boolean;
}) {
  const { t } = useI18n();
  const info = status?.info;
  const notes = info?.releaseNotes;
  const action =
    status?.status === 'downloaded' ? (
      <Button size="sm" onClick={() => void window.electronAPI.updater.quitAndInstall()}>
        {t('Restart to update')}
      </Button>
    ) : status?.status === 'available' && canDownload ? (
      <Button
        size="sm"
        onClick={() => {
          onOpenChange(false);
          void window.electronAPI.updater.downloadUpdate();
        }}
      >
        {t('Download update')}
      </Button>
    ) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t("What's new in {{version}}", { version: info?.version ?? '' })}
          </DialogTitle>
          {info?.releaseName && info.releaseName !== info.version && (
            <DialogDescription>{info.releaseName}</DialogDescription>
          )}
        </DialogHeader>
        <DialogPanel>
          {notes ? (
            <div className="text-sm">
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                rehypePlugins={REHYPE_PLUGINS}
                components={markdownComponents}
              >
                {notes}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('No release notes provided.')}</p>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>{t('Later')}</DialogClose>
          {action}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
