import type { MemoryCommandAction, MemorySavePatch } from '@shared/memoryCommand';
import type { MemorySnapshot } from '@shared/memorySnapshot';
import { Brain, Layers, Plus, Trash2 } from 'lucide-react';
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
  const [summaryDraft, setSummaryDraft] = useState('');
  const [learnedDraft, setLearnedDraft] = useState<{ id: string; text: string }[]>([]);
  const enabled = useSettingsStore((s) => s.localMemoryEnabled !== false);

  const applySnapshot = (next: MemorySnapshot) => {
    setSnapshot(next);
    setSummaryDraft(next.summary);
    setLearnedDraft(
      next.learned.length > 0
        ? next.learned.map((text) => ({ id: crypto.randomUUID(), text }))
        : [{ id: crypto.randomUUID(), text: '' }]
    );
  };

  const dirty =
    snapshot !== null &&
    (summaryDraft !== snapshot.summary ||
      learnedDraft
        .map((row) => row.text.trim())
        .filter(Boolean)
        .join('\n') !== snapshot.learned.join('\n'));

  const run = async (action: MemoryCommandAction, patch?: MemorySavePatch) => {
    setBusy(true);
    setError(null);
    const result = await useSessionsStore.getState().memory(conversationId, action, patch);
    if (result.ok) applySnapshot(result.snapshot);
    else setError(result.error);
    setBusy(false);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per open
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
        if (result.ok) applySnapshot(result.snapshot);
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={!enabled}
        className={cn(
          'shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40',
          snapshot?.phase2Status === 'running' && 'text-info'
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
              <p className="font-medium text-xs">{t('Project memory')}</p>
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
              <span className={cn('shrink-0 font-medium text-[10px]', phase.className)}>
                {phase.label}
              </span>
            )}
          </div>

          {error && <p className="text-[11px] text-destructive">{error}</p>}
          {snapshot?.notice && !error && (
            <p className="text-[11px] text-muted-foreground">{t(snapshot.notice)}</p>
          )}

          {snapshot && (
            <p className="text-[11px] text-muted-foreground tabular-nums">
              {t('{{lessons}} lessons · {{merged}} merged · {{size}}', {
                lessons: learnedDraft.filter((row) => row.text.trim()).length,
                merged: snapshot.stage1Done,
                size: formatBytes(snapshot.bytes),
              })}
            </p>
          )}

          <textarea
            value={summaryDraft}
            disabled={busy || !snapshot}
            placeholder={t('Write the working summary…')}
            onChange={(event) => setSummaryDraft(event.target.value)}
            className="min-h-20 resize-none bg-transparent text-xs leading-relaxed outline-none placeholder:text-muted-foreground disabled:opacity-50"
          />

          <div className="space-y-1 border-border border-l pl-2">
            {learnedDraft.map((lesson) => (
              <div key={lesson.id} className="flex items-start gap-1">
                <textarea
                  value={lesson.text}
                  disabled={busy || !snapshot}
                  rows={1}
                  placeholder={t('A durable lesson')}
                  onChange={(event) => {
                    setLearnedDraft(
                      learnedDraft.map((row) =>
                        row.id === lesson.id ? { ...row, text: event.target.value } : row
                      )
                    );
                  }}
                  className="min-h-5 flex-1 resize-none bg-transparent text-[11px] leading-snug outline-none placeholder:text-muted-foreground disabled:opacity-50"
                />
                <button
                  type="button"
                  disabled={busy || learnedDraft.length === 1}
                  className="mt-0.5 text-muted-foreground hover:text-destructive disabled:opacity-30"
                  onClick={() =>
                    setLearnedDraft(learnedDraft.filter((row) => row.id !== lesson.id))
                  }
                  aria-label={t('Remove lesson')}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
            <button
              type="button"
              disabled={busy || !snapshot}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
              onClick={() =>
                setLearnedDraft([...learnedDraft, { id: crypto.randomUUID(), text: '' }])
              }
            >
              <Plus className="h-3 w-3" />
              {t('Add lesson')}
            </button>
          </div>

          <div className="flex items-center justify-between gap-2 pt-0.5">
            <button
              type="button"
              disabled={busy || snapshot?.phase2Status === 'running'}
              className="inline-flex items-center gap-1 text-[11px] text-foreground/90 hover:text-foreground disabled:cursor-default disabled:text-muted-foreground"
              onClick={() => void run('enqueue')}
            >
              <Layers className="h-3 w-3" />
              {snapshot?.phase2Status === 'running' ? t('Merging…') : t('Merge now')}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy || !dirty}
                className="text-[11px] text-foreground/90 hover:text-foreground disabled:text-muted-foreground"
                onClick={() =>
                  void run('save', {
                    summary: summaryDraft,
                    learned: learnedDraft.map((row) => row.text.trim()).filter(Boolean),
                  })
                }
              >
                {t('Save')}
              </button>
              <button
                type="button"
                disabled={busy}
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-destructive disabled:opacity-40"
                onClick={() => {
                  if (window.confirm(t('Clear project memory?'))) void run('clear');
                }}
              >
                {t('Clear')}
              </button>
            </div>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
