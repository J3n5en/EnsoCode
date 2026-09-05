import type { MemoryCommandAction } from '@shared/memoryCommand';
import type { MemorySnapshot } from '@shared/memorySnapshot';
import { Brain, CircleHelp, Layers, ListTree, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function phaseLabel(
  t: (key: string) => string,
  snapshot: MemorySnapshot
): { text: string; variant: 'success' | 'warning' | 'info' | 'outline' } {
  if (snapshot.dirty) return { text: t('Merge queued'), variant: 'warning' };
  if (snapshot.phase2Status === 'running') return { text: t('Merging…'), variant: 'info' };
  if (snapshot.hasMemoryMd) return { text: t('Ready'), variant: 'success' };
  return { text: t('Empty'), variant: 'outline' };
}

export function MemoryPopover({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enabled = useSettingsStore((s) => s.localMemoryEnabled !== false);

  const run = async (action: MemoryCommandAction) => {
    setBusy(true);
    setError(null);
    const result = await useSessionsStore.getState().memory(conversationId, action);
    if (result.ok) setSnapshot(result.snapshot);
    else setError(result.error);
    setBusy(false);
  };

  useEffect(() => {
    if (!open || !enabled) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    void useSessionsStore
      .getState()
      .memory(conversationId, 'view')
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setSnapshot(result.snapshot);
        else setError(result.error);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, enabled, conversationId]);

  const badge = snapshot ? phaseLabel(t, snapshot) : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={!enabled}
        className={cn(
          'shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40',
          snapshot?.dirty && 'text-warning'
        )}
        title={t('Project memory')}
        aria-label={t('Project memory')}
      >
        <Brain className="h-3.5 w-3.5" />
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        align="end"
        className="w-[22rem] [&_[data-slot=popover-viewport]]:space-y-3 [&_[data-slot=popover-viewport]]:p-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium text-sm">{t('Project memory')}</p>
            <p className="truncate text-[11px] text-muted-foreground" title={snapshot?.cwd}>
              {snapshot?.cwd ?? t('Loading…')}
            </p>
          </div>
          {badge && (
            <Badge variant={badge.variant} size="sm">
              {badge.text}
            </Badge>
          )}
        </div>

        {error && <p className="text-destructive text-xs">{error}</p>}
        {snapshot?.notice && !error && (
          <p className="rounded-md bg-info/10 px-2 py-1 text-[11px] text-info-foreground">
            {t(snapshot.notice)}
          </p>
        )}

        <div className="grid grid-cols-3 gap-1.5">
          <StatCell label={t('Lessons')} value={String(snapshot?.learned.length ?? '—')} />
          <StatCell
            label={t('Merged sessions')}
            value={snapshot ? `${snapshot.stage1Done}/${Math.max(snapshot.stage1Total, 0)}` : '—'}
          />
          <StatCell label={t('Size')} value={snapshot ? formatBytes(snapshot.bytes) : '—'} />
        </div>

        <section className="space-y-1.5">
          <p className="font-medium text-[11px] text-muted-foreground">{t('Working summary')}</p>
          <div className="max-h-28 overflow-auto rounded-lg border bg-muted/20 px-2.5 py-2 text-xs leading-relaxed">
            {snapshot?.summary.trim()
              ? snapshot.summary
              : t('Nothing consolidated yet. Idle sessions merge after the next spawn.')}
          </div>
        </section>

        <section className="space-y-1.5">
          <p className="font-medium text-[11px] text-muted-foreground">{t('Recent lessons')}</p>
          {snapshot?.learned.length ? (
            <ul className="max-h-36 space-y-1 overflow-auto">
              {snapshot.learned.slice(0, 8).map((lesson) => (
                <li
                  key={lesson}
                  className="rounded-md border bg-card px-2 py-1.5 text-[11px] leading-snug"
                >
                  {lesson}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {t('No learn captures yet. The agent writes them with the learn tool.')}
            </p>
          )}
        </section>

        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            className="h-7 flex-1 text-[11px]"
            onClick={() => void run('enqueue')}
          >
            <Layers className="h-3 w-3" />
            {t('Queue merge')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            className="h-7 px-2 text-[11px] text-destructive hover:text-destructive"
            onClick={() => {
              if (window.confirm(t('Clear project memory?'))) void run('clear');
            }}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>

        {snapshot && (
          <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
            {snapshot.hasMemoryMd ? (
              <ListTree className="h-3 w-3" />
            ) : (
              <CircleHelp className="h-3 w-3" />
            )}
            {snapshot.hasMemoryMd
              ? t('MEMORY.md is present for this project.')
              : t('No MEMORY.md yet — waiting for idle history.')}
          </p>
        )}
      </PopoverPopup>
    </Popover>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/15 px-2 py-1.5">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="font-medium text-xs tabular-nums">{value}</p>
    </div>
  );
}
