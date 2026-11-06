import {
  isZoomBannerVisible,
  readDismissedZoomPercent,
  ZOOM_BANNER_DISMISSED_KEY,
} from '@shared/zoomBanner';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n';
import { formatBinding } from '@/lib/keybindings';

function currentZoomPercent(): number {
  return window.electronAPI.window.getZoomPercent();
}

export function ZoomBanner() {
  const { t } = useI18n();
  const [percent, setPercent] = useState(currentZoomPercent);
  const [dismissedPercent, setDismissedPercent] = useState<number | null>(() =>
    readDismissedZoomPercent(localStorage.getItem(ZOOM_BANNER_DISMISSED_KEY))
  );

  useEffect(() => {
    const onResize = () => setPercent(currentZoomPercent());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (!isZoomBannerVisible(percent, dismissedPercent)) return null;

  return (
    <div className="border-b border-blue-500/20 bg-background">
      <div className="flex items-center gap-2 bg-blue-500/8 px-4 py-1.5 text-xs">
        <span className="min-w-0 flex-1">
          {t('Interface is zoomed to {{percent}}% · {{shortcut}}', {
            percent,
            shortcut: formatBinding('mod+0'),
          })}
        </span>
        <button
          type="button"
          onClick={() => {
            window.electronAPI.window.resetZoom();
            localStorage.removeItem(ZOOM_BANNER_DISMISSED_KEY);
            setDismissedPercent(null);
            setPercent(currentZoomPercent());
          }}
          className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {t('Restore 100%')}
        </button>
        <button
          type="button"
          onClick={() => {
            localStorage.setItem(ZOOM_BANNER_DISMISSED_KEY, String(percent));
            setDismissedPercent(percent);
          }}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          title={t('Close')}
          aria-label={t('Close')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
