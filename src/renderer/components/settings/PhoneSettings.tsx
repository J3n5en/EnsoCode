import type { PairStatus } from '@shared/types';
import { Check, Copy, Loader2, Pencil, Smartphone, Trash2, TriangleAlert } from 'lucide-react';
import QRCode from 'qrcode';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

/** 手机第二屏：出 QR 配对、管理已配对设备、可改中继地址 */
export function PhoneSettings() {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<PairStatus | null>(null);
  const [qrDataUrl, setQrDataUrl] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [relayDraft, setRelayDraft] = React.useState<string | null>(null);
  const [remaining, setRemaining] = React.useState<number | null>(null);
  const [copied, setCopied] = React.useState(false);

  // 配对码倒计时：秒级刷新，到 0 停（main 侧同一时间戳到期会自动取消配对）
  const expiresAt = status?.pairingExpiresAt;
  React.useEffect(() => {
    if (!expiresAt) {
      setRemaining(null);
      return;
    }
    const update = () => setRemaining(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const copyInvite = (uri: string) => {
    void navigator.clipboard.writeText(uri).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  React.useEffect(() => {
    void window.electronAPI.pair.status().then(setStatus);
    return window.electronAPI.pair.onStatusChanged((next) => {
      setStatus(next);
      // 配对已重新跑起来 / 有设备连上，清掉上一次的失败提示
      if (next.pairing || next.devices.length > 0) setError(null);
    });
  }, []);

  // 配对码变化时重画二维码；配对结束（inviteUri 消失）则清掉
  React.useEffect(() => {
    const uri = status?.inviteUri;
    if (!uri) {
      setQrDataUrl(null);
      return;
    }
    void QRCode.toDataURL(uri, { width: 320, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => {});
  }, [status?.inviteUri]);

  const startPairing = async () => {
    setBusy(true);
    setError(null);
    const result = await window.electronAPI.pair.start();
    setBusy(false);
    if (!result.ok) setError(result.error ?? t('Failed to start pairing'));
  };

  const saveRelay = async () => {
    if (relayDraft === null) return;
    setStatus(await window.electronAPI.pair.setRelayUrl(relayDraft));
    setRelayDraft(null);
  };

  const devices = status?.devices ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h3 className="font-medium text-lg">{t('Phone')}</h3>
          <p className="text-muted-foreground text-sm">
            {t('Use your phone as a second screen. Keep this app running.')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status?.pairing ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void window.electronAPI.pair.cancel()}
            >
              {t('Cancel pairing')}
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void startPairing()}>
              {busy ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Smartphone className="mr-1.5 h-4 w-4" />
              )}
              {t('Pair a phone')}
            </Button>
          )}
        </div>
      </div>

      {status && !status.secureStorage && (
        <div className="flex items-start gap-2 rounded-md border border-dashed px-3 py-2 text-xs">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <span className="text-muted-foreground">
            {t(
              'Secure storage is unavailable on this system, so pairing keys are stored unencrypted.'
            )}
          </span>
        </div>
      )}

      {error && <p className="text-destructive text-xs">{error}</p>}

      {status?.pairing && (
        <div className="space-y-3 rounded-md border border-dashed px-3 py-6">
          <div className="text-center">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt={t('Pairing QR code')} className="mx-auto h-52 w-52" />
            ) : (
              <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
            )}
            <p className="mt-3 font-medium text-sm">{t('Scan with your phone')}</p>
            <p className="mt-1 text-muted-foreground text-xs">
              {remaining === null
                ? t('The code expires in 60 seconds and can only be used once.')
                : remaining > 0
                  ? t('Expires in {{seconds}}s · single use', { seconds: remaining })
                  : t('Code expired')}
            </p>
          </div>

          {status.inviteUri && (
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                {status.inviteUri}
              </code>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => copyInvite(status.inviteUri as string)}
              >
                {copied ? (
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                ) : (
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                )}
                {copied ? t('Copied') : t('Copy')}
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="space-y-2">
        <p className="font-medium text-sm">{t('Paired devices')}</p>
        {devices.length === 0 ? (
          <div className="rounded-md border border-dashed px-3 py-8 text-center">
            <Smartphone className="mx-auto h-5 w-5 text-muted-foreground" />
            <p className="mt-3 font-medium text-sm">{t('No paired devices')}</p>
            <p className="mt-1 text-muted-foreground text-xs">
              {t('Pair a phone to view sessions and reply on the go.')}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {devices.map((device) => (
              <div
                key={device.pairId}
                className="group flex items-center justify-between gap-3 rounded-md px-3 py-2 transition-colors hover:bg-accent/50"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      'h-2 w-2 shrink-0 rounded-full',
                      device.phoneOnline
                        ? 'bg-emerald-500'
                        : device.connected
                          ? 'bg-amber-500'
                          : 'bg-muted-foreground/40'
                    )}
                  />
                  <span className="truncate font-medium text-sm">{device.deviceName}</span>
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {device.phoneOnline
                      ? t('Online')
                      : device.connected
                        ? t('Waiting for phone')
                        : t('Offline')}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  onClick={() => void window.electronAPI.pair.revoke(device.pairId)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <p className="font-medium text-sm">{t('Relay server')}</p>
        <p className="text-muted-foreground text-xs">
          {t('The relay only forwards encrypted frames and cannot read your messages.')}
        </p>
        <div className="flex items-center gap-2">
          <Input
            value={relayDraft ?? status?.relayUrl ?? ''}
            onChange={(e) => setRelayDraft(e.target.value)}
            placeholder="https://relay.example.com"
            className="font-mono text-xs"
          />
          {relayDraft === null ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-muted-foreground"
              onClick={() => setRelayDraft(status?.relayUrl ?? '')}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button size="sm" className="shrink-0" onClick={() => void saveRelay()}>
              <Check className="mr-1.5 h-3.5 w-3.5" />
              {t('Save')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
