import { formatLinkSubtitle } from '@shared/pair/linkLabel';
import type { RemoteLinkStatus, RemotePushError } from '@shared/remoteBridge';
import { subscribePush } from '@shared/webPush';
import { Info, Laptop } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';

const ICON_BUTTON_CLASS =
  'flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-40';

function useRemoteLink(): RemoteLinkStatus | null {
  const remote = window.electronAPI.remote;
  const [status, setStatus] = useState<RemoteLinkStatus | null>(null);
  useEffect(() => {
    if (!remote?.linkStatus || !remote.onLinkStatus) return;
    setStatus(remote.linkStatus());
    return remote.onLinkStatus(setStatus);
  }, [remote]);
  return status;
}

function pushHint(status: RemoteLinkStatus, t: (key: string) => string): string {
  if (status.pushError) return t(PUSH_ERROR_KEY[status.pushError]);
  if (status.pushAvailability === 'needs-install')
    return t('Add this app to the Home Screen before notifications can be turned on.');
  if (status.pushAvailability === 'unsupported')
    return t('This browser cannot show notifications.');
  if (!status.pushReady) return t('Notifications need a newer desktop app.');
  if (status.pushBusy) return t('Turning on notifications…');
  return status.pushEnabled ? t('Turn off notifications') : t('Turn on notifications');
}

const PUSH_ERROR_KEY: Record<RemotePushError, string> = {
  unsupported: 'This browser cannot show notifications.',
  'permission-denied':
    'Notification permission was denied. Allow notifications for this site and try again.',
  'service-unreachable': 'Cannot reach the push service. Check the network or proxy and try again.',
  'subscribe-failed': 'Could not turn on notifications.',
};

/** 完整版侧栏：一个信息按钮，点开看延迟和推送。替换用不了的「连接到节点」 */
export function PhoneLinkStatus() {
  const { t } = useI18n();
  const status = useRemoteLink();
  if (!status) return null;
  const subtitle = formatLinkSubtitle(status, t);
  const hint = pushHint(status, t);
  const disabled =
    status.pushBusy ||
    status.pushAvailability !== 'ok' ||
    !status.pushReady ||
    (status.state !== 'online' && !status.pushEnabled);
  return (
    <Popover>
      <PopoverTrigger className={ICON_BUTTON_CLASS} title={subtitle} aria-label={subtitle}>
        <Info className="h-4 w-4" />
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="end"
        className="w-64 [&_[data-slot=popover-viewport]]:px-3 [&_[data-slot=popover-viewport]]:py-3"
      >
        <div className="flex items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground shadow-xs ring-1 ring-border">
            <Laptop className="size-3.5" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-medium text-sm leading-4">{status.deviceLabel}</span>
            <span className="truncate text-subtle-foreground text-xs leading-4">{subtitle}</span>
          </span>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 border-t pt-3">
          <span className="text-sm">{t('Push notifications')}</span>
          <Switch
            checked={status.pushEnabled}
            disabled={disabled}
            title={hint}
            aria-label={hint}
            onCheckedChange={() => void togglePush(status)}
          />
        </div>
        {status.pushError && (
          <p className="mt-2 text-destructive text-xs">{t(PUSH_ERROR_KEY[status.pushError])}</p>
        )}
      </PopoverPopup>
    </Popover>
  );
}

async function togglePush(status: RemoteLinkStatus): Promise<void> {
  const remote = window.electronAPI.remote;
  if (!remote?.setPushSubscription || !remote.setPushPending) return;
  if (status.pushEnabled) {
    remote.setPushSubscription(null);
    return;
  }
  const key = remote.vapidPublicKey?.();
  if (!key) return;
  // requestPermission 必须发生在这个点击所在的文档里，手势过不了父页面
  remote.setPushPending({ busy: true, enabled: true, error: null });
  const result = await subscribePush(key);
  if (!result.ok) {
    remote.setPushPending({ busy: false, enabled: false, error: result.reason });
    return;
  }
  remote.setPushSubscription(result.subscription);
}
