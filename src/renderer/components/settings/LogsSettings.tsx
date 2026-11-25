import {
  type AppLogEntry,
  type AppLogSource,
  DEFAULT_LOG_EXPORT_HOURS,
  LOG_EXPORT_HOURS,
  type LogSummaryLevel,
} from '@shared/appLog';
import { ChevronRight, Download, RefreshCw } from 'lucide-react';
import * as React from 'react';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { DevToolsSection } from './DevToolsSection';
import {
  SettingsButton,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsSelect,
  SettingsSwitch,
} from './kit';

const SOURCE_LABELS: Record<AppLogSource, string> = {
  main: 'Main process',
  agent: 'Agent worker',
  plugin: 'Plugin',
  mcp: 'MCP',
};
const SOURCE_STYLES: Record<AppLogSource, string> = {
  main: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  agent: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  plugin: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  mcp: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
};
type ExportHours = (typeof LOG_EXPORT_HOURS)[number];
const HOUR_LABELS: Record<ExportHours, string> = {
  1: 'Last hour',
  6: 'Last 6 hours',
  24: 'Last 24 hours',
  72: 'Last 3 days',
  168: 'Last 7 days',
};

export function LogsSettings() {
  const { t } = useI18n();
  return (
    <SettingsPage
      rowId="logs.root"
      title={t('Logs')}
      description={t('Recent errors and log export. API keys, tokens and passwords are masked.')}
    >
      <LoggingSwitches />
      <ErrorSummary />
      <LogExport />
      <SettingsSection rowId="logs.troubleshooting" title={t('Troubleshooting')}>
        <DevToolsSection />
      </SettingsSection>
    </SettingsPage>
  );
}

function LoggingSwitches() {
  const { t } = useI18n();
  const appLogging = useSettingsStore((state) => state.appLoggingEnabled === true);
  const setAppLogging = useSettingsStore((state) => state.setAppLoggingEnabled);
  const pluginLogging = useSettingsStore((state) => state.pluginLoggingEnabled === true);
  const setPluginLogging = useSettingsStore((state) => state.setPluginLoggingEnabled);
  return (
    <SettingsSection>
      <SettingsRow
        rowId="logs.record-app-logs"
        label={t('Record app logs')}
        description={t(
          'Off by default. Write main process and agent logs to disk. Files needed for restart recovery are always kept.'
        )}
      >
        <SettingsSwitch checked={appLogging} onCheckedChange={setAppLogging} />
      </SettingsRow>
      <SettingsRow
        rowId="logs.record-plugin-logs"
        label={t('Record plugin logs')}
        description={t(
          'Off by default. Record plugin console output and runtime logs to disk. Startup failures and crashes are still shown.'
        )}
      >
        <SettingsSwitch checked={pluginLogging} onCheckedChange={setPluginLogging} />
      </SettingsRow>
    </SettingsSection>
  );
}

