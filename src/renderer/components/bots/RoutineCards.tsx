import { describeCron } from '@shared/bots/cron';
import type { BotRoutine, BotRoutineBlock, BotRoutineResult } from '@shared/types/bot';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { addToast } from '@/components/ui/toast';
import { type TFunction, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useBotsStore } from '@/stores/bots';
import type { RoutineAlert } from '@/stores/bots/routines';
import { BotAvatar } from './BotAvatar';
import { chatTitle } from './botText';

export function routineErrorText(error: string, t: TFunction, reason?: string): string {
  switch (error) {
    case 'invalid':
      return t(
        'Check the title, prompt and schedule, and that the member is still in the target chat.'
      );
    case 'not-found':
      return t('This routine no longer exists.');
    case 'unavailable':
      return t('The member or target chat is archived or unavailable.');
    case 'disabled':
      return t('Bot mode is off.');
    case 'acl':
      return blockText('acl', t);
    case 'not-approved':
      return t('Approve this routine before running it. You can still do a dry run.');
    case 'busy':
      return t('This routine is already running.');
    case 'blocked':
      return reason
        ? blockText(reason as BotRoutineBlock, t)
        : t('This routine is blocked. Fix the problem and enable it again.');
    default:
      return error;
  }
}

export function blockText(reason: BotRoutineBlock | undefined, t: TFunction): string {
  switch (reason) {
    case 'executor-missing':
      return t('The member who runs it was deleted.');
    case 'executor-archived':
      return t('The member who runs it is archived.');
    case 'chat-missing':
      return t('The target chat no longer exists.');
    case 'chat-archived':
      return t('The target chat is archived.');
    case 'not-in-chat':
      return t('The member who runs it is no longer in the target chat.');
    case 'acl':
      return t('Delegation permissions do not allow that member to run it.');
    default:
      return t('This routine is blocked. Fix the problem and enable it again.');
  }
}

export function resultText(result: BotRoutineResult | undefined, t: TFunction): string {
  switch (result) {
    case 'ok':
      return '✓';
    case 'error':
      return t('Error');
    case 'budget':
      return t('Over budget');
    case 'skipped-busy':
      return t('Skipped (still running)');
    case 'interrupted':
      return t('Interrupted');
    case 'blocked':
      return t('Blocked');
    case 'skipped':
      return t('Skipped');
    default:
      return t('Running');
  }
}

/** 批准 / 拒绝 / 恢复（重新启用）/ 试运行，失败统一 toast */
export function useRoutineActions() {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const wrap = async (
    title: string,
    task: () => Promise<{ ok: true } | { ok: false; error: string; reason?: string }>,
    success?: string
  ) => {
    setBusy(true);
    try {
      const result = await task();
      if (!result.ok)
        addToast({
          type: 'error',
          title,
          description: routineErrorText(result.error, t, result.reason),
        });
      else if (success) addToast({ type: 'success', title: success });
    } finally {
      setBusy(false);
    }
  };
  const api = window.electronAPI.bots.routines;
  return {
    busy,
    review: (routine: BotRoutine, approve: boolean) =>
      wrap(t('Routine not saved'), () =>
        api.review({ botId: routine.botId, id: routine.id, approve })
      ),
    resume: (routine: BotRoutine) =>
      wrap(t('Routine not saved'), async () => {
        const result = await api.save({
          botId: routine.botId,
          id: routine.id,
          title: routine.title,
          prompt: routine.prompt,
          schedule: routine.schedule,
          chatId: routine.chatId,
          enabled: true,
        });
        // 依赖仍不满足时 Main 会立即再次阻塞
        return result.ok && result.routine.status === 'blocked'
          ? { ok: false, error: 'blocked', reason: result.routine.blockedReason }
          : result;
      }),
    run: (routine: BotRoutine, dryRun: boolean) =>
      wrap(
        t('Routine did not run'),
        () => api.runNow({ botId: routine.botId, id: routine.id, dryRun }),
        dryRun ? t('Dry run started') : t('Routine started')
      ),
  };
}

