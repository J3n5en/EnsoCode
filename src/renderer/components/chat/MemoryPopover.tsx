import type { MemoryCommandAction } from '@shared/memoryCommand';
import { Brain } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

const ACTIONS: { action: MemoryCommandAction; label: string }[] = [
  { action: 'view', label: 'Show the current memory injection' },
  { action: 'stats', label: 'File counts and Phase 2 watermark' },
  { action: 'diagnose', label: 'Enabled flag, cwd, and dirty state' },
  { action: 'enqueue', label: 'Queue consolidation for next spawn' },
  { action: 'clear', label: 'Delete this project memory root' },
];

export function MemoryPopover({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const enabled = useSettingsStore((s) => s.localMemoryEnabled !== false);

  const run = async (action: MemoryCommandAction) => {
    setBusy(true);
    setError(null);
    const result = await useSessionsStore.getState().memory(conversationId, action);
    if (result.ok) setText(result.text);
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
        if (result.ok) setText(result.text);
        else setError(result.error);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, enabled, conversationId]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={!enabled}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        title={t('Project memory')}
        aria-label={t('Project memory')}
      >
        <Brain className="h-3.5 w-3.5" />
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        align="end"
        className="w-[28rem] [&_[data-slot=popover-viewport]]:space-y-2 [&_[data-slot=popover-viewport]]:p-2"
      >
        <div className="flex items-center justify-between gap-2 px-1">
          <p className="font-medium text-xs">{t('Project memory')}</p>
          {busy && <p className="text-[11px] text-muted-foreground">{t('Loading…')}</p>}
        </div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed">
          {error ?? (text || t('No memory payload yet.'))}
        </pre>
        <div className="flex flex-wrap gap-1">
          {ACTIONS.map((row) => (
            <button
              key={row.action}
              type="button"
              disabled={busy}
              title={t(row.label)}
              onClick={() => {
                if (row.action === 'clear' && !window.confirm(t('Clear project memory?'))) return;
                void run(row.action);
              }}
              className={cn(
                'rounded-md px-2 py-1 text-[11px] transition-colors hover:bg-muted disabled:opacity-40',
                row.action === 'clear' ? 'text-destructive' : 'text-muted-foreground'
              )}
            >
              {t(
                row.action === 'view'
                  ? 'View'
                  : row.action === 'stats'
                    ? 'Stats'
                    : row.action === 'diagnose'
                      ? 'Diagnose'
                      : row.action === 'enqueue'
                        ? 'Enqueue merge'
                        : 'Clear'
              )}
            </button>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
