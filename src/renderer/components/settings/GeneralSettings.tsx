import { AUTO_RETRY_LIMIT_OPTIONS, UNLIMITED_AUTO_RETRY } from '@shared/autoRetry';
import { CA_CERT_EXTENSIONS, type CaCertError, type CaCertStatus } from '@shared/caCert';
import { isValidProxyUrl, type ProxyMode } from '@shared/proxy';
import type { ShellIntegration } from '@shared/shellIntegration';
import { GENERATION_STALL_TIMEOUT_MINUTES } from '@shared/stallTimeout';
import { type TerminalShell, terminalShellsForPlatform } from '@shared/terminalShell';
import type { ServerUpdateMode, UpdaterState, UpdateStatus } from '@shared/types/updater';
import type { WindowsLocalShell } from '@shared/windowsLocalShell';
import { isAbsolutePathLike } from '@shared/worktreeRoot';
import * as React from 'react';
import { ReleaseNotesDialog } from '@/components/app/ReleaseNotesDialog';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { ACTIVE_RETENTION_MINUTES } from '@/stores/settings/activeRetention';
import {
  AUTO_ARCHIVE_IDLE_DAYS,
  AUTO_DELETE_ARCHIVED_DAYS,
} from '@/stores/settings/autoArchiveIdleDays';
import { CompactReserveTokensSection } from './CompactReserveTokensSection';
import { ConfigSyncSettings } from './ConfigSyncSettings';
import { NewSessionBadge } from './NewSessionBadge';
import { SmartCompactPicker } from './SmartCompactPicker';

const TERMINAL_SHELL_LABELS: Record<Exclude<TerminalShell, 'auto'>, string> = {
  cmd: 'Command Prompt',
  powershell: 'Windows PowerShell',
  pwsh: 'PowerShell 7 (pwsh)',
  'git-bash': 'Git Bash',
  zsh: 'zsh',
  bash: 'bash',
  fish: 'fish',
};

export function GeneralSettings() {
  const { language, setLanguage } = useSettingsStore();
  const { t } = useI18n();

  return (
    <div className="space-y-8">
      <div>
        <h3 className="text-lg font-medium">{t('General')}</h3>
        <p className="text-sm text-muted-foreground">{t('General application settings')}</p>
      </div>

      <section className="space-y-3">
        <h4 className="border-b pb-2 text-base font-semibold">{t('Application')}</h4>
        <div className="flex items-center gap-3" data-settings-row="general.language">
          <span className="text-sm font-medium">{t('Language')}</span>
          <Select
            items={{ en: 'English', zh: '简体中文' }}
            value={language}
            onValueChange={(v) => setLanguage(v as 'en' | 'zh')}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="zh">简体中文</SelectItem>
            </SelectPopup>
          </Select>
        </div>
        <NotificationSection />
        <ProxySection />
        <CaCertSection />
        <ConfigSyncSettings />
        <UpdateSection />
      </section>

      <section className="space-y-3">
        <h4 className="border-b pb-2 text-base font-semibold">{t('Agent runtime')}</h4>
        <GenerationStallTimeoutRow />
        <AutoRetryLimitRow />
        <SmartCompactPicker />
        <CompactReserveTokensSection />
      </section>

      <section className="space-y-3">
        <h4 className="border-b pb-2 text-base font-semibold">{t('Sessions & worktrees')}</h4>
        <AutoArchiveSection />
        <ActiveRetentionMinutesRow />
        <WorktreeRootSection />
      </section>

      <section className="space-y-3">
        <h4 className="border-b pb-2 text-base font-semibold">{t('Terminal')}</h4>
        <WindowsLocalShellSection />
        <TerminalShellSection />
      </section>

      {window.electronAPI.env.platform === 'darwin' && (
        <section className="space-y-3">
          <h4 className="border-b pb-2 text-base font-semibold">{t('Integrations')}</h4>
          <ShellIntegrationRow
            kind="ensoCommand"
            title={t("'enso' terminal command")}
            description={t(
              'Run `enso .` in a terminal to open the current folder in EnsoCode. Links the command into /usr/local/bin and may ask for your password.'
            )}
          />
          <ShellIntegrationRow
            kind="finderQuickAction"
            title={t('Finder Quick Action')}
            description={t(
              'Right-click a folder in Finder and choose Services > Open with EnsoCode.'
            )}
          />
        </section>
      )}
    </div>
  );
}

