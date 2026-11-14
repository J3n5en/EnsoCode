import type { PendingDispatch, SecretaryCard } from '@shared/types/secretary';
import { ArrowUpRight } from 'lucide-react';
import { useState } from 'react';
import { HOVER_ROW_CLASS } from '@/components/ui/hover-actions';
import { useI18n } from '@/i18n';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useSecretaryStore } from '@/stores/secretary';
import { useSessionsStore } from '@/stores/sessions';

type SessionCard = Extract<SecretaryCard, { kind: 'session' }>;

const BADGE_CLASS = 'shrink-0 rounded px-1 py-px text-[10px]';

/**
 * 状态徽标。等后台任务和续跑都是「空闲但还没收口」，靠 backgroundRunning 区分；
 * 需要你、出错按 countsAsRunning 的口径不进这张表，这里只是把状态列全。
 */
function badgeOf(card: SessionCard): { label: string; className: string } {
  if (card.state === 'error')
    return { label: 'Failed', className: 'bg-destructive/15 text-destructive' };
  if (card.state === 'waiting')
    return { label: 'Waiting for you', className: 'bg-warning/15 text-warning' };
  if (card.state === 'running')
    return { label: 'Running', className: 'bg-success/15 text-success' };
  if (card.backgroundRunning)
    return { label: 'Waiting on a background task', className: 'bg-warning/15 text-warning' };
  if (card.continuing) return { label: 'Continuing', className: 'bg-success/15 text-success' };
  return { label: 'Idle', className: 'bg-muted text-muted-foreground' };
}

/** 一行进行中的会话：点主体展开更多进度，右侧图标才打开会话 */
function RunningRow({ card }: { card: SessionCard }) {
  const { t, locale } = useI18n();
  const selectConversation = useSessionsStore((state) => state.selectConversation);
  const [expanded, setExpanded] = useState(false);
  const badge = badgeOf(card);
  return (
    <div
      data-enso="secretary-running-row"
      data-conversation={card.conversationId}
      data-open={expanded ? 'true' : 'false'}
      className={cn(HOVER_ROW_CLASS, 'flex items-start gap-2 rounded-lg px-1.5 py-1.5')}
    >
      <button
        type="button"
        data-enso="secretary-running-expand"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="min-w-0 flex-1 text-left"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span data-enso="secretary-running-badge" className={cn(BADGE_CLASS, badge.className)}>
            {t(badge.label)}
          </span>
          {card.takeover && (
            <span
              data-enso="secretary-running-takeover"
              className={cn(BADGE_CLASS, 'bg-primary/10 text-primary')}
            >
              {t('Taken over')}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-[13px]">{card.title || t('Unnamed')}</span>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <span className="shrink-0 rounded bg-muted px-1.5 text-[11px]">{card.projectName}</span>
          <span className="shrink-0 tabular-nums">
            {formatRelativeTime(card.stateSince, locale)}
          </span>
        </span>
        {(card.branch || card.baseRef) && (
          <span
            data-enso="secretary-running-base"
            className="mt-0.5 block truncate text-[11.5px] text-subtle-foreground"
          >
            {card.branch ?? ''}
            {card.baseRef ? ` · ${t('from {{ref}}', { ref: card.baseRef })}` : ''}
          </span>
        )}
        {card.lastText && (
          <span
            className={cn(
              'mt-0.5 block text-[12px] text-muted-foreground',
              expanded ? 'whitespace-pre-wrap break-words' : 'truncate'
            )}
          >
            {card.lastText}
          </span>
        )}
        {expanded && (
          <span className="mt-1 block text-[11.5px] text-subtle-foreground">
            {t('Started {{time}}', { time: formatRelativeTime(card.startedAt, locale) })}
          </span>
        )}
      </button>
      <button
        type="button"
        data-enso="secretary-running-open"
        title={t('Open session')}
        aria-label={t('Open session')}
        onClick={(event) => {
          event.stopPropagation();
          selectConversation(card.conversationId);
        }}
        className="flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ArrowUpRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** 等依赖的派发：还没有会话，只报在等谁 */
function PendingRow({ pending }: { pending: PendingDispatch }) {
  const { t, locale } = useI18n();
  const title = pending.draft.title?.trim() || pending.draft.prompt.split('\n')[0]?.trim() || '';
  return (
    <div
      data-enso="secretary-running-pending"
      data-pending={pending.id}
      className="flex items-start gap-2 rounded-lg px-1.5 py-1.5"
    >
      <div className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            data-enso="secretary-running-badge"
            className={cn(BADGE_CLASS, 'bg-warning/15 text-warning')}
          >
            {t('Waiting for dependencies')}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px]">{title || t('Unnamed')}</span>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <span className="shrink-0 rounded bg-muted px-1.5 text-[11px]">{pending.projectId}</span>
          <span className="shrink-0 tabular-nums">
            {formatRelativeTime(pending.updatedAt, locale)}
          </span>
        </span>
        <span
          data-enso="secretary-running-after"
          className="mt-0.5 block truncate text-[11.5px] text-subtle-foreground"
        >
          {t('After {{ids}}', { ids: pending.after.join(', ') })}
        </span>
      </div>
    </div>
  );
}

/** 「进行中 N」展开后的明细：和摘要里的数字共用 board.running，条数天然一致 */
export function SecretaryRunningList() {
  const { t } = useI18n();
  const running = useSecretaryStore((state) => state.secretary.board.running);
  return (
    <section data-enso="secretary-running" className="flex flex-col px-3 pt-2">
      <h3 className="px-1.5 pb-1 text-[12px] text-subtle-foreground">
        {t('In progress')}
        <span className="ml-1 tabular-nums">{running.length}</span>
      </h3>
      {running.length === 0 ? (
        <p
          data-enso="secretary-running-empty"
          className="px-1.5 py-1 text-[12px] text-muted-foreground"
        >
          {t('Nothing running')}
        </p>
      ) : (
        running.map((card) =>
          card.kind === 'session' ? (
            <RunningRow key={card.conversationId} card={card} />
          ) : card.kind === 'pending' ? (
            <PendingRow key={card.pending.id} pending={card.pending} />
          ) : null
        )
      )}
    </section>
  );
}
