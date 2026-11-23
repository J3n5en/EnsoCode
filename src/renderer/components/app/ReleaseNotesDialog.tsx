import type { UpdateStatus } from '@shared/types/updater';
import { useRef } from 'react';
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
import { ManualInstallActions } from './ManualInstallActions';
import { restartToUpdate } from './restartToUpdate';

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
  // downloading / error / checking 状态不带 info：沿用最近一次的版本信息，下载期间日志不清空
  const lastInfo = useRef(status?.info);
  if (status?.info) lastInfo.current = status.info;
  const info = lastInfo.current;
  const notes = info?.releaseNotes;
  const progress =
    status?.status === 'downloading'
      ? t('Downloading update… {{percent}}%', {
          percent: Math.round(status.progress?.percent ?? 0),
        })
      : status?.status === 'error'
        ? status.error
          ? t('Update failed: {{error}}', { error: status.error })
          : t('Update check failed')
        : null;
  const action =
    status?.status === 'downloaded' ? (
      <Button
        size="sm"
        onClick={() => {
          // 先关对话框，避免和重启等待蒙版叠在一起
          onOpenChange(false);
          void restartToUpdate(t);
        }}
      >
        {t('Restart to update')}
      </Button>
    ) : status?.status === 'available' && status.manualInstall ? (
      <ManualInstallActions manualInstall={status.manualInstall} />
    ) : status?.status === 'available' && canDownload ? (
      <Button size="sm" onClick={() => void window.electronAPI.updater.downloadUpdate()}>
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
          {progress && (
            <p className="mr-auto self-center text-xs text-muted-foreground">{progress}</p>
          )}
          <DialogClose render={<Button variant="outline" size="sm" />}>{t('Later')}</DialogClose>
          {action}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