function ShellIntegrationRow({
  kind,
  title,
  description,
}: {
  kind: ShellIntegration;
  title: string;
  description: string;
}) {
  const { t } = useI18n();
  const [installed, setInstalled] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    const refresh = () => {
      void window.electronAPI.window.shellIntegrationStatus().then((status) => {
        if (active) setInstalled(status[kind]);
      });
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      window.removeEventListener('focus', refresh);
    };
  }, [kind]);

  const toggle = async () => {
    setBusy(true);
    try {
      await window.electronAPI.window.installShellIntegration(kind);
    } finally {
      try {
        const status = await window.electronAPI.window.shellIntegrationStatus();
        setInstalled(status[kind]);
      } finally {
        setBusy(false);
      }
    }
  };
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
      data-settings-row={`general.${kind}`}
    >
      <div className="min-w-0">
        <p className="text-sm">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        disabled={busy}
        onClick={() => void toggle()}
      >
        {busy ? t('In progress…') : t(installed ? 'Uninstall' : 'Install')}
      </Button>
    </div>
  );
}

function NotificationSection() {
  const { t } = useI18n();
  const notifyMainAgentOnly = useSettingsStore((s) => s.notifyMainAgentOnly);
  const setNotifyMainAgentOnly = useSettingsStore((s) => s.setNotifyMainAgentOnly);
  return (
    <SwitchRow
      rowId="general.notifyMainAgentOnly"
      title={t('Notify only for the main agent')}
      description={t(
        'Skip coworker completion and failure notifications on this computer and the paired phone. Questions and approvals still notify.'
      )}
      checked={notifyMainAgentOnly}
      onChange={setNotifyMainAgentOnly}
    />
  );
}

