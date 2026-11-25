import { CA_CERT_EXTENSIONS, type CaCertError, type CaCertStatus } from '@shared/caCert';
import { isValidProxyUrl, type ProxyMode } from '@shared/proxy';
import type { ShellIntegration } from '@shared/shellIntegration';
import type { ServerUpdateMode, UpdaterState, UpdateStatus } from '@shared/types/updater';
import {
  isPrereleaseVersion,
  manualInstallSpec,
  type UpdateChannel,
} from '@shared/updater/channel';
import { isAutoRestartMode } from '@shared/updater/idleRestart';
import { AnimatePresence, MotionGlobalConfig, motion, useReducedMotion } from 'framer-motion';
import * as React from 'react';
import { ManualInstallActions } from '@/components/app/ManualInstallActions';
import { ReleaseNotesDialog } from '@/components/app/ReleaseNotesDialog';
import { restartToUpdate } from '@/components/app/restartToUpdate';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { heightVariants } from '@/lib/motion';
import { isRemoteClient } from '@/lib/remoteClient';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { ConfigSyncSettings } from './ConfigSyncSettings';
import { FileOpeningSettings } from './FileOpeningSettings';
import {
  SettingsButton,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSubRow,
  SettingsSwitch,
  useSettingsRow,
  useSettingsRowControl,
} from './kit';

function RowTextInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  const a11y = useSettingsRowControl();
  return <Input size="sm" {...a11y} {...props} className={cn('w-[220px] max-w-full', className)} />;
}

export function GeneralSettings() {
  // 只订阅用到的两个键：整店订阅会让这个最重页面的子树在每次设置写入时
  // 全量重渲，是 pin 快照测试渲染广度的主要来源
  const language = useSettingsStore((state) => state.language);
  const setLanguage = useSettingsStore((state) => state.setLanguage);
  const { t } = useI18n();

  return (
    <SettingsPage
      rowId="general.root"
      title={t('General')}
      description={t('General application settings')}
    >
      <SettingsSection rowId="general.application" title={t('Application')}>
        <SettingsRow rowId="general.language" label={t('Language')}>
          <SettingsSelect
            value={language}
            onValueChange={setLanguage}
            options={[
              { value: 'en', label: 'English' },
              { value: 'zh', label: '简体中文' },
            ]}
          />
        </SettingsRow>
        <NotificationSection />
      </SettingsSection>

      <SettingsSection rowId="general.network" title={t('Network')}>
        <ProxySection />
        <CaCertSection />
      </SettingsSection>

      <ConfigSyncSettings />
      <FileOpeningSettings />
      <UpdateSection />

      {window.electronAPI.env.platform === 'darwin' && !isRemoteClient() && (
        <SettingsSection rowId="general.integrations" title={t('Integrations')}>
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
        </SettingsSection>
      )}
    </SettingsPage>
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
      // shell integration 是宿主桌面能力，远程查不到
      if (isRemoteClient()) return;
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
    <SettingsRow rowId={`general.${kind}`} label={title} description={description}>
      <SettingsButton disabled={busy} onClick={() => void toggle()}>
        {busy ? t('In progress…') : t(installed ? 'Uninstall' : 'Install')}
      </SettingsButton>
    </SettingsRow>
  );
}

function NotificationSection() {
  const { t } = useI18n();
  const notifyMainAgentOnly = useSettingsStore((s) => s.notifyMainAgentOnly);
  const setNotifyMainAgentOnly = useSettingsStore((s) => s.setNotifyMainAgentOnly);
  return (
    <SettingsRow
      rowId="general.notifyMainAgentOnly"
      label={t('Notify only for the main agent')}
      description={t(
        'Skip coworker completion and failure notifications on this computer and the paired phone. Questions and approvals still notify.'
      )}
    >
      <SettingsSwitch checked={notifyMainAgentOnly} onCheckedChange={setNotifyMainAgentOnly} />
    </SettingsRow>
  );
}

function applyProxy(mode: ProxyMode, customUrl: string): void {
  void window.electronAPI.proxy.apply({ mode, customUrl });
}

