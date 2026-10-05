import { type LiveState, type LiveStep, liveActivity } from '@shared/bots/liveActivity';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/i18n';
import { toolLabel } from '@/lib/toolLabels';
import { cn } from '@/lib/utils';
import { useBotsStore } from '@/stores/bots';
import { formatElapsed } from '@/stores/bots/delegations';

const STATE_LABELS: Record<Exclude<LiveState, 'queued'>, string> = {
  thinking: 'Thinking',
  typing: 'Writing reply',
  tool: 'Calling tools',
  retrying: 'Retrying',
};

const STEP_LABELS: Record<LiveStep['status'], string> = {
  running: 'Running',
  done: 'Done',
  error: 'Error',
  denied: 'Denied',
  timeout: 'Timed out · denied',
};

const STEP_TONES: Record<LiveStep['status'], string> = {
  running: 'text-primary',
  done: 'text-success',
  error: 'text-destructive',
  denied: 'text-warning',
  timeout: 'text-warning',
};

const duration = (ms: number) =>
  ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : formatElapsed(ms);

/** 成员当前轮：状态 / 排队原因、已运行时长、最近 3 个工具步骤 */
export function BotLiveStatus({
  conversationId,
  leading,
  trailing,
  className,
}: {
  conversationId: string | undefined;
  leading?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  const session = useBotsStore((s) => (conversationId ? s.sessions[conversationId] : undefined));
  const queued = useBotsStore((s) =>
    conversationId ? s.queue.find((item) => item.conversationId === conversationId) : undefined
  );
  const activity = useMemo(() => liveActivity(session, Boolean(queued)), [session, queued]);
  const ticking = Boolean(activity && activity.state !== 'queued');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  const label = !activity
    ? null
    : activity.state !== 'queued'
      ? t(STATE_LABELS[activity.state])
      : queued?.reason === 'capacity'
        ? t('Queued · concurrency limit reached')
        : queued?.reason === 'turn'
          ? t('Queued · waiting for the current turn to finish')
          : t('Queued');

  return (
    <div className={cn('min-w-0 text-muted-foreground text-xs', className)}>
      <div className="flex items-center gap-2">
        {leading}
        {label && <span className="truncate">{label}</span>}
        {ticking && activity?.startedAt !== undefined && (
          <span className="shrink-0 tabular-nums">{formatElapsed(now - activity.startedAt)}</span>
        )}
        {trailing}
      </div>
      {activity && activity.steps.length > 0 && (
        <div className="mt-1 flex flex-col gap-0.5">
          {activity.more > 0 && <span>+{activity.more}</span>}
          {activity.steps.map((step) => {
            const ms =
              step.durationMs ?? (step.startedAt !== undefined ? now - step.startedAt : undefined);
            return (
              <div key={step.id} className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 font-medium text-foreground">
                  {toolLabel(step.name, t)}
                </span>
                {step.detail && <span className="truncate font-mono">{step.detail}</span>}
                <span className={cn('shrink-0', STEP_TONES[step.status])}>
                  {t(
                    step.status === 'timeout' && step.name === 'ask_user'
                      ? 'Timed out · no answer'
                      : STEP_LABELS[step.status]
                  )}
                </span>
                {ms !== undefined && <span className="shrink-0 tabular-nums">{duration(ms)}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
