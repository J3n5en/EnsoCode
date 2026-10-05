import { describeCron } from '@shared/bots/cron';
import {
  type SimpleSchedule,
  simpleSchedule,
  simpleScheduleCron,
} from '@shared/bots/routineSchedule';
import {
  type BotRoutine,
  type BotRoutineRun,
  type BotRoutineTrigger,
  isRoutineApproved,
} from '@shared/types/bot';
import { FlaskConical, History, Loader2, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { addToast } from '@/components/ui/toast';
import { type TFunction, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';
import { useBotsStore } from '@/stores/bots';
import { chatRoutines } from '@/stores/bots/groupBoard';
import {
  ROUTINE_PRESETS,
  type RoutineDraftIssue,
  routineDraftIssue,
  routineTargets,
  schedulePreview,
} from '@/stores/bots/routines';
import { FieldLabel } from './BotFields';
import { chatTitle } from './botText';
import {
  blockText,
  RoutineBadge,
  resultText,
  routineErrorText,
  useRoutineActions,
} from './RoutineCards';

const stamp = (at: number) =>
  new Date(at).toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

function issueText(issue: RoutineDraftIssue, t: TFunction): string {
  switch (issue) {
    case 'title':
      return t('Enter a title.');
    case 'prompt':
      return t('Enter what the member should do.');
    case 'schedule':
      return t('Invalid cron expression (minute hour day month weekday).');
    case 'chat':
      return t('Choose a target chat.');
  }
}

function triggerText(trigger: BotRoutineTrigger, t: TFunction): string {
  switch (trigger) {
    case 'scheduled':
      return t('Scheduled');
    case 'manual':
      return t('Manual');
    case 'catchup':
      return t('Catch-up');
    case 'dry-run':
      return t('Dry run');
  }
}

function duration(run: BotRoutineRun): string {
  if (run.finishedAt === undefined) return '';
  const seconds = Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000));
  return seconds < 60 ? ` · ${seconds}s` : ` · ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * 例行任务列表：状态、审批、启停、立即运行 / 试运行、执行历史、编辑、删除。
 * 传 botId = 成员资料「例行」页签；传 chatId = 群信息里本群的例行任务（跨成员，显示成员名）。
 */
export function RoutineList({
  botId,
  chatId,
}: { botId: string; chatId?: never } | { botId?: never; chatId: string }) {
  const { t, locale } = useI18n();
  const chats = useBotsStore((s) => s.chats);
  const bots = useBotsStore((s) => s.bots);
  const [routines, setRoutines] = useState<BotRoutine[] | null>(null);
  const [editing, setEditing] = useState<BotRoutine | 'new' | null>(null);
  const [deleting, setDeleting] = useState<BotRoutine | null>(null);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const actions = useRoutineActions();

  const refresh = useCallback(async () => {
    const result = await window.electronAPI.bots.routines
      .list(botId ? { botId } : {})
      .catch(() => null);
    const list = result?.ok ? result.routines : [];
    setRoutines(chatId ? chatRoutines(list, chatId) : list);
  }, [botId, chatId]);

  useEffect(() => {
    setRoutines(null);
    void refresh();
    return window.electronAPI.bots.onEvent((event) => {
      if (event.kind === 'routine') void refresh();
    });
  }, [refresh]);

  const toggle = async (routine: BotRoutine, enabled: boolean) => {
    const { id, title, prompt, schedule } = routine;
    const result = await window.electronAPI.bots.routines.save({
      botId: routine.botId,
      id,
      title,
      prompt,
      schedule,
      chatId: routine.chatId,
      enabled,
    });
    if (!result.ok)
      addToast({
        type: 'error',
        title: t('Routine not saved'),
        description: routineErrorText(result.error, t),
      });
    else if (result.routine.status === 'blocked')
      addToast({
        type: 'error',
        title: t('Routine blocked'),
        description: blockText(result.routine.blockedReason, t),
      });
    void refresh();
  };

  const remove = async (routine: BotRoutine) => {
    setDeleting(null);
    const result = await window.electronAPI.bots.routines.remove({
      botId: routine.botId,
      id: routine.id,
    });
    if (!result.ok)
      addToast({
        type: 'error',
        title: t('Routine not deleted'),
        description: routineErrorText(result.error, t),
      });
    void refresh();
  };

  if (routines === null) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  const name = (id: string) => bots.find((bot) => bot.id === id)?.name ?? t('Deleted member');
  return (
    <div className="space-y-1.5">
      <Button size="xs" variant="outline" onClick={() => setEditing('new')}>
        <Plus />
        {t('New routine')}
      </Button>
      {routines.length === 0 && (
        <p className="text-muted-foreground text-xs">{t('No routines yet')}</p>
      )}
      {routines.map((routine) => {
        const chat = chats.find((item) => item.id === routine.chatId);
        const draft = routine.status === 'draft';
        const runnable =
          isRoutineApproved(routine) &&
          (routine.status === 'enabled' || routine.status === 'paused');
        const target = chat
          ? t('Posts to {{chat}}', { chat: chatTitle(chat, bots, t) })
          : t('Target chat missing');
        return (
          <div
            key={routine.id}
            className={cn(
              'rounded-lg border bg-card px-2.5 py-2 text-xs',
              routine.status === 'paused' && 'opacity-70'
            )}
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium text-sm">{routine.title}</span>
              <RoutineBadge routine={routine} />
              {!draft && (
                <Switch
                  checked={routine.status === 'enabled'}
                  onCheckedChange={(enabled) => void toggle(routine, enabled)}
                  title={routine.status === 'enabled' ? t('Enabled') : t('Paused')}
                />
              )}
            </div>
            <div className="mt-0.5 text-muted-foreground">
              {[
                chatId ? name(routine.botId) : '',
                describeCron(routine.schedule, locale),
                routine.doneBy ? t('Done by {{name}}', { name: name(routine.doneBy) }) : '',
                chatId ? '' : target,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
            {routine.proposedBy && draft && (
              <div className="mt-0.5 text-warning">
                {t('Proposed by {{name}}, waiting for your approval', {
                  name: name(routine.proposedBy),
                })}
              </div>
            )}
            {routine.status === 'blocked' && (
              <div className="mt-0.5 text-destructive">{blockText(routine.blockedReason, t)}</div>
            )}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-muted-foreground">
              <span>
                {routine.lastRunAt
                  ? t('Last run {{time}} · {{result}}', {
                      time: stamp(routine.lastRunAt),
                      result: resultText(routine.lastResult, t),
                    })
                  : t('Never run')}
              </span>
              {routine.missed ? (
                <span className="rounded bg-warning/20 px-1.5 text-warning">
                  {t('Missed {{n}} times', { n: routine.missed })}
                </span>
              ) : null}
              {!routine.catchUp && <span>{t('No catch-up')}</span>}
            </div>
            <div className="mt-1.5 flex flex-wrap justify-end gap-1">
              {draft ? (
                <>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={actions.busy}
                    onClick={() => void actions.review(routine, false)}
                  >
                    {t('Reject')}
                  </Button>
                  <Button
                    size="xs"
                    disabled={actions.busy}
                    onClick={() => void actions.review(routine, true)}
                  >
                    {t('Approve')}
                  </Button>
                </>
              ) : (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!runnable || actions.busy}
                  onClick={() => void actions.run(routine, false)}
                >
                  <Play />
                  {t('Run now')}
                </Button>
              )}
              <Button
                size="xs"
                variant="ghost"
                disabled={actions.busy}
                title={t('Run once without affecting the schedule')}
                onClick={() => void actions.run(routine, true)}
              >
                <FlaskConical />
                {t('Dry run')}
              </Button>
              <Button
                size="xs"
                variant={historyOf === routine.id ? 'secondary' : 'ghost'}
                onClick={() => setHistoryOf(historyOf === routine.id ? null : routine.id)}
              >
                <History />
                {t('History')}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setEditing(routine)}>
                <Pencil />
                {t('Edit')}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setDeleting(routine)}>
                <Trash2 />
                {t('Delete')}
              </Button>
            </div>
            {historyOf === routine.id && <RoutineHistory routine={routine} />}
          </div>
        );
      })}

      {editing && (
        <RoutineEditor
          botId={botId}
          chatId={chatId}
          routine={editing === 'new' ? undefined : editing}
          onClose={(saved) => {
            setEditing(null);
            if (saved) void refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('Delete routine "{{title}}"?', { title: deleting?.title ?? '' })}
        description={t('It will no longer run. This cannot be undone.')}
        confirmLabel={t('Delete')}
        onConfirm={() => deleting && void remove(deleting)}
      />
    </div>
  );
}

/** 最近 20 次运行：时间、触发方式、结果、耗时、跳到聊天、错误 */
function RoutineHistory({ routine }: { routine: BotRoutine }) {
  const { t } = useI18n();
  const setView = useBotsStore((s) => s.setView);
  const [runs, setRuns] = useState<BotRoutineRun[] | null>(null);
  const { botId, id } = routine;
  useEffect(() => {
    let active = true;
    const load = () =>
      void window.electronAPI.bots.routines
        .runs({ botId, id })
        .then((result) => active && setRuns(result.ok ? result.runs : []))
        .catch(() => active && setRuns([]));
    load();
    const off = window.electronAPI.bots.onEvent((event) => {
      if (event.kind === 'routine') load();
    });
    return () => {
      active = false;
      off();
    };
  }, [botId, id]);
  if (runs === null) return <Loader2 className="mt-2 h-3.5 w-3.5 animate-spin" />;
  if (runs.length === 0) return <p className="mt-2 text-muted-foreground">{t('No runs yet')}</p>;
  return (
    <ul className="mt-2 space-y-1 border-t pt-2">
      {runs.map((run) => (
        <li key={run.runId} className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
          <span className="tabular-nums">{stamp(run.startedAt)}</span>
          <span>{triggerText(run.trigger, t)}</span>
          <span
            className={cn(
              run.result === 'ok' && 'text-success',
              (run.result === 'error' || run.result === 'blocked' || run.result === 'budget') &&
                'text-destructive'
            )}
          >
            {resultText(run.result, t)}
            {duration(run)}
          </span>
          {run.conversationId && (
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => setView({ kind: 'chat', chatId: run.chatId })}
            >
              {t('Open chat')}
            </button>
          )}
          {run.error && (
            <span className="w-full truncate text-destructive" title={run.error}>
              {run.result === 'blocked' ? blockText(run.error as never, t) : run.error}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

const WEEKDAY_KEYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number) => String(n).padStart(2, '0');

/** 简单选择器：每天 / 工作日 / 每周几 + 时间；高级模式直接写 cron */
function SchedulePicker({ value, onChange }: { value: string; onChange: (cron: string) => void }) {
  const { t, locale } = useI18n();
  const initial = simpleSchedule(value);
  const [advanced, setAdvanced] = useState(!initial);
  const [simple, setSimple] = useState<SimpleSchedule>(
    initial ?? { kind: 'daily', days: [1], hour: 9, minute: 0 }
  );
  const preview = schedulePreview(value, locale, Date.now());
  const update = (next: SimpleSchedule) => {
    setSimple(next);
    const cron = simpleScheduleCron(next);
    if (cron) onChange(cron);
  };
  const kinds = [
    { value: 'daily', label: t('Every day') },
    { value: 'weekdays', label: t('Weekdays') },
    { value: 'weekly', label: t('Every week on') },
  ];
  const toggleMode = () => {
    if (!advanced) return setAdvanced(true);
    // 切回简单模式：当前 cron 能表达就沿用，否则用上次的简单设置覆盖
    const next = simpleSchedule(value);
    if (next) setSimple(next);
    else update(simple);
    setAdvanced(false);
  };
  return (
    <div>
      <FieldLabel
        hint={advanced ? t('cron: minute hour day month weekday, local time') : undefined}
        action={
          <Button size="xs" variant="ghost" onClick={toggleMode}>
            {advanced ? t('Simple') : t('Advanced (cron)')}
          </Button>
        }
      >
        {t('Schedule')}
      </FieldLabel>
      {advanced ? (
        <Input
          className="font-mono"
          value={value}
          placeholder="0 9 * * 1-5"
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <Select
            items={kinds}
            value={simple.kind}
            onValueChange={(kind) =>
              update({
                ...simple,
                kind: kind as SimpleSchedule['kind'],
                days: simple.days.length ? simple.days : [1],
              })
            }
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
              {kinds.map((kind) => (
                <SelectItem key={kind.value} value={kind.value}>
                  {kind.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {simple.kind === 'weekly' &&
            WEEKDAY_KEYS.map((key, day) => {
              const on = simple.days.includes(day);
              return (
                <Button
                  key={key}
                  size="xs"
                  variant={on ? 'default' : 'outline'}
                  onClick={() => {
                    const days = on
                      ? simple.days.filter((item) => item !== day)
                      : [...simple.days, day].sort();
                    if (days.length) update({ ...simple, days });
                  }}
                >
                  {t(key)}
                </Button>
              );
            })}
          <Input
            type="time"
            className="w-28"
            value={`${pad(simple.hour)}:${pad(simple.minute)}`}
            onChange={(event) => {
              const [hour, minute] = event.target.value.split(':').map(Number);
              if (Number.isInteger(hour) && Number.isInteger(minute))
                update({ ...simple, hour, minute });
            }}
          />
        </div>
      )}
      <p className={cn('mt-1 text-xs', preview ? 'text-muted-foreground' : 'text-destructive')}>
        {preview
          ? `${preview.description} · ${
              preview.next ? t('Next run {{time}}', { time: stamp(preview.next) }) : t('Never runs')
            }`
          : issueText('schedule', t)}
      </p>
    </div>
  );
}

/** 群模式（fixedChatId）：目标聊天固定为本群，新建时选本群成员，编辑时成员不可改 */
function RoutineEditor({
  botId: memberId,
  chatId: fixedChatId,
  routine,
  onClose,
}: {
  botId?: string;
  chatId?: string;
  routine?: BotRoutine;
  onClose: (saved: boolean) => void;
}) {
  const { t } = useI18n();
  const chats = useBotsStore((s) => s.chats);
  const bots = useBotsStore((s) => s.bots);
  const members = useMemo(() => {
    const chat = chats.find((item) => item.id === fixedChatId);
    return (chat?.members ?? []).flatMap((id) => {
      const bot = bots.find((item) => item.id === id && item.archivedAt === undefined);
      return bot ? [bot] : [];
    });
  }, [chats, bots, fixedChatId]);
  const [botId, setBotId] = useState(routine?.botId ?? memberId ?? members[0]?.id ?? '');
  const targets = useMemo(() => routineTargets(chats, botId), [chats, botId]);
  const [title, setTitle] = useState(routine?.title ?? '');
  const [prompt, setPrompt] = useState(routine?.prompt ?? '');
  const [schedule, setSchedule] = useState(routine?.schedule ?? ROUTINE_PRESETS[0]);
  const [chatId, setChatId] = useState(routine?.chatId ?? fixedChatId ?? targets[0]?.id ?? '');
  const [doneBy, setDoneBy] = useState(routine?.doneBy ?? '');
  const [catchUp, setCatchUp] = useState(routine?.catchUp ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chatLabel = (id: string) => {
    const chat = chats.find((item) => item.id === id);
    if (!chat) return t('Target chat missing');
    return `${chatTitle(chat, bots, t)} · ${chat.kind === 'group' ? t('Group chat') : t('Private chat')}`;
  };
  const options =
    targets.some((chat) => chat.id === chatId) || !chatId
      ? targets.map((chat) => chat.id)
      : [chatId, ...targets.map((chat) => chat.id)];
  // 执行者：目标聊天里除归属成员外的未归档成员；委派 ACL 由 Main 校验
  const executors = useMemo(() => {
    const chat = chats.find((item) => item.id === chatId);
    return (chat?.members ?? []).flatMap((id) => {
      const bot = bots.find((item) => item.id === id && item.archivedAt === undefined);
      return bot && bot.id !== botId ? [bot] : [];
    });
  }, [chats, bots, chatId, botId]);
  const executorItems = [
    { value: '', label: t('The member itself') },
    ...executors.map((bot) => ({ value: bot.id, label: bot.name })),
  ];
  const executor = executors.some((bot) => bot.id === doneBy) ? doneBy : '';

  const save = async () => {
    if (!botId) return setError(t('Choose a member.'));
    const issue = routineDraftIssue({ title, prompt, schedule, chatId });
    if (issue) return setError(issueText(issue, t));
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.bots.routines.save({
        botId,
        title,
        prompt,
        schedule,
        chatId,
        catchUp,
        doneBy: executor || null,
        ...(routine ? { id: routine.id, enabled: routine.status !== 'paused' } : {}),
      });
      if (result.ok) onClose(true);
      else setError(routineErrorText(result.error, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent className="max-h-[85vh] max-w-lg">
        <DialogHeader>
          <DialogTitle>{routine ? t('Edit routine') : t('New routine')}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div>
            <FieldLabel>{t('Routine title')}</FieldLabel>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div>
            <FieldLabel hint={t('Sent to the member as the task each time it runs')}>
              {t('Prompt')}
            </FieldLabel>
            <Textarea rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </div>
          <SchedulePicker value={schedule} onChange={setSchedule} />
          {fixedChatId ? (
            <div>
              <FieldLabel>{t('Member')}</FieldLabel>
              <Select
                items={members.map((bot) => ({ value: bot.id, label: bot.name }))}
                value={botId}
                disabled={Boolean(routine)}
                onValueChange={(value) => setBotId(value as string)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                  {members.map((bot) => (
                    <SelectItem key={bot.id} value={bot.id}>
                      {bot.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : (
            <div>
              <FieldLabel>{t('Target chat')}</FieldLabel>
              {options.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  {t('This member is not in any chat yet. Start a private chat first.')}
                </p>
              ) : (
                <Select
                  items={options.map((id) => ({ value: id, label: chatLabel(id) }))}
                  value={chatId}
                  onValueChange={(value) => setChatId(value as string)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                    {options.map((id) => (
                      <SelectItem key={id} value={id}>
                        {chatLabel(id)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              )}
            </div>
          )}
          {executors.length > 0 && (
            <div>
              <FieldLabel hint={t('Another member of the target chat runs it, as a delegation')}>
                {t('Done by')}
              </FieldLabel>
              <Select
                items={executorItems}
                value={executor}
                onValueChange={(value) => setDoneBy(value as string)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                  {executorItems.map((item) => (
                    <SelectItem key={item.value || 'self'} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <FieldLabel
              hint={t(
                'If the app was closed at the scheduled time, run the latest missed one once on startup'
              )}
            >
              {t('Catch up missed runs')}
            </FieldLabel>
            <Switch checked={catchUp} onCheckedChange={setCatchUp} />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onClose(false)}>
            {t('Cancel')}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            {busy && <Loader2 className="animate-spin" />}
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
