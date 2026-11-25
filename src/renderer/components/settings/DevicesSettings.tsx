import { formatRttMs } from '@shared/pair/rtt';
import type { PairStatus } from '@shared/types';
import type { RemoteNodeStatus } from '@shared/types/nodes';
import {
  Check,
  Copy,
  Loader2,
  Monitor,
  Pencil,
  Plus,
  Smartphone,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import QRCode from 'qrcode';
import * as React from 'react';
import { NodeDot } from '@/components/nodes/NodeSwitcher';
import { PairNodeDialog } from '@/components/nodes/PairNodeDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { isRemoteClient } from '@/lib/remoteClient';
import { cn } from '@/lib/utils';
import { useRemoteNodesStore } from '@/stores/remoteNodes';
import { SettingsButton, SettingsPage, SettingsRow, SettingsSection } from './kit';

const ICON_BUTTON = 'text-muted-foreground';

/**
 * 设备：两个方向。
 * 「允许连入」= 本机作 host：出 QR/链接给手机或别的桌面扫/粘，管理已配对设备、中继地址。
 * 「连接到节点」= 本机作 guest：粘别的桌面的配对链接，管理已连节点（在线/重命名/解绑）。
 */
export function DevicesSettings() {
  const { t } = useI18n();
  return (
    <SettingsPage rowId="phone.devices" title={t('Devices')}>
      <AllowConnectionsSection />
      {!window.electronAPI.remote && <ConnectToNodesSection />}
      <RelaySection />
    </SettingsPage>
  );
}

/** 本机作为 host：出码 + 已配对设备列表 */
function AllowConnectionsSection() {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<PairStatus | null>(null);
  const [qrDataUrl, setQrDataUrl] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
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
    // pair:status 只在宿主侧有意义，远程拿不到配对状态
    if (isRemoteClient()) return;
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

  const devices = status?.devices ?? [];

  return (
    <SettingsSection
      rowId="phone.root"
      title={t('Allow connections')}
      description={t(
        'Let your phone or another EnsoCode desktop connect to this computer. Keep this app running.'
      )}
      actions={
        status?.pairing ? (
          <SettingsButton onClick={() => void window.electronAPI.pair.cancel()}>
            {t('Cancel pairing')}
          </SettingsButton>
        ) : (
          <SettingsButton disabled={busy} onClick={() => void startPairing()}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Smartphone className="h-4 w-4" />
            )}
            {t('Generate pairing code')}
          </SettingsButton>
        )
      }
    >
      {status && !status.secureStorage && <SecureStorageNote />}
      {error && <p className="px-4 py-3 text-xs text-destructive max-sm:px-3">{error}</p>}
      {status?.pairing && (
        <div className="px-4 py-4 text-center max-sm:px-3">
          {qrDataUrl ? (
            <img src={qrDataUrl} alt={t('Pairing QR code')} className="mx-auto h-52 w-52" />
          ) : (
            <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
          )}
          <p className="mt-3 font-medium text-sm">{t('Scan with your phone camera')}</p>
          <p className="mt-1 text-muted-foreground text-xs">
            {t(
              'Scanning opens the app and pairs it. To keep it handy, add it to your home screen.'
            )}
          </p>
          <p className="mt-1 text-muted-foreground text-xs">
            {t(
              'On another EnsoCode desktop, paste the link below into Settings → Devices → Connect to a node.'
            )}
          </p>
          <p className="mt-1 text-muted-foreground text-xs">
            {remaining === null
              ? t('The code expires in 60 seconds and can only be used once.')
              : remaining > 0
                ? t('Expires in {{seconds}}s · single use', { seconds: remaining })
                : t('Code expired')}
          </p>
          {status.inviteUri && (
            <div className="mt-3 flex items-center gap-2 text-left">
              <code className="min-w-0 flex-1 truncate bg-muted px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                {status.inviteUri}
              </code>
              <SettingsButton
                className="shrink-0"
                onClick={() => copyInvite(status.inviteUri as string)}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? t('Copied') : t('Copy')}
              </SettingsButton>
            </div>
          )}
        </div>
      )}
      <p className="px-4 py-3 font-medium text-[13px] max-sm:px-3">{t('Paired devices')}</p>
      {devices.length === 0 ? (
        <div className="px-4 py-8 text-center max-sm:px-3">
          <Smartphone className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-3 font-medium text-sm">{t('No paired devices')}</p>
          <p className="mt-1 text-muted-foreground text-xs">
            {t('Generate a pairing code to let a phone or another desktop connect.')}
          </p>
        </div>
      ) : (
        devices.map((device) => <PairedDeviceRow key={device.pairId} device={device} />)
      )}
    </SettingsSection>
  );
}

