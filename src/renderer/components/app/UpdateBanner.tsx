import type { UpdateStatus } from '@shared/types/updater';
import { Download, RotateCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n';
import { ReleaseNotesDialog } from './ReleaseNotesDialog';

/** 主窗口顶部更新横幅:发现新版(桌面)可看日志再下载,下载完成后提示重启(可关闭) */
export function UpdateBanner() {
  const { t } = useI18n();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    // 服务端 manual 模式不能下载,发现新版只交给设置页
    window.electronAPI.updater
      .getState()
      .then((state) => alive && setDesktop(state.host === 'desktop'))
      .catch(() => {});
    const off = window.electronAPI.updater.onStatus((next) => {
      setStatus(next);
      if (next.status !== 'checking' && next.status !== 'not-available') setDismissed(false);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (dismissed || !status) return null;
  const isAvailable = status.status === 'available' && desktop;
  if (status.status !== 'downloaded' && status.status !== 'downloading' && !isAvailable) {
    return null;
  }

  const version = status.info?.version;
  const isDownloaded = status.status === 'downloaded';

  return (
    <div className="border-b border-blue-500/20 bg-background">
      <div className="flex items-center gap-2 bg-blue-500/8 px-4 py-1.5 text-xs">
        {isDownloaded ? (
          <RotateCw className="h-3.5 w-3.5 shrink-0 text-blue-500" />
        ) : (
          <Download className="h-3.5 w-3.5 shrink-0 animate-pulse text-blue-500" />
        )}
        <span className="min-w-0 flex-1">
          {isDownloaded
            ? t('New version {{version}} is ready — restart to update.', {
                version: version ?? '',
              })
            : isAvailable
              ? t('New version {{version}} found', { version: version ?? '' })
              : t('Downloading update… {{percent}}%', {
                  percent: Math.round(status.progress?.percent ?? 0),
                })}
        </span>
        {(isDownloaded || isAvailable) && (
          <button
            type="button"
            onClick={() => setNotesOpen(true)}
            className="shrink-0 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            {t('Release notes')}
          </button>
        )}
        {isAvailable && (
          <button
            type="button"
            onClick={() => void window.electronAPI.updater.downloadUpdate()}
            className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t('Download update')}
          </button>
        )}
        {isDownloaded && (
          <button
            type="button"
            onClick={() => void window.electronAPI.updater.quitAndInstall()}
            className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t('Restart to update')}
          </button>
        )}
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          title={t('Close')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <ReleaseNotesDialog open={notesOpen} onOpenChange={setNotesOpen} status={status} />
    </div>
  );
}
