import { DEFAULT_TRIGGER_COALESCE_MS, DEFAULT_TRIGGER_PORT } from '@shared/secretary/triggers';
import type { SecretaryTriggerServerState, SecretaryTriggerView } from '@shared/types/secretary';
import { Check, Copy, Play, RefreshCw, Trash2 } from 'lucide-react';
import * as React from 'react';
import {
  SettingsButton,
  SettingsExpandableRow,
  SettingsRow,
  SettingsSection,
  SettingsSubRow,
  SettingsSwitch,
} from '@/components/settings/kit';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';
import { formatClock, formatRelativeTime } from '@/lib/time';

function formatWhen(ts: number, locale: string): string {
  return `${formatRelativeTime(ts, locale)} ${formatClock(ts, locale)}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyableValue({
  value,
  copiedLabel,
  copyLabel,
}: {
  value: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);

  const handleCopy = async () => {
    const ok = await copyText(value);
    if (!ok) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex max-w-full flex-wrap items-center justify-end gap-1.5">
      <code className="max-w-[360px] truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11.5px] text-foreground">
        {value}
      </code>
      <SettingsButton variant="ghost" onClick={() => void handleCopy()}>
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        {copied ? copiedLabel : copyLabel}
      </SettingsButton>
    </div>
  );
}

function TriggerItemRow({
  trigger,
  secretaryId,
  initialToken,
  defaultOpen,
  locale,
  onReload,
}: {
  trigger: SecretaryTriggerView;
  secretaryId?: string;
  initialToken?: string;
  defaultOpen?: boolean;
  locale: string;
  onReload: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(Boolean(defaultOpen));
  const [busy, setBusy] = React.useState(false);
  const [token, setToken] = React.useState<string | null>(initialToken ?? null);
  const [tokenCopied, setTokenCopied] = React.useState(false);
  const [testMessage, setTestMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const [instruction, setInstruction] = React.useState(trigger.instruction ?? '');
  const [coalesceSec, setCoalesceSec] = React.useState(
    String(Math.round(trigger.coalesceMs / 1000))
  );

  React.useEffect(() => {
    setInstruction(trigger.instruction ?? '');
    setCoalesceSec(String(Math.round(trigger.coalesceMs / 1000)));
  }, [trigger.instruction, trigger.coalesceMs]);

  const descriptionParts = [
    trigger.coalesceMs > 0
      ? t('Coalesce {{s}}s', { s: Math.round(trigger.coalesceMs / 1000) })
      : t('Immediate delivery'),
    trigger.fireCount > 0 && trigger.lastFiredAt
      ? t('Fired {{n}} times · Last {{time}}', {
          n: trigger.fireCount,
          time: formatWhen(trigger.lastFiredAt, locale),
        })
      : t('Never fired'),
  ];

  const handleToggle = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    const res = await window.electronAPI.secretary.updateTrigger(
      trigger.id,
      { enabled },
      secretaryId
    );
    setBusy(false);
    if (!res.ok) setError(res.error);
    await onReload();
  };

  const handleSaveDetails = async () => {
    const parsedSec = Number(coalesceSec);
    if (!Number.isFinite(parsedSec) || parsedSec < 0 || parsedSec > 60) {
      setError(t('Coalesce window must be between 0 and 60 seconds.'));
      return;
    }
    setBusy(true);
    setError(null);
    const res = await window.electronAPI.secretary.updateTrigger(
      trigger.id,
      {
        instruction: instruction.trim() ? instruction.trim() : null,
        coalesceMs: Math.round(parsedSec * 1000),
      },
      secretaryId
    );
    setBusy(false);
    if (!res.ok) setError(res.error);
    await onReload();
  };

  const handleCopyToken = async () => {
    setError(null);
    let value = token;
    if (!value) {
      const res = await window.electronAPI.secretary.revealTriggerToken(trigger.id, secretaryId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      value = res.token;
    }
    const ok = await copyText(value);
    if (ok) {
      setTokenCopied(true);
      setTimeout(() => setTokenCopied(false), 1500);
    }
  };

  const handleRotateToken = async () => {
    setBusy(true);
    setError(null);
    const res = await window.electronAPI.secretary.rotateTriggerToken(trigger.id, secretaryId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setToken(res.token);
  };

  const handleTest = async () => {
    setBusy(true);
    setError(null);
    setTestMessage(null);
    const res = await window.electronAPI.secretary.testTrigger(trigger.id, undefined, secretaryId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setTestMessage(t('Test event queued'));
    setTimeout(() => setTestMessage(null), 2500);
    await onReload();
  };

  const handleRemove = async () => {
    setBusy(true);
    setError(null);
    const res = await window.electronAPI.secretary.removeTrigger(trigger.id, secretaryId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    await onReload();
  };

  return (
    <SettingsExpandableRow
      open={open}
      onOpenChange={setOpen}
      label={trigger.name}
      description={descriptionParts.join(' · ')}
      rowId={`secretary.trigger.${trigger.id}`}
      control={
        <SettingsSwitch
          checked={trigger.enabled}
          disabled={busy}
          onCheckedChange={(checked) => void handleToggle(checked)}
        />
      }
    >
      <SettingsSubRow rowId="secretary.http-post-url" label={t('HTTP POST URL')}>
        <CopyableValue value={trigger.httpUrl} copyLabel={t('Copy')} copiedLabel={t('Copied')} />
      </SettingsSubRow>
      <SettingsSubRow rowId="secretary.websocket-url" label={t('WebSocket URL')}>
        <CopyableValue value={trigger.wsUrl} copyLabel={t('Copy')} copiedLabel={t('Copied')} />
      </SettingsSubRow>
      <SettingsSubRow
        rowId="secretary.bearer-token"
        label={t('Bearer token')}
        description={t('Pass via Authorization: Bearer <token> or X-Enso-Token header.')}
      >
        <div className="flex max-w-full flex-wrap items-center justify-end gap-1.5">
          {token ? (
            <code className="max-w-[260px] truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11.5px]">
              {token}
            </code>
          ) : (
            <span className="font-mono text-xs text-muted-foreground">••••••••••••••••</span>
          )}
          <SettingsButton variant="ghost" disabled={busy} onClick={() => void handleCopyToken()}>
            {tokenCopied ? (
              <Check className="size-3.5 text-success" />
            ) : (
              <Copy className="size-3.5" />
            )}
            {tokenCopied ? t('Copied') : t('Copy token')}
          </SettingsButton>
          <SettingsButton variant="ghost" disabled={busy} onClick={() => void handleRotateToken()}>
            <RefreshCw className="size-3.5" />
            {t('Rotate')}
          </SettingsButton>
        </div>
      </SettingsSubRow>
      <SettingsSubRow
        rowId="secretary.coalesce-window-seconds"
        label={t('Coalesce window (seconds)')}
        description={t(
          'Combine consecutive events within this window into one wake-up (0 = immediate).'
        )}
      >
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={0}
            max={60}
            size="sm"
            className="w-20"
            value={coalesceSec}
            onChange={(e) => setCoalesceSec(e.target.value)}
            onBlur={() => void handleSaveDetails()}
          />
        </div>
      </SettingsSubRow>
      <SettingsSubRow
        rowId="secretary.trigger-instruction"
        label={t('Trigger instruction')}
        description={t(
          'Trusted rule shown outside untrusted event payload so the secretary knows how to react.'
        )}
      >
        <div className="flex w-full max-w-md flex-col gap-1.5">
          <Textarea
            rows={2}
            value={instruction}
            placeholder={t('Optional handling rule for this trigger')}
            onChange={(e) => setInstruction(e.target.value)}
            onBlur={() => void handleSaveDetails()}
          />
        </div>
      </SettingsSubRow>
      <SettingsSubRow
        rowId="secretary.actions"
        label={t('Actions')}
        status={
          error ? (
            <span className="text-xs text-destructive">{error}</span>
          ) : testMessage ? (
            <span className="text-xs text-success">{testMessage}</span>
          ) : undefined
        }
      >
        <SettingsButton variant="outline" disabled={busy} onClick={() => void handleTest()}>
          <Play className="size-3.5" />
          {t('Send test event')}
        </SettingsButton>
        <SettingsButton
          variant="ghost"
          disabled={busy}
          className="text-destructive hover:text-destructive"
          onClick={() => void handleRemove()}
        >
          <Trash2 className="size-3.5" />
          {t('Remove')}
        </SettingsButton>
      </SettingsSubRow>
    </SettingsExpandableRow>
  );
}

/** 设置 → 秘书 → 本机触发器：严格复用 settings/kit，不画嵌套卡片 */
export function SecretaryTriggerSection({
  secretaryId,
  locale,
}: {
  secretaryId?: string;
  locale: string;
}) {
  const { t } = useI18n();
  const [server, setServer] = React.useState<SecretaryTriggerServerState | null>(null);
  const [triggers, setTriggers] = React.useState<SecretaryTriggerView[]>([]);
  const [freshTokens, setFreshTokens] = React.useState<Record<string, string>>({});
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [newInstruction, setNewInstruction] = React.useState('');
  const [newCoalesceSec, setNewCoalesceSec] = React.useState(
    String(Math.round(DEFAULT_TRIGGER_COALESCE_MS / 1000))
  );
  const [portInput, setPortInput] = React.useState(String(DEFAULT_TRIGGER_PORT));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const api = window.electronAPI?.secretary;
    if (!api?.listTriggers) return;
    const res = await api.listTriggers(secretaryId);
    if (!res?.ok) return;
    setServer(res.server);
    setTriggers(res.triggers);
    setPortInput(String(res.server.configuredPort));
  }, [secretaryId]);

  React.useEffect(() => {
    void load();
    return window.electronAPI?.secretary?.onTriggersChanged?.(() => {
      void load();
    });
  }, [load]);

  const handleSavePort = async () => {
    const port = Number(portInput);
    if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) {
      setError(t('Port must be 0 (random) or between 1024 and 65535.'));
      return;
    }
    setBusy(true);
    setError(null);
    const res = await window.electronAPI.secretary.setTriggerServerPort(port);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setServer(res.server);
    await load();
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) {
      setError(t('Trigger name is required.'));
      return;
    }
    const sec = Number(newCoalesceSec);
    if (!Number.isFinite(sec) || sec < 0 || sec > 60) {
      setError(t('Coalesce window must be between 0 and 60 seconds.'));
      return;
    }
    setBusy(true);
    setError(null);
    const res = await window.electronAPI.secretary.createTrigger(
      {
        name,
        enabled: true,
        coalesceMs: Math.round(sec * 1000),
        ...(newInstruction.trim() ? { instruction: newInstruction.trim() } : {}),
      },
      secretaryId
    );
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setFreshTokens((prev) => ({ ...prev, [res.trigger.id]: res.token }));
    setNewName('');
    setNewInstruction('');
    setNewCoalesceSec(String(Math.round(DEFAULT_TRIGGER_COALESCE_MS / 1000)));
    setCreating(false);
    await load();
  };

  const statusBadge = () => {
    if (!server) return null;
    if (server.status === 'listening') {
      return (
        <Badge variant="secondary" className="font-mono text-[11px]">
          {`127.0.0.1:${server.port}`}
        </Badge>
      );
    }
    if (server.status === 'error') {
      return (
        <Badge variant="destructive" className="text-[11px]">
          {t('Listen failed')}
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="text-[11px]">
        {t('Idle')}
      </Badge>
    );
  };

  return (
    <SettingsSection
      title={t('Local triggers')}
      description={t(
        'Loopback-only (127.0.0.1) HTTP POST & WebSocket endpoints for local scripts and watchers to wake this secretary. Starts automatically only when at least one trigger is enabled.'
      )}
      rowId="secretary.triggers"
      actions={
        <SettingsButton
          variant="outline"
          disabled={busy}
          onClick={() => {
            setError(null);
            setCreating((prev) => !prev);
          }}
        >
          {creating ? t('Cancel') : t('New trigger')}
        </SettingsButton>
      }
    >
      <SettingsRow
        rowId="secretary.triggers.server"
        label={t('Local listener port')}
        description={
          server?.status === 'error' && server.error
            ? server.error
            : server?.status === 'listening'
              ? t('Listening on 127.0.0.1:{{port}} ({{n}} active)', {
                  port: server.port,
                  n: server.activeCount,
                })
              : t('Starts automatically on 127.0.0.1 when any trigger is enabled.')
        }
        status={statusBadge()}
      >
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={0}
            max={65535}
            size="sm"
            className="w-24 font-mono"
            value={portInput}
            onChange={(e) => setPortInput(e.target.value)}
          />
          <SettingsButton
            variant="outline"
            disabled={busy || Number(portInput) === server?.configuredPort}
            onClick={() => void handleSavePort()}
          >
            {t('Apply')}
          </SettingsButton>
        </div>
      </SettingsRow>

      {error ? <p className="px-4 py-2 text-xs text-destructive max-sm:px-3">{error}</p> : null}

      {creating ? (
        <div data-slot="settings-sub-group" className="bg-muted/45 dark:bg-background/40">
          <SettingsSubRow rowId="secretary.name" label={t('Name')}>
            <Input
              size="sm"
              className="w-64"
              placeholder={t('e.g. WeChat after-sales watcher')}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </SettingsSubRow>
          <SettingsSubRow
            rowId="secretary.coalesce-window-seconds-2"
            label={t('Coalesce window (seconds)')}
            description={t(
              'Combine consecutive events within this window into one wake-up (0 = immediate).'
            )}
          >
            <Input
              type="number"
              min={0}
              max={60}
              size="sm"
              className="w-20"
              value={newCoalesceSec}
              onChange={(e) => setNewCoalesceSec(e.target.value)}
            />
          </SettingsSubRow>
          <SettingsSubRow
            rowId="secretary.trigger-instruction-2"
            label={t('Trigger instruction')}
            description={t('Optional rule telling the secretary how to handle incoming events.')}
          >
            <Textarea
              rows={2}
              className="w-full max-w-md"
              placeholder={t('Optional handling rule for this trigger')}
              value={newInstruction}
              onChange={(e) => setNewInstruction(e.target.value)}
            />
          </SettingsSubRow>
          <SettingsSubRow label="">
            <SettingsButton variant="ghost" disabled={busy} onClick={() => setCreating(false)}>
              {t('Cancel')}
            </SettingsButton>
            <SettingsButton disabled={busy} onClick={() => void handleCreate()}>
              {t('Create trigger')}
            </SettingsButton>
          </SettingsSubRow>
        </div>
      ) : null}

      {triggers.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground max-sm:px-3">
          {t('No local triggers yet.')}
        </p>
      ) : (
        triggers.map((trigger) => (
          <TriggerItemRow
            key={trigger.id}
            trigger={trigger}
            secretaryId={secretaryId}
            initialToken={freshTokens[trigger.id]}
            defaultOpen={Boolean(freshTokens[trigger.id])}
            locale={locale}
            onReload={load}
          />
        ))
      )}
    </SettingsSection>
  );
}
