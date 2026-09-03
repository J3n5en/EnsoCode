import type { ContextOccupancy, ContextOccupancyBucketId } from '@shared/types/agent';
import { useI18n } from '@/i18n';
import { useSessionsStore } from '@/stores/sessions';
import { formatTokens } from '@/stores/sessions/stats';

const BUCKET_LABELS: Record<ContextOccupancyBucketId, string> = {
  system: 'System prompt',
  instructions: 'Enabled instructions',
  skills: 'Enabled skills',
  tools: 'Tool definitions',
  conversation: 'Conversation',
  compaction: 'Compaction summary',
  projectMemory: 'Project memory',
  reminders: 'Reminders',
};

export function ContextInspector({
  occupancy,
  conversationId,
}: {
  occupancy?: ContextOccupancy;
  conversationId?: string;
}) {
  const { t } = useI18n();
  if (!occupancy) {
    return (
      <p className="px-2 py-1.5 text-xs text-muted-foreground">
        {t('Context occupancy unavailable until the session starts')}
      </p>
    );
  }
  const window = occupancy.contextWindow;
  return (
    <div className="flex flex-col gap-2 px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="tabular-nums">
          {formatTokens(occupancy.used)}
          {window ? ` / ${formatTokens(window)}` : ' · ?'}
          {occupancy.percent !== undefined ? ` · ${occupancy.percent}%` : ''}
        </span>
        <span className="text-muted-foreground">{t('Estimate')}</span>
      </div>
      {occupancy.compactionModelMismatch && (
        <p className="text-[11px] text-muted-foreground">
          {t('Current summary was produced by another model family')}
        </p>
      )}
      {occupancy.compactedMessageCount > 0 && (
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <p>
            {t('{{count}} older messages are folded into the summary', {
              count: occupancy.compactedMessageCount,
            })}
          </p>
          {conversationId && occupancy.compactionEntryId && (
            <button
              type="button"
              className="shrink-0 text-foreground/80 hover:underline"
              onClick={() => {
                void useSessionsStore
                  .getState()
                  .forkFromEntry(conversationId, occupancy.compactionEntryId!);
              }}
            >
              {t('Open parallel session')}
            </button>
          )}
        </div>
      )}
      <ul className="flex flex-col gap-1">
        {(Object.keys(BUCKET_LABELS) as ContextOccupancyBucketId[]).map((id) => {
          const tokens = occupancy.buckets[id];
          const share = occupancy.used > 0 ? Math.round((tokens / occupancy.used) * 100) : 0;
          return (
            <li key={id} className="flex items-center gap-2 text-[11px]">
              <span className="w-28 shrink-0 truncate text-muted-foreground">
                {t(BUCKET_LABELS[id])}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block h-1 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full bg-foreground/50" style={{ width: `${share}%` }} />
                </span>
              </span>
              <span className="w-10 shrink-0 text-right tabular-nums">{formatTokens(tokens)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