function SecureStorageNote() {
  const { t } = useI18n();
  return (
    <p className="flex items-start gap-2 px-4 py-3 text-xs text-muted-foreground max-sm:px-3">
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <span>
        {t('Secure storage is unavailable on this system, so pairing keys are stored unencrypted.')}
      </span>
    </p>
  );
}

/** 本机作为 guest：粘码连别的桌面 + 已连节点列表 */
function ConnectToNodesSection() {
  const { t } = useI18n();
  const nodes = useRemoteNodesStore((s) => s.nodes);
  const secureStorage = useRemoteNodesStore((s) => s.secureStorage);
  const refresh = useRemoteNodesStore((s) => s.refresh);
  const [pairOpen, setPairOpen] = React.useState(false);

  // 设置页可能先于节点列表挂载：自行绑定一次状态推送
  React.useEffect(() => useRemoteNodesStore.getState().bind(), []);

  return (
    <SettingsSection
      rowId="phone.connect-to-a-node"
      title={t('Connect to a node')}
      description={t(
        'Browse and drive conversations on another EnsoCode desktop. Its agent, keys and history stay there.'
      )}
      actions={
        <SettingsButton onClick={() => setPairOpen(true)}>
          <Plus className="h-4 w-4" />
          {t('Connect to a node')}
        </SettingsButton>
      }
    >
      {!secureStorage && <SecureStorageNote />}
      <p className="px-4 py-3 font-medium text-[13px] max-sm:px-3">{t('Connected nodes')}</p>
      {nodes.length === 0 ? (
        <div className="px-4 py-8 text-center max-sm:px-3">
          <Monitor className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-3 font-medium text-sm">{t('No connected nodes')}</p>
          <p className="mt-1 text-muted-foreground text-xs">
            {t('Each connecting computer needs its own pairing code from the other desktop.')}
          </p>
        </div>
      ) : (
        nodes.map((node) => (
          <NodeRow key={node.nodeId} node={node} onChanged={() => void refresh()} />
        ))
      )}
      <PairNodeDialog open={pairOpen} onOpenChange={setPairOpen} switchOnSuccess={false} />
    </SettingsSection>
  );
}

/** 业务帧出口标签：直连（WebRTC）/ 中继；只读，切换由 main 自动完成 */
function TransportBadge({ transport, rttMs }: { transport?: 'relay' | 'direct'; rttMs?: number }) {
  const { t } = useI18n();
  const direct = transport === 'direct';
  const rtt = formatRttMs(rttMs);
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none',
        direct ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'
      )}
    >
      {direct ? t('Direct link') : t('Via relay')}
      {rtt ? ` · ${rtt}` : ''}
    </span>
  );
}

