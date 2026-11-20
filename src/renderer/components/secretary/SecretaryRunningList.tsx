import { type ContactBadge, sessionBadge } from '@shared/secretary/commands';
import type { PendingDispatch, SecretaryCard } from '@shared/types/secretary';
import { ArrowUpRight, Check } from 'lucide-react';
import { useState } from 'react';
import { HOVER_ROW_CLASS, HoverActions } from '@/components/ui/hover-actions';
import { useI18n } from '@/i18n';
import { modelLabel } from '@/lib/modelLabel';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useSecretaryStore } from '@/stores/secretary';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

type SessionCard = Extract<SecretaryCard, { kind: 'session' }>;

const BADGE_CLASS = 'shrink-0 rounded px-1 py-px text-[10px]';

/**
 * 状态徽标。等后台任务和续跑都是「空闲但还没收口」，靠 backgroundRunning 区分；
 * 需要你、出错按 countsAsRunning 的口径不进这张表，这里只是把状态列全。
 */
const BADGE_STYLE: Record<ContactBadge, { label: string; className: string }> = {
  failed: { label: 'Failed', className: 'bg-destructive/15 text-destructive' },
  waiting: { label: 'Waiting for you', className: 'bg-warning/15 text-warning' },
  running: { label: 'Running', className: 'bg-success/15 text-success' },
  background: { label: 'Waiting on a background task', className: 'bg-warning/15 text-warning' },
  persistent: { label: 'Service running', className: 'bg-warning/15 text-warning' },
  continuing: { label: 'Continuing', className: 'bg-success/15 text-success' },
  interrupted: { label: 'Interrupted', className: 'bg-warning/15 text-warning' },
  stalled: { label: 'Stalled, no activity', className: 'bg-destructive/15 text-destructive' },
  idle: { label: 'Idle', className: 'bg-muted text-muted-foreground' },
};

function badgeOf(card: SessionCard): { label: string; className: string } {
  return BADGE_STYLE[sessionBadge({ ...card, stalled: card.stalled !== undefined })];
}

/** 一行进行中的会话：点主体展开更多进度，右侧图标才打开会话 */
function RunningRow({ card }: { card: SessionCard }) {
  const { t, locale } = useI18n();
  const selectConversation = useSessionsStore((state) => state.selectConversation);
  const providers = useSettingsStore((state) => state.providers) ?? [];
  const [expanded, setExpanded] = useState(false);
  const badge = badgeOf(card);
  const model = modelLabel(providers, card.model);
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
        {model && (
          <span
            data-enso="secretary-running-model"
            className="mt-0.5 block truncate text-[11.5px] text-subtle-foreground"
          >
            {t('Model: {{model}}', { model })}
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
      {/* 行内收口：只有派发或接管跟踪的会话才会出现在这张表里 */}
      <HoverActions className="pr-7">
        <button
          type="button"
          data-enso="secretary-running-mark-done"
          title={t('Mark done')}
          aria-label={t('Mark done')}
          onClick={(event) => {
            event.stopPropagation();
            void window.electronAPI.secretary.markResult(card.conversationId, 'done');
          }}
          className="flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-success/10 hover:text-success"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
      </HoverActions>
      <button
        type="button"
        data-enso="secretary-running-open"
        title={t('Open session')}
        aria-label={t('Open session')}
        onClick={(event) => {
          event.stopPropagation();
          selectConversation(card.conversationId);
        }}
        className="relative flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
export function SecretaryRunningList({ secretaryId }: { secretaryId?: string } = {}) {
  const { t } = useI18n();
  const running = useSecretaryStore(
    (state) =>
      (secretaryId ? state.states[secretaryId] : undefined)?.board.running ??
      state.secretary.board.running
  );
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
