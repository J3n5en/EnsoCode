import type { Delegation } from '@shared/types/bot';
import { useMemo } from 'react';
import { type TFunction, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useBotsStore } from '@/stores/bots';
import { isActiveDelegation } from '@/stores/bots/delegations';
import { type Presence, type PresenceInfo, presenceOf } from '@/stores/bots/presence';

const LABELS: Record<Presence, string> = {
  idle: 'Free',
  think: 'Planning',
  work: 'Busy',
  wait: 'Needs you',
  stuck: 'Stuck',
  done: 'Finished',
};

const MARKS: Record<Exclude<Presence, 'idle'>, { box: string; glyph: string }> = {
  think: { box: 'bg-card', glyph: 'h-[7px] w-[7px] rounded-full border-[1.5px] border-info' },
  work: { box: 'bg-info', glyph: 'h-[5px] w-[5px] rounded-[1px] bg-white' },
  wait: { box: 'bg-warning', glyph: 'h-[5px] w-[5px] rotate-45 bg-black/80' },
  stuck: {
    box: 'bg-destructive',
    glyph: 'h-0 w-0 border-x-[3.5px] border-x-transparent border-b-[6px] border-b-white',
  },
  done: {
    box: 'bg-success',
    glyph:
      'h-[4px] w-[7px] -translate-y-px -rotate-45 border-white border-b-[1.5px] border-l-[1.5px]',
  },
};

/** 状态名：「想」里在排队的显示「排队中」，不另设状态 */
export function presenceLabel(info: PresenceInfo, t: TFunction): string {
  const queued = info.state === 'think' && info.wait !== undefined;
  return queued ? t('In line') : t(LABELS[info.state]);
}

/** 形状角标（形状区分状态，不只靠颜色；闲不显示） */
export function PresenceMark({ state, className }: { state: Presence; className?: string }) {
  if (state === 'idle') return null;
  const mark = MARKS[state];
  return (
    <span
      aria-hidden
      className={cn('grid h-3 w-3 shrink-0 place-items-center rounded-full', mark.box, className)}
    >
      <i className={cn('block', mark.glyph)} />
    </span>
  );
}

export function PresenceChip({ info }: { info: PresenceInfo }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center gap-1 rounded bg-muted py-px pr-1.5 pl-1 text-[11px] text-foreground">
      <PresenceMark state={info.state} />
      {presenceLabel(info, t)}
    </span>
  );
}

/** 委派卡片：只看这一单的子会话，终态一直保留 */
export function useDelegationPresence(record: Delegation | undefined): PresenceInfo | undefined {
  const child = useBotsStore((s) => (record ? s.sessions[record.childConversationId] : undefined));
  const queue = useBotsStore((s) => s.queue);
  const silences = useBotsStore((s) => s.silences);
  return useMemo(
    () =>
      record &&
      presenceOf({
        conversationIds: isActiveDelegation(record.state) ? [record.childConversationId] : [],
        sessions: child ? { [record.childConversationId]: child } : {},
        queue,
        silences,
        delegation: record,
        clearedAt: Number.NEGATIVE_INFINITY,
      }),
    [record, child, queue, silences]
  );
}
