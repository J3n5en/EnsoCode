import type { NodePairError } from '@shared/types/nodes';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { useRemoteNodesStore } from '@/stores/remoteNodes';

interface PairNodeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 配对成功后是否立即切到该节点（节点切换器入口 true；设置页 false） */
  switchOnSuccess?: boolean;
}

/** 与 main 侧 NodePairError 对应的用户可读文案键 */
const ERROR_KEYS: Record<NodePairError, string> = {
  'invalid-uri': 'That is not an EnsoCode pairing link.',
  'expired-or-claimed': 'This pairing link has expired or was already used. Generate a new one.',
  'relay-unreachable': 'Could not reach the relay. Check your network and try again.',
};

/** 粘贴另一台桌面「设置 → 设备」里复制的配对链接，认领后进入其房间 */
export function PairNodeDialog({
  open,
  onOpenChange,
  switchOnSuccess = true,
}: PairNodeDialogProps) {
  const { t } = useI18n();
  const [uri, setUri] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUri('');
    setError(null);
    setBusy(false);
  }, [open]);

  const submit = async () => {
    const trimmed = uri.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    const result = await window.electronAPI.nodes.pair(trimmed);
    setBusy(false);
    if (!result.ok) {
      setError(t(ERROR_KEYS[result.error]) + (result.detail ? ` (${result.detail})` : ''));
      return;
    }
    await useRemoteNodesStore.getState().refresh();
    if (switchOnSuccess) useRemoteNodesStore.getState().switchNode(result.node.nodeId);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Connect to a node')}</DialogTitle>
          <DialogDescription>
            {t(
              'On the other computer open Settings → Devices, generate a pairing code and copy the link. Paste it here.'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-2">
          <Input
            value={uri}
            onChange={(e) => setUri(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
            placeholder="https://…/#relay=…&pk=…"
            autoFocus
            spellCheck={false}
            className="font-mono text-xs"
          />
          {error && <p className="text-destructive text-xs">{error}</p>}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button size="sm" disabled={busy || !uri.trim()} onClick={() => void submit()}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('Connect')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
