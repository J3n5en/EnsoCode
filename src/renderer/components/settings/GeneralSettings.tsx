import { isValidProxyUrl, type ProxyMode } from '@shared/proxy';
import { type TerminalShell, terminalShellsForPlatform } from '@shared/terminalShell';
import type { UpdateStatus } from '@shared/types/updater';
import type { WindowsLocalShell } from '@shared/windowsLocalShell';
import { isAbsolutePathLike } from '@shared/worktreeRoot';
import * as React from 'react';
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
import { GENERATION_STALL_TIMEOUT_MINUTES } from '@/stores/sessions/stallTimeout';
import { useSettingsStore } from '@/stores/settings';
import {
  AUTO_ARCHIVE_IDLE_DAYS,
  AUTO_DELETE_ARCHIVED_DAYS,
} from '@/stores/settings/autoArchiveIdleDays';
import { ConfigSyncSettings } from './ConfigSyncSettings';
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
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">{t('General')}</h3>
        <p className="text-sm text-muted-foreground">{t('General application settings')}</p>
      </div>

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
      <AutoArchiveSection />
      <SidePanelSection />
      <SmartCompactPicker />
      <WindowsLocalShellSection />
      <TerminalShellSection />
      <WorktreeRootSection />
      <ProxySection />
      <ConfigSyncSettings />
      <UpdateSection />
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

function SidePanelSection() {
  const { t } = useI18n();
  const openChangesOnFileEdit = useSettingsStore((s) => s.openChangesOnFileEdit);
  const setOpenChangesOnFileEdit = useSettingsStore((s) => s.setOpenChangesOnFileEdit);
  const compactReadOnlyTools = useSettingsStore((s) => s.compactReadOnlyTools);
  const setCompactReadOnlyTools = useSettingsStore((s) => s.setCompactReadOnlyTools);
  const expandLiveEdits = useSettingsStore((s) => s.expandLiveEdits);
  const setExpandLiveEdits = useSettingsStore((s) => s.setExpandLiveEdits);
  const expandLiveReasoning = useSettingsStore((s) => s.expandLiveReasoning);
  const setExpandLiveReasoning = useSettingsStore((s) => s.setExpandLiveReasoning);
  const autoCollapseTurns = useSettingsStore((s) => s.autoCollapseTurns);
  const setAutoCollapseTurns = useSettingsStore((s) => s.setAutoCollapseTurns);
  const collapseCompletedActivity = useSettingsStore((s) => s.collapseCompletedActivity);
  const setCollapseCompletedActivity = useSettingsStore((s) => s.setCollapseCompletedActivity);
  const pinUnfinishedTodos = useSettingsStore((s) => s.pinUnfinishedTodos);
  const setPinUnfinishedTodos = useSettingsStore((s) => s.setPinUnfinishedTodos);
  const generationStallTimeoutMin = useSettingsStore((s) => s.generationStallTimeoutMin);
  const setGenerationStallTimeoutMin = useSettingsStore((s) => s.setGenerationStallTimeoutMin);
  return (
    <div className="space-y-2">
      <SwitchRow
        rowId="general.openChangesOnFileEdit"
        title={t('Open Changes when files are edited')}
        description={t(
          'Automatically show the side panel Changes tab after the agent edits a file'
        )}
        checked={openChangesOnFileEdit}
        onChange={setOpenChangesOnFileEdit}
      />
      <SwitchRow
        rowId="general.compactReadOnlyTools"
        title={t('Compact read-only tool calls')}
        description={t(
          'Show read/grep/find/ls as one-line rows and fold consecutive tool calls while the agent is still running'
        )}
        checked={compactReadOnlyTools}
        onChange={setCompactReadOnlyTools}
      />
      <SwitchRow
        rowId="general.expandLiveEdits"
        title={t('Expand file edits while running')}
        description={t(
          'Automatically unfold diffs or written content from file modification tools while the agent is still running'
        )}
        checked={expandLiveEdits}
        onChange={setExpandLiveEdits}
      />
      <SwitchRow
        rowId="general.expandLiveReasoning"
        title={t('Expand reasoning while streaming')}
        description={t(
          'Automatically unfold the thinking block while the model is still reasoning. It collapses again when reasoning ends.'
        )}
        checked={expandLiveReasoning}
        onChange={setExpandLiveReasoning}
      />
      <SwitchRow
        rowId="general.autoCollapseTurns"
        title={t('Auto-collapse previous turns')}
        description={t(
          'After you send a new message, fold earlier turns down to the question, timestamp and duration; the latest turn stays expanded'
        )}
        checked={autoCollapseTurns}
        onChange={setAutoCollapseTurns}
      />
      <SwitchRow
        rowId="general.collapseCompletedActivity"
        title={t('Collapse activity after reply')}
        description={t(
          'When a reply finishes, fold consecutive thinking and tool calls (including edits and commands) into one summary row; failed calls stay visible'
        )}
        checked={collapseCompletedActivity}
        onChange={setCollapseCompletedActivity}
      />
      <SwitchRow
        rowId="general.pinUnfinishedTodos"
        title={t('Pin unfinished todos')}
        description={t(
          'Keep the latest todo list above the input while it has unfinished items, so it does not scroll away with the timeline'
        )}
        checked={pinUnfinishedTodos}
        onChange={setPinUnfinishedTodos}
      />
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
        <p className="text-sm">{t('Windows local command shell')}</p>
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
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  rowId?: string;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
      data-settings-row={rowId}
    >
      <div className="min-w-0">
        <p className="text-sm">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={(value) => onChange(value === true)} />
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

/** 更新小节:当前版本 + 检查按钮 + 状态/进度 + 自动下载开关 */
function UpdateSection() {
  const { t } = useI18n();
  const autoUpdate = useSettingsStore((s) => s.autoUpdate);
  const setAutoUpdate = useSettingsStore((s) => s.setAutoUpdate);
  const autoRestartWhenIdle = useSettingsStore((s) => s.autoRestartWhenIdle);
  const setAutoRestartWhenIdle = useSettingsStore((s) => s.setAutoRestartWhenIdle);
  const [status, setStatus] = React.useState<UpdateStatus | null>(null);

  React.useEffect(() => {
    return window.electronAPI.updater.onStatus(setStatus);
  }, []);

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
        return t('Update check failed');
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
        <p className="text-xs text-muted-foreground">{t('Application update settings')}</p>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-sm">
            {t('Current version')} · {APP_VERSION}
          </p>
          {text && <p className="mt-0.5 truncate text-xs text-muted-foreground">{text}</p>}
        </div>
        {status?.status === 'downloaded' ? (
          <Button
            size="sm"
            onClick={() => void window.electronAPI.updater.quitAndInstall()}
            className="shrink-0"
          >
            {t('Restart to update')}
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
      </div>
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

/** 打包时由 vite 注入的 app 版本(见 electron.vite.config.ts define);dev 下取 package.json */
const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? 'dev';