function ProxyUrlField({
  value,
  error,
  onChange,
  onCommit,
}: {
  value: string;
  error: string | null;
  onChange: (value: string) => void;
  onCommit: () => boolean;
}) {
  const row = useSettingsRow();
  const commit = () => {
    if (onCommit()) row?.markSaved();
  };
  return (
    <div className="flex w-full max-w-[220px] flex-col items-end gap-1">
      <RowTextInput
        value={value}
        placeholder="http://127.0.0.1:7890"
        onChange={(event) => onChange(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
      />
      {error && <p className="text-right text-[12px] text-destructive">{error}</p>}
    </div>
  );
}

function ProxySection() {
  const { t } = useI18n();
  const proxyMode = useSettingsStore((s) => s.proxyMode);
  const customProxyUrl = useSettingsStore((s) => s.customProxyUrl);
  const setProxyMode = useSettingsStore((s) => s.setProxyMode);
  const setCustomProxyUrl = useSettingsStore((s) => s.setCustomProxyUrl);
  const [draft, setDraft] = React.useState(customProxyUrl);
  const [error, setError] = React.useState<string | null>(null);
  const reducedMotion = useReducedMotion();
  const reduced = reducedMotion === true || MotionGlobalConfig.skipAnimations === true;

  React.useEffect(() => {
    setDraft(customProxyUrl);
  }, [customProxyUrl]);

  const changeMode = (mode: ProxyMode) => {
    setProxyMode(mode);
    applyProxy(mode, customProxyUrl);
  };

  const commitUrl = (): boolean => {
    const next = draft.trim();
    if (next && !isValidProxyUrl(next)) {
      setError(t('Enter an http(s) proxy URL'));
      return false;
    }
    setError(null);
    const changed = next !== customProxyUrl;
    setCustomProxyUrl(next);
    applyProxy(proxyMode, next);
    return changed;
  };

  const urlRow = (
    <SettingsSubRow rowId="general.proxy-url" label={t('Proxy URL')}>
      <ProxyUrlField
        value={draft}
        error={error}
        onChange={(next) => {
          setDraft(next);
          if (error) setError(null);
        }}
        onCommit={commitUrl}
      />
    </SettingsSubRow>
  );

  return (
    <div data-settings-row="general.proxy">
      <SettingsRow
        rowId="general.proxy"
        label={t('Network proxy')}
        description={t('Used by model requests, the built-in browser, and agent tools')}
      >
        <SettingsSelect
          value={proxyMode}
          onValueChange={changeMode}
          options={[
            { value: 'system', label: t('Follow system proxy') },
            { value: 'none', label: t('No proxy') },
            { value: 'custom', label: t('Custom proxy') },
          ]}
        />
      </SettingsRow>
      {reduced ? (
        proxyMode === 'custom' ? (
          urlRow
        ) : null
      ) : (
        <AnimatePresence initial={false}>
          {proxyMode === 'custom' && (
            <motion.div
              initial="initial"
              animate="animate"
              exit="exit"
              variants={heightVariants}
              className="overflow-hidden"
            >
              {urlRow}
            </motion.div>
          )}
        </AnimatePresence>
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

  const statusBadge = status?.error ? (
    <Badge variant="error" className="shrink-0 text-[11px]">
      {t('Error')}
    </Badge>
  ) : status?.source === 'setting' ? (
    <Badge variant="success" className="shrink-0 text-[11px]">
      {t('Active')}
    </Badge>
  ) : status?.source === 'env' || status?.source === 'shell' ? (
    <Badge variant="info" className="shrink-0 text-[11px]">
      {t('From environment')}
    </Badge>
  ) : undefined;

  return (
    <SettingsRow
      rowId="general.caCert"
      label={t('Custom CA certificate')}
      status={statusBadge}
      description={
        <>
          {t(
            'Trust an extra CA (PEM file) for model endpoints signed by a private CA. TLS verification stays on.'
          )}
          {status?.error ? (
            <span className="mt-1 block break-all text-destructive">
              {t('Certificate file unavailable ({{reason}}): {{path}}', {
                reason: errorText[status.error],
                path: status.settingPath,
              })}
            </span>
          ) : (
            statusText() && <span className="mt-1 block break-all">{statusText()}</span>
          )}
          <span className="mt-1 block">
            {t(
              'Changes restart the agent process right away (running turns are interrupted). Requests made by the app main process take effect after restarting the app.'
            )}
          </span>
        </>
      }
    >
      <SettingsButton disabled={busy} onClick={() => void pick()}>
        {t('Choose certificate file')}
      </SettingsButton>
      {customCaCertPath && (
        <SettingsButton variant="ghost" disabled={busy} onClick={() => void apply('')}>
          {t('Clear')}
        </SettingsButton>
      )}
    </SettingsRow>
  );
}

function serverModeText(
  mode: ServerUpdateMode | undefined,
  channel: UpdateChannel,
  t: ReturnType<typeof useI18n>['t']
): React.ReactNode {
  if (mode === 'npm')
    return t(
      'Server updates install the new version with npm and restart gracefully: running tasks finish first (up to a limit), then the server restarts and tasks resume.'
    );
  return (
    <>
      {t('This server must be updated on the machine itself.')}
      {/* 命令与渠道联动（内测装 @beta dist-tag），命令本身不翻译，所以拆出来直接渲染 */}
      <code data-server-manual-command className="mt-0.5 block">
        npm i -g {manualInstallSpec(channel)}
      </code>
    </>
  );
}

/** 打包时由 vite 注入的 app 版本(见 electron.vite.config.ts define);dev 下取 package.json */
const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? 'dev';

/** 更新小节:当前版本 + 检查按钮 + 状态/进度 + 自动下载开关 */
function UpdateSection() {
  const { t } = useI18n();
  const autoUpdate = useSettingsStore((s) => s.autoUpdate);
  const setAutoUpdate = useSettingsStore((s) => s.setAutoUpdate);
  const autoRestartForUpdate = useSettingsStore((s) => s.autoRestartForUpdate);
  const setAutoRestartForUpdate = useSettingsStore((s) => s.setAutoRestartForUpdate);
  const updateChannel: UpdateChannel = useSettingsStore((s) =>
    s.updateChannel === 'beta' ? 'beta' : 'stable'
  );
  const setUpdateChannel = useSettingsStore((s) => s.setUpdateChannel);
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
  const applying = status?.status === 'applying';

  const statusText = (): string | null => {
    if (!status) return null;
    switch (status.status) {
      case 'checking':
        return t('Checking for updates…');
      case 'available':
        return status.manualInstall
          ? t("New version {{version}} found. This local build can't install it automatically.", {
              version: status.info?.version ?? '',
            })
          : t('New version {{version}} found', { version: status.info?.version ?? '' });
      case 'not-available':
        return t('You are on the latest version');
      case 'downloading':
        return t('Downloading update… {{percent}}%', {
          percent: Math.round(status.progress?.percent ?? 0),
        });
      case 'downloaded':
        return server?.restartMethod === 'manual'
          ? t(
              'New version {{version}} is downloaded. Applying it installs and then stops the server — you will need to restart it externally (container or process manager).',
              { version: status.info?.version ?? '' }
            )
          : t(
              'New version {{version}} is downloaded. Restarting waits for the current tool to finish; background commands keep running.',
              {
                version: status.info?.version ?? '',
              }
            );
      case 'applying': {
        const stage = status.applying?.stage;
        if (stage === 'waiting-tasks')
          return t('Waiting for {{count}} running tasks to finish before installing…', {
            count: status.applying?.busyCount ?? 0,
          });
        if (stage === 'installing')
          return t('Installing {{version}}…', { version: status.info?.version ?? '' });
        return t('Restarting server…');
      }
      case 'error':
        if (status.manualInstall) {
          return t(
            "This local build is signed differently from the release and can't install updates automatically. Download it manually."
          );
        }
        return server && status.error
          ? t('Update failed: {{error}}', { error: status.error })
          : t('Update check failed');
      default:
        return null;
    }
  };
  const text = statusText();
  const busy = status?.status === 'checking' || status?.status === 'downloading';

  const autoRestartRow = (
    <SettingsSubRow
      rowId="general.restart-automatically-to-apply-updates"
      label={t('Restart automatically to apply updates')}
      description={
        autoRestartForUpdate === 'immediate'
          ? t(
              "Restart as soon as the update is downloaded, even while agents are running or messages are queued. The restart happens after the current tool finishes, and running sessions keep going afterwards. It still waits while you're using the window (input in the last 2 minutes), while an input box has an unsent draft, or while a question or approval is pending."
            )
          : autoRestartForUpdate === 'idle'
            ? t(
                'After the update is downloaded, restart automatically if no agent is running, nothing is queued, and there are no pending questions or approvals. The idle state must last 5 minutes, and a focused window also blocks it.'
              )
            : t('Only notify when an update is ready; never restart automatically.')
      }
    >
      <SettingsSelect
        value={autoRestartForUpdate}
        disabled={!autoUpdate}
        onValueChange={(value) => {
          if (!isAutoRestartMode(value)) return;
          setAutoRestartForUpdate(value);
          void window.electronAPI.updater.setAutoRestartMode(value);
        }}
        options={[
          { value: 'off', label: t('Off') },
          { value: 'idle', label: t('When idle') },
          { value: 'immediate', label: t("Don't wait for idle") },
        ]}
      />
    </SettingsSubRow>
  );

  return (
    <SettingsSection
      rowId="general.updates"
      title={t('Updates')}
      description={
        server ? serverModeText(server.mode, updateChannel, t) : t('Application update settings')
      }
    >
      <SettingsRow
        rowId="general.current-version"
        label={
          <>
            {t('Current version')} · {APP_VERSION}
          </>
        }
        description={
          text ? (
            <span className={cn('block', !status?.manualInstall && 'truncate')}>{text}</span>
          ) : undefined
        }
      >
        {hasNotes && (
          <SettingsButton variant="ghost" onClick={() => setNotesOpen(true)}>
            {t('Release notes')}
          </SettingsButton>
        )}
        {status?.manualInstall ? (
          <ManualInstallActions manualInstall={status.manualInstall} />
        ) : applying ? (
          <SettingsButton variant="default" disabled>
            {t('Updating…')}
          </SettingsButton>
        ) : status?.status === 'downloaded' ? (
          <SettingsButton variant="default" onClick={() => void restartToUpdate(t)}>
            {t('Restart to update')}
          </SettingsButton>
        ) : canDownload && status?.status === 'available' ? (
          <SettingsButton
            variant="default"
            onClick={() => void window.electronAPI.updater.downloadUpdate()}
          >
            {t('Download update')}
          </SettingsButton>
        ) : (
          <SettingsButton
            disabled={busy}
            onClick={() => void window.electronAPI.updater.checkForUpdates()}
          >
            {t('Check for updates')}
          </SettingsButton>
        )}
        <ReleaseNotesDialog
          open={notesOpen}
          onOpenChange={setNotesOpen}
          status={status}
          canDownload={canDownload}
        />
      </SettingsRow>
      {server?.canRestart && (
        <SettingsRow
          rowId="general.restart-server"
          label={t('Restart server')}
          description={t(
            'Waits for running tasks to finish before restarting; this page reconnects after the server is back. Force restart does not wait.'
          )}
        >
          <SettingsButton
            variant="ghost"
            onClick={() => void window.electronAPI.updater.restart(true)}
          >
            {t('Restart now')}
          </SettingsButton>
          <SettingsButton onClick={() => setConfirmRestart(true)}>{t('Restart')}</SettingsButton>
          <ConfirmDialog
            open={confirmRestart}
            onOpenChange={setConfirmRestart}
            title={t('Restart server?')}
            description={t(
              'Running tasks finish first, then the server restarts; this page reconnects when it is back.'
            )}
            confirmLabel={t('Restart')}
            onConfirm={() => {
              setConfirmRestart(false);
              void window.electronAPI.updater.restart();
            }}
          />
        </SettingsRow>
      )}
      <SettingsRow
        rowId="general.automatic-updates"
        label={t('Automatic updates')}
        description={
          server?.mode === 'manual'
            ? t('Not available for this install: it cannot update itself. Update manually instead.')
            : server
              ? t(
                  'Download and install updates automatically: running tasks finish first, then the server restarts and they resume.'
                )
              : t('Download and install updates automatically')
        }
      >
        <SettingsSwitch
          checked={server?.mode === 'manual' ? false : autoUpdate}
          disabled={server?.mode === 'manual'}
          onCheckedChange={(checked) => {
            setAutoUpdate(checked);
            void window.electronAPI.updater.setAutoUpdateEnabled(checked);
          }}
        />
      </SettingsRow>
      {!server && <div className={autoUpdate ? undefined : 'opacity-60'}>{autoRestartRow}</div>}
      {(host?.host === 'desktop' || host?.host === 'server') && (
        <SettingsRow
          rowId="general.updateChannel"
          label={t('Update channel')}
          description={
            <>
              {updateChannel === 'beta'
                ? t(
                    'Beta builds come from the latest main branch and may be unstable. You get whichever of beta and stable is newer.'
                  )
                : t('Only stable releases.')}
              {updateChannel === 'stable' && isPrereleaseVersion(APP_VERSION) && (
                <span className="mt-0.5 block">
                  {t(
                    "You're on a beta build. Switching to stable doesn't downgrade; you'll move to the next stable release once it's out."
                  )}
                </span>
              )}
            </>
          }
        >
          <SettingsSelect
            value={updateChannel}
            onValueChange={(value) => {
              const channel: UpdateChannel = value === 'beta' ? 'beta' : 'stable';
              setUpdateChannel(channel);
              void window.electronAPI.updater.setChannel(channel);
            }}
            options={[
              { value: 'stable', label: t('Stable') },
              { value: 'beta', label: t('Beta') },
            ]}
          />
        </SettingsRow>
      )}
    </SettingsSection>
  );
}
