import {
  type ResourceProcess,
  type ResourceProcessGroup,
  type ResourceProcessRole,
  type ResourceSnapshot,
  SESSION_CLEAN_DAYS,
  type SessionCleanRequest,
  type SessionStorageEntry,
  STORAGE_CLEANABILITY,
  type StorageCategory,
  type StorageCategoryId,
  type StorageCleanResult,
  type StorageRoot,
  type StorageScanProgress,
  type StorageSnapshot,
  sessionCleanIds,
} from '@shared/resources';
import { AlertTriangle, ChevronRight, Eraser, FolderOpen, RefreshCw, Trash2 } from 'lucide-react';
import * as React from 'react';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from '@/components/ui/menu';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { formatBytes } from './MemorySettings';

type Tab = 'cpu' | 'memory' | 'storage';
type Metric = 'cpu' | 'memory';

const POLL_MS = 2000;
const SESSION_LIST_LIMIT = 50;
const ALL_PROJECTS = '';
const GROUPS: { id: ResourceProcessGroup; label: string }[] = [
  { id: 'app', label: 'App processes' },
  { id: 'agent', label: 'Agent and tools' },
  { id: 'child', label: 'Other child processes' },
];
const CATEGORY_LABELS: Record<StorageCategoryId, [string, string]> = {
  sessions: ['Conversation history', 'Conversation transcripts and usage ledger.'],
  coworkers: [
    'Coworker transcripts',
    'Coworker journals; only those of deleted conversations are cleaned.',
  ],
  toolOutputs: [
    'Tool outputs',
    'Saved long tool outputs; only those of deleted conversations are cleaned.',
  ],
  secretaryImages: [
    'Secretary images',
    'Images sent to the secretary. Cleaning removes only images no message references any more and older than 7 days; referenced images are kept.',
  ],
  memory: ['Memory', 'Memory database and working memory.'],
  models: ['Local models', 'Downloaded embedding and chat models.'],
  runtimes: ['Runtimes', 'Bundled tools and GPU backends.'],
  worktrees: ['Worktrees', 'Isolated worktrees created for conversations.'],
  snapshots: ['Change snapshots', 'Baselines for the Changes panel.'],
  browser: ['Browser data', 'Cookies, storage and cache of the built-in browser.'],
  cache: ['Cache', 'Rebuildable caches; cleaning is safe.'],
  logs: ['Logs', 'Task and memory logs; files written in the last 24 hours are kept.'],
  backups: ['Backups', 'Configuration backup files; files from the last 24 hours are kept.'],
  config: ['Configuration', 'Settings, instructions, prompts and credentials.'],
  other: ['Other', 'Chromium profile data and other files.'],
};

function roleLabel(role: ResourceProcessRole, t: (key: string) => string): string {
  switch (role) {
    case 'main':
      return t('Main process');
    case 'window':
      return t('Window');
    case 'browser':
      return t('Built-in browser');
    case 'gpu':
      return 'GPU';
    case 'service':
      return t('Service');
    case 'agent':
      return 'Agent';
    case 'tool':
      return t('Tool');
    default:
      return t('Child process');
  }
}

function rootLabel(root: StorageRoot, t: (key: string) => string): string {
  return root.id === 'data' ? t('App data') : t('Worktree directory');
}

function processName(p: ResourceProcess, t: (key: string) => string): string {
  if (p.role !== 'window') return p.name;
  if (p.name === 'Main window') return t('Main window');
  if (p.name === 'Settings') return t('Settings');
  return p.name;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function ResourcesSettings() {
  const { t } = useI18n();
  const [tab, setTab] = React.useState<Tab>('cpu');

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-medium">{t('Resources')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('CPU, memory and disk usage of EnsoCode and the processes it started.')}
        </p>
      </div>
      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <TabsList>
          <TabsTab value="cpu">CPU</TabsTab>
          <TabsTab value="memory">{t('RAM')}</TabsTab>
          <TabsTab value="storage">{t('Storage')}</TabsTab>
        </TabsList>
        <TabsPanel value="cpu" className="pt-4">
          {tab === 'cpu' && <ProcessUsage metric="cpu" />}
        </TabsPanel>
        <TabsPanel value="memory" className="pt-4">
          {tab === 'memory' && <ProcessUsage metric="memory" />}
        </TabsPanel>
        <TabsPanel value="storage" className="pt-4">
          {tab === 'storage' && <StorageUsage />}
        </TabsPanel>
      </Tabs>
    </div>
  );
}

