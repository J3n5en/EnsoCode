import type { BotProfile, Delegation, DelegationState, TaskCheck } from '@shared/types/bot';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { addToast } from '@/components/ui/toast';
import { type TFunction, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useBotsStore } from '@/stores/bots';
import { delegationActions, formatElapsed, isActiveDelegation } from '@/stores/bots/delegations';
import { BotAvatar } from './BotAvatar';
import { PresenceChip, useDelegationPresence } from './PresenceMark';

const timeOf = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function DelegationBadge({ state, interrupted }: { state: string; interrupted?: boolean }) {
  const { t } = useI18n();
  const tone =
    state === 'running' || state === 'queued'
      ? 'bg-info/15 text-info'
      : state === 'completed'
        ? 'bg-success/15 text-success'
        : state === 'failed'
          ? 'bg-destructive/15 text-destructive'
          : 'bg-muted text-muted-foreground';
  const label: Record<string, string> = {
    queued: t('Queued'),
    running: t('In progress'),
    completed: t('Completed'),
    failed: interrupted ? t('Interrupted') : t('Failed'),
    canceled: t('Canceled'),
  };
  return <span className={cn('rounded px-1.5 text-[11px]', tone)}>{label[state] ?? state}</span>;
}

/** 验收条件与最近一次校验结果 */
export function CheckBadge({ check, className }: { check: TaskCheck; className?: string }) {
  const { t } = useI18n();
  return (
    <div
      className={cn('flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs', className)}
    >
      <span className="shrink-0">{t('Acceptance check')}</span>
      <code className="min-w-0 truncate rounded bg-muted px-1" title={check.text}>
        {check.text}
      </code>
      {check.passed !== undefined && (
        <span
          className={cn(
            'shrink-0 rounded px-1.5 text-[11px]',
            check.passed ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'
          )}
        >
          {check.passed ? t('Passed') : t('Not passed')}
        </span>
      )}
    </div>
  );
}

export function failureText(record: Delegation, t: TFunction): string | undefined {
  switch (record.failure) {
    case 'interrupted':
      return t('The app restarted before this task finished. It was stopped and will not rerun.');
    case 'timeout':
      return t('Timed out after {{n}} minutes.', { n: record.timeoutMinutes ?? 240 });
    case 'denied':
      return t('Denied.');
    case 'check':
      return t('Acceptance check failed: "{{text}}" not found in tool outputs.', {
        text: record.check?.text ?? '',
      });
    default:
      return record.error === 'budget-exceeded'
        ? t("The member's daily budget is used up.")
        : record.error === 'turn-token-limit'
          ? t("Stopped: the member's per-turn token limit was exceeded.")
          : record.error;
  }
}

export function cancelDelegation(id: string, t: TFunction): void {
  void window.electronAPI.bots.cancelDelegation(id).then((result) => {
    if (!result.ok)
      addToast({ type: 'error', title: t('Cancel failed'), description: result.error });
    void useBotsStore.getState().refreshDelegations();
  });
}

export function retryDelegation(id: string, t: TFunction, mode?: 'resume' | 'restart'): void {
  void window.electronAPI.bots.retryDelegation(id, mode).then((result) => {
    if (!result.ok)
      addToast({ type: 'error', title: t('Retry failed'), description: result.error });
    else if (result.warning) addToast({ type: 'warning', title: result.warning });
    void useBotsStore.getState().refreshDelegations();
  });
}

/** 进行中的委派每 30 秒刷新耗时 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

interface DelegationCardProps {
  /** 委派记录；时间线旧条目找不到记录时只按条目渲染 */
  record?: Delegation;
  entry?: { from: string; to: string; state: DelegationState; summary?: string; at: number };
  /** 已被重试：不再给重试按钮 */
  retried?: boolean;
  bots: Map<string, BotProfile>;
  onOpenConversation: (conversationId: string, title: string) => void;
}

/** 委派卡片：发起人 → 目标、任务、状态与耗时、结果摘要，按状态给取消 / 重试 / 查看过程 */
export function DelegationCard({
  record,
  entry,
  retried,
  bots,
  onOpenConversation,
}: DelegationCardProps) {
  const { t } = useI18n();
  const state = record?.state ?? entry?.state ?? 'queued';
  const now = useNow(isActiveDelegation(state));
  const from = bots.get(record?.parentBotId ?? entry?.from ?? '');
  const to = bots.get(record?.targetBotId ?? entry?.to ?? '');
  const actions = delegationActions(state);
  const presence = useDelegationPresence(record);
  const active = presence && isActiveDelegation(state);
  const summary = record
    ? state === 'completed'
      ? record.result
      : failureText(record, t)
    : entry?.summary;
  const title = t('{{from}} → {{to}} · Delegation', {
    from: from?.name ?? t('Deleted member'),
    to: to?.name ?? t('Deleted member'),
  });
  return (
    <div className="max-w-lg rounded-xl border bg-card px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5 whitespace-nowrap text-muted-foreground text-xs">
        <BotAvatar bot={from} size="xs" />
        <span className="text-foreground">{from?.name ?? t('Deleted member')}</span>
        <span>→</span>
        <BotAvatar bot={to} size="xs" presence={presence?.state} />
        <span className="text-foreground">{to?.name ?? t('Deleted member')}</span>
        <span>· {t('Delegation')}</span>
        {active ? (
          <PresenceChip info={presence} />
        ) : (
          <DelegationBadge state={state} interrupted={record?.failure === 'interrupted'} />
        )}
        {record && <span>{formatElapsed((record.finishedAt ?? now) - record.createdAt)}</span>}
        <span className="flex-1" />
        <span>{timeOf(entry?.at ?? record?.createdAt ?? now)}</span>
      </div>
      {record?.task && <div className="mt-1.5 line-clamp-3 text-sm">{record.task}</div>}
      {record?.check && <CheckBadge check={record.check} className="mt-1.5" />}
      {summary && (
        <div className="mt-1.5 line-clamp-4 whitespace-pre-wrap text-muted-foreground text-xs">
          {summary}
        </div>
      )}
      {record && (
        <div className="mt-2 flex justify-end gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onOpenConversation(record.childConversationId, title)}
          >
            {t('View process')}
          </Button>
          {actions.cancel && (
            <Button size="xs" variant="outline" onClick={() => cancelDelegation(record.id, t)}>
              {t('Cancel')}
            </Button>
          )}
          {actions.retry && !retried && (
            <Button size="xs" variant="outline" onClick={() => retryDelegation(record.id, t)}>
              {t('Retry')}
            </Button>
          )}
          {actions.resumeOrRestart && !retried && (
            <>
              <Button
                size="xs"
                variant="outline"
                onClick={() => retryDelegation(record.id, t, 'resume')}
              >
                {t('Continue')}
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => retryDelegation(record.id, t, 'restart')}
              >
                {t('Start over')}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
