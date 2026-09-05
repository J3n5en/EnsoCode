import type { MemoryCommandAction } from '@shared/memoryCommand';
import type { MemorySnapshot } from '@shared/memorySnapshot';
import { Brain, Layers, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
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

function basename(cwd: string): string {
  return (
    cwd
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .at(-1) || cwd
  );
}

function phaseCopy(
  t: (key: string) => string,
  snapshot: MemorySnapshot
): { label: string; className: string } {
  if (snapshot.phase2Status === 'running') {
    return { label: t('Merging…'), className: 'text-info' };
  }
  if (snapshot.dirty) {
    return { label: t('Merge queued'), className: 'text-warning' };
  }
  if (snapshot.hasMemoryMd) {
    return { label: t('Ready'), className: 'text-success' };
  }
  return { label: t('Idle'), className: 'text-muted-foreground' };
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

  const phase = snapshot ? phaseCopy(t, snapshot) : null;
  const summary = snapshot?.summary.trim() ?? '';
  const lessons = snapshot?.learned ?? [];

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
      <PopoverPopup side="bottom" align="end" className="w-80 [&_[data-slot=popover-viewport]]:p-0">
        <div className="flex flex-col gap-2.5 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium">{t('Project memory')}</p>
              {snapshot && (
                <p
                  className="truncate font-mono text-[10px] text-muted-foreground"
                  title={snapshot.cwd}
                >
                  {basename(snapshot.cwd)}
                </p>
              )}
            </div>
            {phase && (
              <span className={cn('shrink-0 text-[10px] font-medium', phase.className)}>
                {phase.label}
              </span>
            )}
          </div>

          {error && <p className="text-destructive text-[11px]">{error}</p>}
          {snapshot?.notice && !error && (
            <p className="text-[11px] text-muted-foreground">{t(snapshot.notice)}</p>
          )}

          {snapshot && (
            <p className="text-[11px] tabular-nums text-muted-foreground">
              {t('{{lessons}} lessons · {{merged}} merged · {{size}}', {
                lessons: lessons.length,
                merged: snapshot.stage1Done,
                size: formatBytes(snapshot.bytes),
              })}
            </p>
          )}

          {summary ? (
            <p className="max-h-28 overflow-auto text-xs leading-relaxed">{summary}</p>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {t('Idle sessions write a summary after the next spawn.')}
            </p>
          )}

          {lessons.length > 0 && (
            <ul className="max-h-36 space-y-1.5 overflow-auto border-l border-border pl-2">
              {lessons.slice(0, 8).map((lesson) => (
                <li key={lesson} className="text-[11px] leading-snug">
                  {lesson}
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center justify-between gap-2 pt-0.5">
            <button
              type="button"
              disabled={busy || snapshot?.dirty}
              className="inline-flex items-center gap-1 text-[11px] text-foreground/90 hover:text-foreground disabled:cursor-default disabled:text-muted-foreground"
              onClick={() => void run('enqueue')}
            >
              <Layers className="h-3 w-3" />
              {snapshot?.dirty ? t('Already queued') : t('Queue merge')}
            </button>
            <button
              type="button"
              disabled={busy}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-destructive disabled:opacity-40"
              onClick={() => {
                if (window.confirm(t('Clear project memory?'))) void run('clear');
              }}
            >
              <Trash2 className="h-3 w-3" />
              {t('Clear')}
            </button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