function PairedDeviceRow({ device }: { device: PairStatus['devices'][number] }) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState<string | null>(null);

  const commit = async () => {
    if (draft === null) return;
    if (draft.trim() && draft.trim() !== device.deviceName) {
      await window.electronAPI.pair.rename(device.pairId, draft);
    }
    setDraft(null);
  };

  return (
    <div className="group flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 max-sm:px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            device.phoneOnline
              ? 'bg-success'
              : device.connected
                ? 'bg-warning'
                : 'bg-muted-foreground/40'
          )}
        />
        {draft === null ? (
          <>
            <span className="truncate font-medium text-sm">{device.deviceName}</span>
            <span className="shrink-0 text-muted-foreground text-xs">
              {device.phoneOnline
                ? t('Online')
                : device.connected
                  ? t('Waiting for device')
                  : t('Offline')}
            </span>
            {device.phoneOnline && (
              <TransportBadge transport={device.transport} rttMs={device.rttMs} />
            )}
            <button
              type="button"
              title={t('Click to switch: view-only devices cannot send, approve or stop.')}
              onClick={() =>
                void window.electronAPI.pair.setScope(
                  device.pairId,
                  device.scope === 'read' ? 'operate' : 'read'
                )
              }
              className={cn(
                'relative shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none transition-colors',
                device.scope === 'read'
                  ? 'bg-warning/15 text-warning hover:bg-warning/25'
                  : 'bg-muted text-muted-foreground hover:bg-accent'
              )}
            >
              {device.scope === 'read' ? t('View only') : t('Can operate')}
            </button>
          </>
        ) : (
          <Input
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit();
              if (e.key === 'Escape') setDraft(null);
            }}
            className="h-7 w-full max-w-full text-sm sm:w-[220px]"
          />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity pointer-coarse:opacity-100 group-hover:opacity-100">
        <Button
          variant="ghost"
          size="icon"
          className={ICON_BUTTON}
          title={t('Rename')}
          onClick={() => setDraft(device.deviceName)}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn(ICON_BUTTON, 'hover:text-destructive')}
          onClick={() => void window.electronAPI.pair.revoke(device.pairId)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function NodeRow({ node, onChanged }: { node: RemoteNodeStatus; onChanged: () => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState<string | null>(null);

  const commit = async () => {
    if (draft === null) return;
    if (draft.trim() && draft.trim() !== node.label) {
      await window.electronAPI.nodes.rename(node.nodeId, draft);
      onChanged();
    }
    setDraft(null);
  };

  return (
    <div className="group flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 max-sm:px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <NodeDot node={node} />
        {draft === null ? (
          <>
            <span className="truncate font-medium text-sm">{node.label}</span>
            {node.hostname && node.hostname !== node.label && (
              <span className="shrink-0 truncate font-mono text-[10px] text-muted-foreground">
                {node.hostname}
              </span>
            )}
            <span className="shrink-0 text-muted-foreground text-xs">
              {node.hostOnline
                ? t('Online')
                : node.connected
                  ? t('Remote desktop is offline')
                  : t('Offline')}
            </span>
            {node.hostOnline && <TransportBadge transport={node.transport} rttMs={node.rttMs} />}
          </>
        ) : (
          <Input
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit();
              if (e.key === 'Escape') setDraft(null);
            }}
            className="h-7 w-full max-w-full text-sm sm:w-[220px]"
          />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity pointer-coarse:opacity-100 group-hover:opacity-100">
        <Button
          variant="ghost"
          size="icon"
          className={ICON_BUTTON}
          title={t('Rename')}
          onClick={() => setDraft(node.label)}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn(ICON_BUTTON, 'hover:text-destructive')}
          title={t('Disconnect')}
          onClick={() => {
            void window.electronAPI.nodes.remove(node.nodeId).then(onChanged);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

/** 中继地址：两个方向共用（本机作 host 时用它出码；作 guest 时随对方链接走） */
function RelaySection() {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<PairStatus | null>(null);
  const [relayDraft, setRelayDraft] = React.useState<string | null>(null);

  React.useEffect(() => {
    void window.electronAPI.pair.status().then(setStatus);
    return window.electronAPI.pair.onStatusChanged(setStatus);
  }, []);

  const saveRelay = async () => {
    if (relayDraft === null) return;
    setStatus(await window.electronAPI.pair.setRelayUrl(relayDraft));
    setRelayDraft(null);
  };

  return (
    <SettingsSection>
      <SettingsRow
        rowId="phone.relay-server"
        label={t('Relay server')}
        description={t('The relay only forwards encrypted frames and cannot read your messages.')}
      >
        <Input
          value={relayDraft ?? status?.relayUrl ?? ''}
          onChange={(e) => setRelayDraft(e.target.value)}
          placeholder="https://relay.example.com"
          className="w-full font-mono text-xs sm:w-[220px]"
        />
        {relayDraft === null ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className={ICON_BUTTON}
            onClick={() => setRelayDraft(status?.relayUrl ?? '')}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <SettingsButton variant="default" onClick={() => void saveRelay()}>
            <Check className="h-3.5 w-3.5" />
            {t('Save')}
          </SettingsButton>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
