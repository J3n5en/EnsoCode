import type { UpdateStatus } from '@shared/types/updater';
import { AnimatePresence, motion } from 'framer-motion';
import { Download, RotateCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n';
import { heightVariants, heightVariantsReduced, usePrefersReducedMotion } from '@/lib/motion';
import { isRemoteClient } from '@/lib/remoteClient';
import { BannerBar } from './BannerBar';
import { ManualInstallActions } from './ManualInstallActions';
import { ReleaseNotesDialog } from './ReleaseNotesDialog';
import { restartToUpdate } from './restartToUpdate';

/** 主窗口顶部更新横幅:发现新版(桌面)可看日志再下载,下载完成后提示重启(可关闭) */
export function UpdateBanner() {
  const { t } = useI18n();
  const reduceMotion = usePrefersReducedMotion();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    let hostChecked = false;
    const syncHostKind = () => {
      if (hostChecked) return;
      hostChecked = true;
      // 服务端 manual 模式不能下载,发现新版只交给设置页
      window.electronAPI.updater
        .getState()
        .then((state) => alive && setDesktop(state.host === 'desktop'))
        .catch(() => {});
    };
    if (!isRemoteClient()) syncHostKind();
    const off = window.electronAPI.updater.onStatus((next) => {
      setStatus(next);
      if (next.status !== 'checking' && next.status !== 'not-available') {
        syncHostKind();
        setDismissed(false);
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (!status) return null;
  // 横幅隐藏（下载失败 / 检查中 / 已关闭）时对话框照常挂着：开着的不会被卸载，关着的也不会在之后自己弹出
  const notes = (
    <ReleaseNotesDialog key="notes" open={notesOpen} onOpenChange={setNotesOpen} status={status} />
  );
  const isAvailable = status.status === 'available' && desktop;
  const visible =
    !dismissed &&
    (status.status === 'downloaded' || status.status === 'downloading' || isAvailable);
  const version = status.info?.version;
  const isDownloaded = status.status === 'downloaded';
  const manualInstall = isAvailable ? status.manualInstall : undefined;

  return (
    <>
      <AnimatePresence initial={false}>
        {visible && (
          <motion.div
            key="banner"
            variants={reduceMotion ? heightVariantsReduced : heightVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="overflow-hidden"
          >
            <BannerBar>
              {isDownloaded ? (
                <RotateCw className="h-3.5 w-3.5 shrink-0 text-blue-500" />
              ) : (
                <Download className="h-3.5 w-3.5 shrink-0 animate-pulse text-blue-500" />
              )}
              <span className="min-w-0 flex-1">
                {isDownloaded
                  ? t(
                      'New version {{version}} is downloaded. Restarting waits for the current tool to finish; background commands keep running.',
                      {
                        version: version ?? '',
                      }
                    )
                  : manualInstall
                    ? t(
                        "New version {{version}} found. This local build can't install it automatically.",
                        {
                          version: version ?? '',
                        }
                      )
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
              {manualInstall && <ManualInstallActions manualInstall={manualInstall} size="xs" />}
              {isAvailable && !manualInstall && (
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
                  onClick={() => void restartToUpdate(t)}
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
            </BannerBar>
          </motion.div>
        )}
      </AnimatePresence>
      {notes}
    </>
  );
}