function RoutineSummary({ routine }: { routine: BotRoutine }) {
  const { t, locale } = useI18n();
  const bots = useBotsStore((s) => s.bots);
  const executor = routine.doneBy ? bots.find((bot) => bot.id === routine.doneBy) : undefined;
  return (
    <>
      <div className="mt-2 font-medium text-sm">{routine.title}</div>
      <div className="mt-0.5 text-muted-foreground text-xs">
        {describeCron(routine.schedule, locale)}
        {routine.doneBy
          ? ` · ${t('Done by {{name}}', { name: executor?.name ?? t('Deleted member') })}`
          : ''}
      </div>
      <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs">{routine.prompt}</div>
    </>
  );
}

/** 收件箱：待批准的提议 / 被阻塞的例程 */
export function RoutineAlertCard({ alert }: { alert: RoutineAlert }) {
  const { t } = useI18n();
  const bots = useBotsStore((s) => s.bots);
  const chats = useBotsStore((s) => s.chats);
  const setView = useBotsStore((s) => s.setView);
  const { busy, review, resume, run } = useRoutineActions();
  const { routine } = alert;
  const owner = bots.find((bot) => bot.id === routine.botId);
  const chat = chats.find((item) => item.id === routine.chatId);
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <BotAvatar bot={owner} size="sm" />
        <span className="text-foreground">{owner?.name ?? t('Deleted member')}</span>
        {chat?.kind === 'group' && <span>· {chatTitle(chat, bots, t)}</span>}
        <RoutineBadge routine={routine} />
      </div>
      <RoutineSummary routine={routine} />
      {alert.kind === 'blocked' && (
        <div className="mt-1 text-destructive text-xs">{blockText(routine.blockedReason, t)}</div>
      )}
      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">
        {chat && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setView({ kind: 'chat', chatId: chat.id })}
          >
            {t('Go to chat')}
          </Button>
        )}
        {alert.kind === 'approval' ? (
          <>
            <Button size="xs" variant="outline" disabled={busy} onClick={() => run(routine, true)}>
              {t('Dry run')}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => review(routine, false)}
            >
              {t('Reject')}
            </Button>
            <Button size="xs" disabled={busy} onClick={() => review(routine, true)}>
              {t('Approve')}
            </Button>
          </>
        ) : (
          <Button size="xs" disabled={busy} onClick={() => resume(routine)}>
            {t('Enable again')}
          </Button>
        )}
      </div>
    </div>
  );
}

export function RoutineBadge({ routine }: { routine: BotRoutine }) {
  const { t } = useI18n();
  const [label, tone] =
    routine.status === 'draft'
      ? [t('Pending approval'), 'bg-warning/20 text-warning']
      : routine.status === 'blocked'
        ? [t('Blocked'), 'bg-destructive/15 text-destructive']
        : routine.status === 'paused'
          ? [t('Paused'), 'bg-muted text-muted-foreground']
          : [t('Enabled'), 'bg-success/15 text-success'];
  return <span className={cn('rounded px-1.5 text-[11px]', tone)}>{label}</span>;
}

/** 群时间线里成员提议 / 改动例行任务的 system 条目：仍待批准时可直接批准 / 拒绝 / 试运行 */
export function RoutineProposalCard({
  text,
  target,
}: {
  text: string;
  target: { botId: string; id: string };
}) {
  const { t } = useI18n();
  const routine = useBotsStore((s) =>
    s.routines.find((item) => item.id === target.id && item.botId === target.botId)
  );
  const { busy, review, run } = useRoutineActions();
  return (
    <div className="w-full max-w-md self-center rounded-xl border bg-card px-3 py-2 text-xs">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="min-w-0 flex-1">{text}</span>
        {routine ? (
          <RoutineBadge routine={routine} />
        ) : (
          <span className="text-[11px]">{t('Routine removed')}</span>
        )}
      </div>
      {routine && <RoutineSummary routine={routine} />}
      {routine?.status === 'draft' && (
        <div className="mt-2 flex justify-end gap-1.5">
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => run(routine, true)}>
            {t('Dry run')}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => review(routine, false)}
          >
            {t('Reject')}
          </Button>
          <Button size="xs" disabled={busy} onClick={() => review(routine, true)}>
            {t('Approve')}
          </Button>
        </div>
      )}
    </div>
  );
}
