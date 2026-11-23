import {
  type AppLogEntry,
  type AppLogSource,
  DEFAULT_LOG_EXPORT_HOURS,
  LOG_EXPORT_HOURS,
  type LogSummaryLevel,
} from '@shared/appLog';
import { ChevronRight, Download, RefreshCw } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

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
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">{t('Logs')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('Recent errors and log export. API keys, tokens and passwords are masked.')}
        </p>
      </div>
      <ErrorSummary />
      <LogExport />
    </div>
  );
}

function ErrorSummary() {
  const { t } = useI18n();
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
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{t('Recent errors')}</h4>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={level === 'error' ? 'secondary' : 'ghost'}
            onClick={() => setLevel('error')}
          >
            {t('Errors only')}
          </Button>
          <Button
            size="sm"
            variant={level === 'warn' ? 'secondary' : 'ghost'}
            onClick={() => setLevel('warn')}
          >
            {t('Warnings and errors')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label={t('Refresh')}
            disabled={loading}
            onClick={() => void load(level)}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>
      {rows && rows.length === 0 ? (
        <p className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
          {t('No errors recorded.')}
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {(rows ?? []).map(({ key, entry }) => {
            const open = expanded === key;
            return (
              <li key={key}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50"
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
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all bg-muted/40 px-3 py-2 font-mono text-xs">
                    {entry.detail}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function LogExport() {
  const { t } = useI18n();
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
    <section className="space-y-3">
      <div>
        <h4 className="text-sm font-medium">{t('Export logs')}</h4>
        <p className="text-sm text-muted-foreground">
          {t('Pack logs from the selected period into a zip file for troubleshooting.')}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Select
          items={Object.fromEntries(LOG_EXPORT_HOURS.map((h) => [String(h), t(HOUR_LABELS[h])]))}
          value={String(hours)}
          onValueChange={(value) => {
            const next = LOG_EXPORT_HOURS.find((h) => String(h) === value);
            if (next) setHours(next);
          }}
        >
          <SelectTrigger size="sm" className="w-40" aria-label={t('Time range')}>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {LOG_EXPORT_HOURS.map((h) => (
              <SelectItem key={h} value={String(h)}>
                {t(HOUR_LABELS[h])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button size="sm" disabled={busy} onClick={() => void run()}>
          <Download className="mr-1.5 h-3.5 w-3.5" />
          {busy ? t('Exporting...') : t('Export')}
        </Button>
      </div>
    </section>
  );
}
