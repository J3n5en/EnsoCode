import type { ManualInstall } from '@shared/types/updater';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';

/** 本地构建装不上正式包：给 DMG 下载与 Release 页面入口（target=_blank 由主进程交给系统浏览器） */
export function ManualInstallActions({
  manualInstall,
  size = 'sm',
}: {
  manualInstall: ManualInstall;
  size?: 'sm' | 'xs';
}) {
  const { t } = useI18n();
  return (
    <>
      <Button
        variant="outline"
        size={size}
        className="shrink-0"
        render={<a href={manualInstall.releaseUrl} target="_blank" rel="noreferrer" />}
      >
        {t('Open release page')}
      </Button>
      {manualInstall.downloadUrl && (
        <Button
          size={size}
          className="shrink-0"
          render={<a href={manualInstall.downloadUrl} target="_blank" rel="noreferrer" />}
        >
          {t('Download DMG')}
        </Button>
      )}
    </>
  );
}