function GenerationStallTimeoutRow() {
  const { t } = useI18n();
  const generationStallTimeoutMin = useSettingsStore((s) => s.generationStallTimeoutMin);
  const setGenerationStallTimeoutMin = useSettingsStore((s) => s.setGenerationStallTimeoutMin);
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
      data-settings-row="general.generationStallTimeout"
    >
      <div className="min-w-0">
        <p className="text-sm">{t('Stop if no output')}</p>
        <p className="text-xs text-muted-foreground">
          {t(
            'Abort and retry the run when no tokens or tool results arrive for this long. Thinking counts as output.'
          )}
        </p>
      </div>
      <Select
        items={Object.fromEntries(
          GENERATION_STALL_TIMEOUT_MINUTES.map((value) => [
            String(value),
            value === 0 ? t('Never') : t('{{count}} min', { count: value }),
          ])
        )}
        value={String(generationStallTimeoutMin)}
        onValueChange={(value) => setGenerationStallTimeoutMin(Number(value))}
      >
        <SelectTrigger className="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {GENERATION_STALL_TIMEOUT_MINUTES.map((value) => (
            <SelectItem key={value} value={String(value)}>
              {value === 0 ? t('Never') : t('{{count}} min', { count: value })}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

function AutoRetryLimitRow() {
  const { t } = useI18n();
  const autoRetryLimit = useSettingsStore((s) => s.autoRetryLimit);
  const setAutoRetryLimit = useSettingsStore((s) => s.setAutoRetryLimit);
  const autoRetryOptions = AUTO_RETRY_LIMIT_OPTIONS.some((value) => value === autoRetryLimit)
    ? [...AUTO_RETRY_LIMIT_OPTIONS]
    : [...AUTO_RETRY_LIMIT_OPTIONS, autoRetryLimit].sort((a, b) =>
        a === UNLIMITED_AUTO_RETRY ? 1 : b === UNLIMITED_AUTO_RETRY ? -1 : a - b
      );
  const autoRetryLabel = (value: number) =>
    value === 0
      ? t('Off')
      : value === UNLIMITED_AUTO_RETRY
        ? t('Unlimited')
        : t('{{count}} times', { count: value });
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
      data-settings-row="general.autoRetryLimit"
    >
      <div className="min-w-0">
        <p className="text-sm">{t('Auto-retry on transient errors')}</p>
        <p className="text-xs text-muted-foreground">
          {t(
            'Retry with backoff (up to 60s apart) after 429, 5xx or network errors. Quota and billing errors are never retried. Unlimited keeps retrying until you cancel.'
          )}
        </p>
      </div>
      <Select
        items={Object.fromEntries(
          autoRetryOptions.map((value) => [String(value), autoRetryLabel(value)])
        )}
        value={String(autoRetryLimit)}
        onValueChange={(value) => setAutoRetryLimit(Number(value))}
      >
        <SelectTrigger className="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {autoRetryOptions.map((value) => (
            <SelectItem key={value} value={String(value)}>
              {autoRetryLabel(value)}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

function ActiveRetentionMinutesRow() {
  const { t } = useI18n();
  const activeRetentionMinutes = useSettingsStore((s) => s.activeRetentionMinutes);
  const setActiveRetentionMinutes = useSettingsStore((s) => s.setActiveRetentionMinutes);
  const retentionLabel = (value: number) =>
    value === 0 ? t('Off') : t('{{count}} min', { count: value });
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
      data-settings-row="general.activeRetentionMinutes"
    >
      <div className="min-w-0">
        <p className="text-sm">{t('Keep in Active after last message')}</p>
        <p className="text-xs text-muted-foreground">
          {t(
            'Viewed conversations stay in Active for this long after their last message or your last open while still in Active, then leave. Unviewed ones stay until you open them.'
          )}
        </p>
      </div>
      <Select
        items={Object.fromEntries(
          ACTIVE_RETENTION_MINUTES.map((value) => [String(value), retentionLabel(value)])
        )}
        value={String(activeRetentionMinutes)}
        onValueChange={(value) => setActiveRetentionMinutes(Number(value))}
      >
        <SelectTrigger className="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {ACTIVE_RETENTION_MINUTES.map((value) => (
            <SelectItem key={value} value={String(value)}>
              {retentionLabel(value)}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

function dayLabel(
  t: (key: string, params?: Record<string, string | number>) => string,
  value: number
): string {
  if (value === 0) return t('Never');
  if (value === 1) return t('{{count}} day', { count: value });
  return t('{{count}} days', { count: value });
}

function AutoArchiveSection() {
  const { t } = useI18n();
  const autoArchiveIdleDays = useSettingsStore((s) => s.autoArchiveIdleDays);
  const setAutoArchiveIdleDays = useSettingsStore((s) => s.setAutoArchiveIdleDays);
  const autoArchiveMergedWorktrees = useSettingsStore((s) => s.autoArchiveMergedWorktrees);
  const setAutoArchiveMergedWorktrees = useSettingsStore((s) => s.setAutoArchiveMergedWorktrees);
  const autoDeleteArchivedDays = useSettingsStore((s) => s.autoDeleteArchivedDays);
  const setAutoDeleteArchivedDays = useSettingsStore((s) => s.setAutoDeleteArchivedDays);
  return (
    <div className="space-y-2">
      <div
        className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
        data-settings-row="general.autoArchiveIdleDays"
      >
        <div className="min-w-0">
          <p className="text-sm">{t('Archive idle conversations')}</p>
          <p className="text-xs text-muted-foreground">
            {t(
              'Move conversations that have been idle this long into Archived. Does not delete them.'
            )}
          </p>
        </div>
        <Select
          items={Object.fromEntries(
            AUTO_ARCHIVE_IDLE_DAYS.map((value) => [String(value), dayLabel(t, value)])
          )}
          value={String(autoArchiveIdleDays)}
          onValueChange={(value) => setAutoArchiveIdleDays(Number(value))}
        >
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {AUTO_ARCHIVE_IDLE_DAYS.map((value) => (
              <SelectItem key={value} value={String(value)}>
                {dayLabel(t, value)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <SwitchRow
        rowId="general.autoArchiveMergedWorktrees"
        title={t('Clean up merged worktrees')}
        description={t(
          'When archiving idle conversations, also remove isolated worktrees that are merged and clean.'
        )}
        checked={autoArchiveMergedWorktrees}
        onChange={setAutoArchiveMergedWorktrees}
      />
      <div
        className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
        data-settings-row="general.autoDeleteArchivedDays"
      >
        <div className="min-w-0">
          <p className="text-sm">{t('Delete archived conversations after')}</p>
          <p className="text-xs text-muted-foreground">
            {t(
              'Permanently delete conversations that have been archived longer than this. This cannot be undone. Choosing a positive value deletes already-overdue archived conversations immediately.'
            )}
          </p>
        </div>
        <Select
          items={Object.fromEntries(
            AUTO_DELETE_ARCHIVED_DAYS.map((value) => [String(value), dayLabel(t, value)])
          )}
          value={String(autoDeleteArchivedDays)}
          onValueChange={(value) => setAutoDeleteArchivedDays(Number(value))}
        >
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {AUTO_DELETE_ARCHIVED_DAYS.map((value) => (
              <SelectItem key={value} value={String(value)}>
                {dayLabel(t, value)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    </div>
  );
}

function TerminalShellSection() {
  const { t } = useI18n();
  const terminalShell = useSettingsStore((s) => s.terminalShell);
  const setTerminalShell = useSettingsStore((s) => s.setTerminalShell);
  const options = terminalShellsForPlatform(window.electronAPI.env.platform);
  const labels = Object.fromEntries(
    options.map((value) => [
      value,
      value === 'auto' ? t('System default') : TERMINAL_SHELL_LABELS[value],
    ])
  ) as Record<TerminalShell, string>;
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
      data-settings-row="general.terminalShell"
    >
      <div className="min-w-0">
        <p className="text-sm">{t('Terminal shell')}</p>
        <p className="text-xs text-muted-foreground">
          {t('Applies to new side panel terminals. SSH projects keep the remote login shell.')}
        </p>
      </div>
      <Select
        items={labels}
        value={terminalShell}
        onValueChange={(value) => setTerminalShell(value as TerminalShell)}
      >
        <SelectTrigger className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {options.map((value) => (
            <SelectItem key={value} value={value}>
              {labels[value]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

function WorktreeRootSection() {
  const { t } = useI18n();
  const worktreeRoot = useSettingsStore((s) => s.worktreeRoot);
  const setWorktreeRoot = useSettingsStore((s) => s.setWorktreeRoot);
  const [draft, setDraft] = React.useState(worktreeRoot);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setDraft(worktreeRoot);
  }, [worktreeRoot]);

  const commit = (value: string) => {
    const next = value.trim();
    if (next && !isAbsolutePathLike(next)) {
      setError(t('Enter an absolute path'));
      return;
    }
    setError(null);
    setWorktreeRoot(next);
  };

  const browse = async () => {
    const dir = await window.electronAPI.dialog.selectDirectory();
    if (dir) {
      setDraft(dir);
      commit(dir);
    }
  };

  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
      data-settings-row="general.worktreeRoot"
    >
      <div className="min-w-0">
        <p className="text-sm">{t('Worktree root directory')}</p>
        <p className="text-xs text-muted-foreground">
          {t(
            'Where isolated session worktrees are created. Leave empty to use the app data directory. Existing worktrees stay where they are.'
          )}
        </p>
      </div>
      <div className="w-72 shrink-0 space-y-1">
        <div className="flex items-center gap-2">
          <Input
            value={draft}
            placeholder={t('Default location')}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => commit(draft)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit(draft);
            }}
          />
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => void browse()}>
            {t('Browse')}
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}

function WindowsLocalShellSection() {
  const { t } = useI18n();
  const windowsLocalShell = useSettingsStore((s) => s.windowsLocalShell);
  const setWindowsLocalShell = useSettingsStore((s) => s.setWindowsLocalShell);
  const labels: Record<WindowsLocalShell, string> = {
    auto: t('Windows default (PowerShell)'),
    powershell: t('PowerShell'),
    bash: t('Git Bash'),
  };
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
      data-settings-row="general.windowsLocalShell"
    >
      <div className="min-w-0">
        <p className="text-sm">
          {t('Windows local command shell')}
          <NewSessionBadge />
        </p>
        <p className="text-xs text-muted-foreground">
          {t(
            'Only the Windows local agent command tool. SSH and other platforms stay on bash. Takes effect on the next session.'
          )}
        </p>
      </div>
      <Select
        items={labels}
        value={windowsLocalShell}
        onValueChange={(value) => setWindowsLocalShell(value as WindowsLocalShell)}
      >
        <SelectTrigger className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {(Object.keys(labels) as WindowsLocalShell[]).map((value) => (
            <SelectItem key={value} value={value}>
              {labels[value]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

export function SwitchRow({
  title,
  description,
  checked,
  onChange,
  rowId,
  children,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  rowId?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border px-3 py-2.5" data-settings-row={rowId}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm">{title}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Switch checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      </div>
      {children ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}

function applyProxy(mode: ProxyMode, customUrl: string): void {
  void window.electronAPI.proxy.apply({ mode, customUrl });
}

function ProxySection() {
  const { t } = useI18n();
  const proxyMode = useSettingsStore((s) => s.proxyMode);
  const customProxyUrl = useSettingsStore((s) => s.customProxyUrl);
  const setProxyMode = useSettingsStore((s) => s.setProxyMode);
  const setCustomProxyUrl = useSettingsStore((s) => s.setCustomProxyUrl);
  const [draft, setDraft] = React.useState(customProxyUrl);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setDraft(customProxyUrl);
  }, [customProxyUrl]);

  const changeMode = (mode: ProxyMode) => {
    setProxyMode(mode);
    applyProxy(mode, customProxyUrl);
  };

  const commitUrl = () => {
    const next = draft.trim();
    if (next && !isValidProxyUrl(next)) {
      setError(t('Enter an http(s) proxy URL'));
      return;
    }
    setError(null);
    setCustomProxyUrl(next);
    applyProxy(proxyMode, next);
  };

  return (
    <div className="space-y-3" data-settings-row="general.proxy">
      <div>
        <h4 className="text-sm font-medium">{t('Network proxy')}</h4>
        <p className="text-xs text-muted-foreground">
          {t('Used by model requests, the built-in browser, and agent tools')}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">{t('Proxy mode')}</span>
        <Select
          items={{
            system: t('Follow system proxy'),
            none: t('No proxy'),
            custom: t('Custom proxy'),
          }}
          value={proxyMode}
          onValueChange={(value) => changeMode(value as ProxyMode)}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="system">{t('Follow system proxy')}</SelectItem>
            <SelectItem value="none">{t('No proxy')}</SelectItem>
            <SelectItem value="custom">{t('Custom proxy')}</SelectItem>
          </SelectPopup>
        </Select>
      </div>
      {proxyMode === 'custom' && (
        <div className="flex items-start gap-3">
          <span className="pt-1.5 text-sm font-medium">{t('Proxy URL')}</span>
          <div className="min-w-0 space-y-1">
            <Input
              value={draft}
              placeholder="http://127.0.0.1:7890"
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitUrl}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitUrl();
              }}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function CaCertSection() {
  const { t } = useI18n();
  const customCaCertPath = useSettingsStore((s) => s.customCaCertPath);
  const setCustomCaCertPath = useSettingsStore((s) => s.setCustomCaCertPath);
  const [status, setStatus] = React.useState<CaCertStatus | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    window.electronAPI.caCert
      .status()
      .then((next) => {
        if (alive) setStatus(next);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const apply = async (path: string) => {
    setCustomCaCertPath(path);
    setBusy(true);
    try {
      setStatus(await window.electronAPI.caCert.apply(path));
    } catch {
      // 远端宿主不支持时保持原状态
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    const path = await window.electronAPI.dialog.selectFile([...CA_CERT_EXTENSIONS]);
    if (path) await apply(path);
  };

  const errorText: Record<CaCertError, string> = {
    'not-absolute': t('Path must be absolute'),
    'not-found': t('File not found'),
    'not-file': t('Not a file'),
    'not-readable': t('File is not readable'),
  };

  const statusText = (): string => {
    if (!status) return '';
    if (status.source === 'env') {
      return t('Using NODE_EXTRA_CA_CERTS from the launch environment: {{path}}', {
        path: status.path,
      });
    }
    if (status.source === 'setting') return t('Set: {{path}}', { path: status.path });
    if (status.source === 'shell') {
      return t('Not set; using NODE_EXTRA_CA_CERTS from the login shell: {{path}}', {
        path: status.path,
      });
    }
    return t('Not set');
  };

  return (
    <div className="space-y-3" data-settings-row="general.caCert">
      <div>
        <h4 className="text-sm font-medium">{t('Custom CA certificate')}</h4>
        <p className="text-xs text-muted-foreground">
          {t(
            'Trust an extra CA (PEM file) for model endpoints signed by a private CA. TLS verification stays on.'
          )}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void pick()}>
          {t('Choose certificate file')}
        </Button>
        {customCaCertPath && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void apply('')}>
            {t('Clear')}
          </Button>
        )}
      </div>
      {status?.error ? (
        <p className="break-all text-xs text-destructive">
          {t('Certificate file unavailable ({{reason}}): {{path}}', {
            reason: errorText[status.error],
            path: status.settingPath,
          })}
        </p>
      ) : (
        <p className="break-all text-xs text-muted-foreground">{statusText()}</p>
      )}
      <p className="text-xs text-muted-foreground">
        {t(
          'Changes restart the agent process right away (running turns are interrupted). Requests made by the app main process take effect after restarting the app.'
        )}
      </p>
    </div>
  );
}

/** 更新小节:当前版本 + 检查按钮 + 状态/进度 + 自动下载开关 */
function UpdateSection() {
  const { t } = useI18n();
  const autoUpdate = useSettingsStore((s) => s.autoUpdate);
  const setAutoUpdate = useSettingsStore((s) => s.setAutoUpdate);
  const autoRestartWhenIdle = useSettingsStore((s) => s.autoRestartWhenIdle);
  const setAutoRestartWhenIdle = useSettingsStore((s) => s.setAutoRestartWhenIdle);
  const [status, setStatus] = React.useState<UpdateStatus | null>(null);
  const [host, setHost] = React.useState<UpdaterState | null>(null);
  const [confirmRestart, setConfirmRestart] = React.useState(false);
  const [notesOpen, setNotesOpen] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    // 远端连桌面宿主时 updater:* 被拒，保持原行为
    window.electronAPI.updater
      .getState()
      .then((state) => {
        if (!alive) return;
        setHost(state);
        if (state.status) setStatus((current) => current ?? state.status);
      })
      .catch(() => {});
    const off = window.electronAPI.updater.onStatus(setStatus);
    return () => {
      alive = false;
      off();
    };
  }, []);
  const server = host?.host === 'server' ? host : null;
  const canDownload = host?.host === 'desktop' || (server !== null && server.mode !== 'manual');
  const hasNotes =
    (status?.status === 'available' || status?.status === 'downloaded') && !!status.info;

  const statusText = (): string | null => {
    if (!status) return null;
    switch (status.status) {
      case 'checking':
        return t('Checking for updates…');
      case 'available':
        return t('New version {{version}} found', { version: status.info?.version ?? '' });
      case 'not-available':
        return t('You are on the latest version');
      case 'downloading':
        return t('Downloading update… {{percent}}%', {
          percent: Math.round(status.progress?.percent ?? 0),
        });
      case 'downloaded':
        return t('New version {{version}} is ready — restart to update.', {
          version: status.info?.version ?? '',
        });
      case 'error':
        return server && status.error
          ? t('Update failed: {{error}}', { error: status.error })
          : t('Update check failed');
      default:
        return null;
    }
  };
  const text = statusText();
  const busy = status?.status === 'checking' || status?.status === 'downloading';

  return (
    <div className="space-y-3" data-settings-row="general.updates">
      <div>
        <h4 className="text-sm font-medium">{t('Updates')}</h4>
        <p className="text-xs text-muted-foreground">
          {server ? serverModeText(server.mode, t) : t('Application update settings')}
        </p>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-sm">
            {t('Current version')} · {APP_VERSION}
          </p>
          {text && <p className="mt-0.5 truncate text-xs text-muted-foreground">{text}</p>}
        </div>
        {hasNotes && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setNotesOpen(true)}
            className="ml-auto shrink-0"
          >
            {t('Release notes')}
          </Button>
        )}
        {status?.status === 'downloaded' ? (
          <Button
            size="sm"
            onClick={() => void window.electronAPI.updater.quitAndInstall()}
            className="shrink-0"
          >
            {t('Restart to update')}
          </Button>
        ) : canDownload && status?.status === 'available' ? (
          <Button
            size="sm"
            onClick={() => void window.electronAPI.updater.downloadUpdate()}
            className="shrink-0"
          >
            {t('Download update')}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void window.electronAPI.updater.checkForUpdates()}
            className="shrink-0"
          >
            {t('Check for updates')}
          </Button>
        )}
        <ReleaseNotesDialog
          open={notesOpen}
          onOpenChange={setNotesOpen}
          status={status}
          canDownload={canDownload}
        />
      </div>
      {server?.canRestart && (
        <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm">{t('Restart server')}</p>
            <p className="text-xs text-muted-foreground">
              {t('Running tasks are interrupted; this page reconnects after the server is back.')}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmRestart(true)}
            className="shrink-0"
          >
            {t('Restart')}
          </Button>
          <ConfirmDialog
            open={confirmRestart}
            onOpenChange={setConfirmRestart}
            title={t('Restart server?')}
            description={t(
              'Running tasks are interrupted; this page reconnects after the server is back.'
            )}
            confirmLabel={t('Restart')}
            onConfirm={() => {
              setConfirmRestart(false);
              void window.electronAPI.updater.restart();
            }}
          />
        </div>
      )}
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-sm">{t('Automatic updates')}</p>
          <p className="text-xs text-muted-foreground">
            {t('Download and install updates automatically')}
          </p>
        </div>
        <Switch
          checked={autoUpdate}
          onCheckedChange={(checked) => {
            setAutoUpdate(checked);
            void window.electronAPI.updater.setAutoUpdateEnabled(checked);
          }}
        />
      </div>
      <div
        className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 ${autoUpdate ? '' : 'opacity-60'}`}
      >
        <div className="min-w-0">
          <p className="text-sm">{t('Restart and apply when idle')}</p>
          <p className="text-xs text-muted-foreground">
            {t(
              'After the update is downloaded, restart automatically if no agent is running, nothing is queued, and there are no pending questions or approvals. The idle state must last 5 minutes, and a focused window also blocks it.'
            )}
          </p>
        </div>
        <Switch
          checked={autoUpdate && autoRestartWhenIdle}
          disabled={!autoUpdate}
          onCheckedChange={(checked) => {
            setAutoRestartWhenIdle(checked);
            void window.electronAPI.updater.setAutoRestartWhenIdle(checked);
          }}
        />
      </div>
    </div>
  );
}

function serverModeText(
  mode: ServerUpdateMode | undefined,
  t: ReturnType<typeof useI18n>['t']
): string {
  if (mode === 'npm') return t('Server updates install the new version with npm and restart.');
  return t('This server must be updated on the machine itself.');
}

/** 打包时由 vite 注入的 app 版本(见 electron.vite.config.ts define);dev 下取 package.json */
const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? 'dev';