function ErrorSummary() {
  const { t } = useI18n();
  const appLogging = useSettingsStore((state) => state.appLoggingEnabled === true);
  const setAppLogging = useSettingsStore((state) => state.setAppLoggingEnabled);
  const [level, setLevel] = React.useState<LogSummaryLevel>('error');
  const [rows, setRows] = React.useState<{ key: string; entry: AppLogEntry }[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const requestIdRef = React.useRef(0);

  const load = React.useCallback(async (min: LogSummaryLevel) => {
    const id = ++requestIdRef.current;
    setLoading(true);
    try {
      const entries = await window.electronAPI.logs.errors(min);
      if (requestIdRef.current !== id) return;
      // 每次刷新整体替换列表，序号即稳定标识
      setRows(entries.map((entry, i) => ({ key: `${i}:${entry.time}`, entry })));
      setExpanded(null);
    } catch {
      if (requestIdRef.current !== id) return;
      setRows([]);
    } finally {
      if (requestIdRef.current === id) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load(level);
  }, [level, load]);

  return (
    <SettingsSection
      rowId="logs.recent-errors"
      title={t('Recent errors')}
      actions={
        <>
          <SettingsSegmented
            aria-label={t('Recent errors')}
            value={level}
            onValueChange={setLevel}
            options={[
              { value: 'error', label: t('Errors only') },
              { value: 'warn', label: t('Warnings and errors') },
            ]}
          />
          <SettingsButton
            aria-label={t('Refresh')}
            disabled={loading}
            onClick={() => void load(level)}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </SettingsButton>
        </>
      }
    >
      {!appLogging && (
        <SettingsRow
          rowId="logs.app-logging-is-off"
          label={t('App logging is off')}
          description={t('New app logs are not recorded while off. Existing logs are kept below.')}
        >
          <SettingsButton onClick={() => setAppLogging(true)}>
            {t('Enable app logging')}
          </SettingsButton>
        </SettingsRow>
      )}
      {rows && rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-muted-foreground max-sm:px-3">
          {t('No errors recorded.')}
        </p>
      ) : (
        // biome-ignore lint/complexity/noUselessFragments: 包一层会让行间发丝线失效，行必须是 settings-group 的直接子节点
        <>
          {(rows ?? []).map(({ key, entry }) => {
            const open = expanded === key;
            return (
              <div key={key} className="px-4 py-1 max-sm:px-3">
                <button
                  type="button"
                  className="-mx-2 flex min-h-[44px] w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] hover:bg-accent/50"
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? null : key)}
                >
                  <ChevronRight
                    className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')}
                  />
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                    {new Date(entry.time).toLocaleString()}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-xs',
                      SOURCE_STYLES[entry.source]
                    )}
                  >
                    {t(SOURCE_LABELS[entry.source])}
                  </span>
                  {entry.level === 'warn' && (
                    <span className="shrink-0 text-xs text-amber-600 dark:text-amber-400">
                      {t('Warning')}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{entry.message}</span>
                </button>
                {open && (
                  <pre className="mb-3 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 px-3 py-2 font-mono text-xs">
                    {entry.detail}
                  </pre>
                )}
              </div>
            );
          })}
        </>
      )}
    </SettingsSection>
  );
}

function LogExport() {
  const { t } = useI18n();
  const appLogging = useSettingsStore((state) => state.appLoggingEnabled === true);
  const [hours, setHours] = React.useState<ExportHours>(DEFAULT_LOG_EXPORT_HOURS);
  const [busy, setBusy] = React.useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const result = await window.electronAPI.logs.export(hours);
      if (!result.ok) {
        addToast({ type: 'error', title: t('Log export failed'), description: result.error });
      } else if (!result.cancelled) {
        addToast({
          type: 'success',
          title: t('Logs exported'),
          description: result.path,
          actions: [
            {
              label: t('Show in folder'),
              onClick: () => void window.electronAPI.logs.revealExport(),
            },
          ],
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      rowId="logs.export-logs"
      title={t('Export logs')}
      description={t('Pack logs from the selected period into a zip file for troubleshooting.')}
    >
      <SettingsRow
        rowId="logs.time-range"
        label={t('Time range')}
        description={
          appLogging
            ? undefined
            : t('App logging is off. The export only includes logs recorded earlier.')
        }
      >
        <SettingsSelect
          value={String(hours)}
          onValueChange={(value) => {
            const next = LOG_EXPORT_HOURS.find((h) => String(h) === value);
            if (next) setHours(next);
          }}
          options={LOG_EXPORT_HOURS.map((h) => ({ value: String(h), label: t(HOUR_LABELS[h]) }))}
        />
        <SettingsButton variant="default" disabled={busy} onClick={() => void run()}>
          <Download className="h-3.5 w-3.5" />
          {busy ? t('Exporting...') : t('Export')}
        </SettingsButton>
      </SettingsRow>
    </SettingsSection>
  );
}