function ProcessUsage({ metric }: { metric: Metric }) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = React.useState<ResourceSnapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = await window.electronAPI.resources.sample();
        if (cancelled) return;
        setSnapshot(next);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  if (error && !snapshot) return <p className="text-sm text-destructive">{error}</p>;
  if (!snapshot) return <p className="text-sm text-muted-foreground">{t('Loading...')}</p>;

  const format = metric === 'cpu' ? formatPercent : formatBytes;
  const meter =
    metric === 'cpu'
      ? { app: snapshot.cpu.app, system: snapshot.cpu.system, total: 100 }
      : snapshot.memory;
  const value = (p: ResourceProcess) => (metric === 'cpu' ? p.cpu : p.memory);

  return (
    <div className="space-y-4">
      <UsageMeter
        app={meter.app}
        system={Math.max(meter.system, meter.app)}
        total={meter.total}
        format={format}
      />
      {GROUPS.map((group) => {
        const rows = snapshot.processes
          .filter((p) => p.group === group.id)
          .sort((a, b) => value(b) - value(a));
        if (rows.length === 0) return null;
        return (
          <div key={group.id} className="rounded-lg border">
            <div className="flex items-center justify-between border-b px-3 py-2 text-sm font-medium">
              <span>{t(group.label)}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {format(rows.reduce((sum, p) => sum + value(p), 0))}
              </span>
            </div>
            <div className="divide-y">
              {rows.map((p) => (
                <div key={p.pid} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                  <span className="w-20 shrink-0 truncate text-xs text-muted-foreground">
                    {roleLabel(p.role, t)}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={p.command ?? p.name}>
                    {processName(p, t)}
                  </span>
                  <span className="w-16 text-right font-mono text-xs text-muted-foreground">
                    {p.pid}
                  </span>
                  <span className="w-20 text-right font-mono text-xs">{format(value(p))}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function UsageMeter({
  app,
  system,
  total,
  format,
}: {
  app: number;
  system: number;
  total: number;
  format: (value: number) => string;
}) {
  const { t } = useI18n();
  const pct = (v: number) => `${total > 0 ? Math.min(100, (v / total) * 100) : 0}%`;
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <div className="text-xs text-muted-foreground">EnsoCode</div>
          <div className="font-mono text-2xl font-semibold">{format(app)}</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted-foreground">{t('System')}</div>
          <div className="font-mono text-sm">
            {format(system)} / {format(total)}
          </div>
        </div>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="absolute inset-y-0 left-0 bg-foreground/25"
          style={{ width: pct(system) }}
        />
        <div className="absolute inset-y-0 left-0 bg-foreground" style={{ width: pct(app) }} />
      </div>
    </div>
  );
}

function describeClean(
  result: StorageCleanResult,
  t: (key: string, params?: Record<string, string | number>) => string
): string {
  const parts = [t('Freed {{size}}', { size: formatBytes(result.freedBytes) })];
  if (result.removed > 0) parts.push(t('{{count}} files removed', { count: result.removed }));
  if (result.skipped > 0) parts.push(t('{{count}} kept', { count: result.skipped }));
  if (result.failed > 0) parts.push(t('{{count}} failed', { count: result.failed }));
  return parts.join(' · ');
}

function StorageUsage() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = React.useState<StorageSnapshot | null>(null);
  const [busy, setBusy] = React.useState<'scan' | 'sessions' | StorageCategoryId | null>('scan');
  const [progress, setProgress] = React.useState<StorageScanProgress | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<StorageCategoryId | null>(null);
  const [confirming, setConfirming] = React.useState<StorageCategoryId | null>(null);

  const run = React.useCallback(
    async (
      kind: 'scan' | 'sessions' | StorageCategoryId,
      action: () => Promise<StorageSnapshot>
    ) => {
      setBusy(kind);
      setError(null);
      setProgress(null);
      try {
        setSnapshot(await action());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('Scan cancelled')) setError(message);
      } finally {
        setBusy(null);
        setProgress(null);
      }
    },
    []
  );
  const scan = React.useCallback(
    () => run('scan', () => window.electronAPI.resources.scanStorage()),
    [run]
  );
  const clean = (id: StorageCategoryId) =>
    run(id, async () => {
      const result = await window.electronAPI.resources.cleanStorage(id);
      addToast({
        type: result.failed > 0 ? 'warning' : 'success',
        title: t('{{name}} cleaned', { name: t(CATEGORY_LABELS[id][0]) }),
        description: describeClean(result, t),
      });
      return result.snapshot;
    });

  React.useEffect(() => {
    const off = window.electronAPI.resources.onScanProgress(setProgress);
    // 先显示上次结果，再后台重扫；离开页面即取消
    void window.electronAPI.resources.lastStorage().then((last) => {
      if (last) setSnapshot((current) => current ?? last);
    });
    void scan();
    return () => {
      off();
      void window.electronAPI.resources.cancelScan();
    };
  }, [scan]);

  const categories = snapshot
    ? [...snapshot.categories].filter((c) => c.bytes > 0).sort((a, b) => b.bytes - a.bytes)
    : [];
  const volumes = React.useMemo(() => {
    const map = new Map<string, StorageRoot[]>();
    for (const root of snapshot?.roots ?? []) {
      map.set(root.volumeId, [...(map.get(root.volumeId) ?? []), root]);
    }
    return [...map.values()];
  }, [snapshot]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          {busy === 'scan'
            ? progress
              ? t('Scanning {{count}} files · {{size}}', {
                  count: progress.files.toLocaleString(),
                  size: formatBytes(progress.bytes),
                })
              : t('Scanning...')
            : snapshot
              ? t('Scanned at {{time}} · took {{seconds}}s', {
                  time: new Date(snapshot.scannedAt).toLocaleTimeString(),
                  seconds: (snapshot.durationMs / 1000).toFixed(1),
                })
              : null}
        </p>
        {busy === 'scan' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void window.electronAPI.resources.cancelScan()}
          >
            {t('Cancel')}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void scan()}
            disabled={busy !== null}
            aria-label={t('Refresh')}
          >
            <RefreshCw />
          </Button>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {snapshot && snapshot.errorCount > 0 && (
        <p
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          title={snapshot.errors.join('\n')}
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          {t('{{count}} paths could not be read and are not counted.', {
            count: snapshot.errorCount,
          })}
        </p>
      )}
      {snapshot && (
        <>
          {volumes.map((roots) => {
            const volume = roots[0]?.volume;
            const used = roots.reduce((sum, r) => sum + r.bytes, 0);
            return (
              <div key={roots[0]?.volumeId} className="space-y-2">
                {volume ? (
                  <UsageMeter
                    app={used}
                    system={volume.total - volume.free}
                    total={volume.total}
                    format={formatBytes}
                  />
                ) : (
                  <div className="rounded-lg border p-4 font-mono text-2xl font-semibold">
                    {formatBytes(used)}
                  </div>
                )}
                {roots.map((root) => (
                  <div key={root.id} className="flex items-center gap-2 px-1 text-xs">
                    <span className="shrink-0 text-muted-foreground">{rootLabel(root, t)}</span>
                    <span className="min-w-0 flex-1 truncate font-mono" title={root.path}>
                      {root.path}
                    </span>
                    <span className="font-mono">{formatBytes(root.bytes)}</span>
                  </div>
                ))}
              </div>
            );
          })}
          <div className="divide-y rounded-lg border">
            {categories.map((category) => (
              <StorageRow
                key={category.id}
                category={category}
                share={snapshot.totalBytes > 0 ? category.bytes / snapshot.totalBytes : 0}
                expanded={expanded === category.id}
                onToggle={() => setExpanded(expanded === category.id ? null : category.id)}
                cleaning={busy === category.id}
                disabled={busy !== null}
                onClean={() =>
                  STORAGE_CLEANABILITY[category.id] === 'confirm'
                    ? setConfirming(category.id)
                    : void clean(category.id)
                }
              />
            ))}
          </div>
          <SessionStorage
            sessions={snapshot.sessions}
            busy={busy === 'sessions'}
            disabled={busy !== null}
            onClean={(request) =>
              run('sessions', async () => {
                const result = await window.electronAPI.resources.cleanSessions(request);
                addToast({
                  type: 'success',
                  title: t('{{count}} conversations deleted', { count: result.removed }),
                });
                return result.snapshot;
              })
            }
          />
        </>
      )}
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogPopup className="sm:max-w-md" zIndexLevel="nested">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">
              {t('Clean {{name}}?', { name: confirming ? t(CATEGORY_LABELS[confirming][0]) : '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming === 'browser'
                ? t('You will be signed out of sites opened in the built-in browser.')
                : t('Deleted files cannot be restored.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter variant="bare">
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              {t('Cancel')}
            </AlertDialogClose>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                const id = confirming;
                setConfirming(null);
                if (id) void clean(id);
              }}
            >
              {t('Clean')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function StorageRow({
  category,
  share,
  expanded,
  onToggle,
  cleaning,
  disabled,
  onClean,
}: {
  category: StorageCategory;
  share: number;
  expanded: boolean;
  onToggle: () => void;
  cleaning: boolean;
  disabled: boolean;
  onClean: () => void;
}) {
  const { t } = useI18n();
  const [label, description] = CATEGORY_LABELS[category.id];
  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn('h-4 w-4 shrink-0 transition-transform', expanded && 'rotate-90')}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="font-medium">{t(label)}</span>
              <span className="font-mono text-xs">
                {category.id === 'secretaryImages' && (
                  <span className="mr-2 text-muted-foreground">
                    {t('{{count}} files', { count: category.files })}
                  </span>
                )}
                {formatBytes(category.bytes)}
              </span>
            </div>
            <p
              className={cn(
                'text-xs text-muted-foreground',
                category.id !== 'secretaryImages' && 'truncate'
              )}
            >
              {t(description)}
            </p>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-foreground/60" style={{ width: `${share * 100}%` }} />
            </div>
          </div>
        </button>
        {STORAGE_CLEANABILITY[category.id] !== 'none' && (
          <Button variant="outline" size="sm" disabled={disabled} onClick={onClean}>
            {cleaning ? t('Cleaning...') : t('Clean')}
          </Button>
        )}
      </div>
      {expanded && (
        <div className="mt-2 space-y-0.5 pl-6">
          {category.entries.map((entry) => (
            <div
              key={`${entry.root}:${entry.path}`}
              className="group flex items-center gap-2 text-xs"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                {entry.root === 'data' ? entry.path : `${t('Worktree directory')}/${entry.path}`}
              </span>
              <span className="font-mono">{formatBytes(entry.bytes)}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="opacity-0 group-hover:opacity-100"
                aria-label={t('Show in folder')}
                onClick={() =>
                  void window.electronAPI.resources.revealStorage(entry.root, entry.path)
                }
              >
                <FolderOpen />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type PendingClean = { request: SessionCleanRequest; count: number; bytes: number };

function SessionStorage({
  sessions,
  busy,
  disabled,
  onClean,
}: {
  sessions: SessionStorageEntry[];
  busy: boolean;
  disabled: boolean;
  onClean: (request: SessionCleanRequest) => void;
}) {
  const { t } = useI18n();
  const [includeUnarchived, setIncludeUnarchived] = React.useState(false);
  const [showAll, setShowAll] = React.useState(false);
  const [pending, setPending] = React.useState<PendingClean | null>(null);
  const [projectId, setProjectId] = React.useState(ALL_PROJECTS);
  const byId = React.useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  // 项目按占用倒序；项目被移除后选择自动回到全部
  const projects = React.useMemo(() => {
    const acc = new Map<string, { name: string; bytes: number; count: number }>();
    for (const s of sessions) {
      const p = acc.get(s.projectId) ?? { name: s.projectName, bytes: 0, count: 0 };
      p.bytes += s.bytes;
      p.count += 1;
      acc.set(s.projectId, p);
    }
    return [...acc].sort((a, b) => b[1].bytes - a[1].bytes);
  }, [sessions]);
  const scope = projects.some(([id]) => id === projectId) ? projectId : ALL_PROJECTS;
  const scoped = scope ? sessions.filter((s) => s.projectId === scope) : sessions;

  const plan = (request: SessionCleanRequest): PendingClean => {
    const ids = sessionCleanIds(sessions, request, Date.now());
    return {
      request,
      count: ids.length,
      bytes: ids.reduce((sum, id) => sum + (byId.get(id)?.bytes ?? 0), 0),
    };
  };
  const stale = (days: number) =>
    plan({ kind: 'stale', days, includeUnarchived, ...(scope ? { projectId: scope } : {}) });
  const total = scoped.reduce((sum, s) => sum + s.bytes, 0);
  const visible = showAll ? scoped : scoped.slice(0, SESSION_LIST_LIMIT);
  const projectLabel = (id: string, name: string) =>
    name || (id ? id.slice(0, 8) : t('No project'));
  const single = pending?.request.kind === 'one' ? byId.get(pending.request.id) : undefined;
  const pendingProjectId =
    pending?.request.kind === 'stale' ? pending.request.projectId : undefined;
  const pendingProject =
    pendingProjectId === undefined
      ? undefined
      : projectLabel(
          pendingProjectId,
          projects.find(([id]) => id === pendingProjectId)?.[1].name ?? ''
        );

  return (
    <div className="rounded-lg border">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <div className="shrink-0 text-sm font-medium">
          {t('Conversations')}
          <span className="ml-2 font-mono text-xs text-muted-foreground">
            {scoped.length} · {formatBytes(total)}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <Select
            items={{
              [ALL_PROJECTS]: t('All projects'),
              ...Object.fromEntries(projects.map(([id, p]) => [id, projectLabel(id, p.name)])),
            }}
            value={scope}
            onValueChange={(value) => setProjectId(value ?? ALL_PROJECTS)}
          >
            <SelectTrigger size="sm" className="w-48 min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={ALL_PROJECTS}>{t('All projects')}</SelectItem>
              {projects.map(([id, p]) => (
                <SelectItem key={id} value={id}>
                  <span className="flex w-full items-center gap-3">
                    <span className="flex-1 truncate">{projectLabel(id, p.name)}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {p.count} · {formatBytes(p.bytes)}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Menu>
            <MenuTrigger
              render={
                <Button variant="outline" size="sm" disabled={disabled || scoped.length === 0} />
              }
            >
              <Eraser />
              {busy ? t('Cleaning...') : t('Clean')}
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-48">
              <MenuCheckboxItem
                checked={includeUnarchived}
                onCheckedChange={setIncludeUnarchived}
                closeOnClick={false}
              >
                {t('Include unarchived')}
              </MenuCheckboxItem>
              <MenuSeparator />
              {[...SESSION_CLEAN_DAYS, 0].map((days) => {
                const next = stale(days);
                return (
                  <MenuItem
                    key={days}
                    variant="destructive"
                    disabled={next.count === 0}
                    onClick={() => setPending(next)}
                  >
                    <span className="flex-1">
                      {days > 0 ? t('Older than {{days}} days', { days }) : t('All')}
                    </span>
                    <span className="font-mono text-xs opacity-70">{next.count}</span>
                  </MenuItem>
                );
              })}
            </MenuPopup>
          </Menu>
        </div>
      </div>
      <div className="max-h-96 divide-y overflow-y-auto">
        {visible.map((session) => (
          <div key={session.id} className="group flex items-center gap-3 px-3 py-1.5 text-sm">
            <div className="min-w-0 flex-1">
              <div className="truncate" title={session.title}>
                {session.title || t('Untitled')}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {[
                  session.projectName,
                  session.archived ? t('Archived') : null,
                  new Date(session.lastActiveAt).toLocaleDateString(),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <span className="font-mono text-xs">{formatBytes(session.bytes)}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="opacity-0 group-hover:opacity-100"
              disabled={disabled}
              aria-label={t('Delete')}
              onClick={() =>
                setPending({
                  request: { kind: 'one', id: session.id },
                  count: 1,
                  bytes: session.bytes,
                })
              }
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
      {scoped.length > SESSION_LIST_LIMIT && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          className="w-full border-t px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          {showAll ? t('Show less') : t('Show all')}
        </button>
      )}
      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogPopup className="sm:max-w-md" zIndexLevel="nested">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">
              {single
                ? t('Delete "{{title}}"?', { title: single.title || t('Untitled') })
                : pendingProject !== undefined
                  ? t('Delete {{count}} conversations in {{project}}?', {
                      count: pending?.count ?? 0,
                      project: pendingProject,
                    })
                  : t('Delete {{count}} conversations?', { count: pending?.count ?? 0 })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'About {{size}} of history, tool output and isolated worktrees will be removed and cannot be restored.',
                { size: formatBytes(pending?.bytes ?? 0) }
              )}
              {!single && ` ${t('Open, running and waiting conversations are skipped.')}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter variant="bare">
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              {t('Cancel')}
            </AlertDialogClose>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                const request = pending?.request;
                setPending(null);
                if (request) onClean(request);
              }}
            >
              {t('Delete')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
