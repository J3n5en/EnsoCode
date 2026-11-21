import type { BackgroundTaskInfo } from '@shared/types/agent';
import { ArrowUpRight, Filter, Moon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  IdleActions,
  KeepLine,
  StopTaskButton,
  shortSpan,
  stopBackgroundTask,
  TaskNode,
  TaskStatusBadge,
  useNow,
} from '@/components/chat/backgroundTaskUi';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useBackgroundTasksView } from '@/stores/backgroundTasksView';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import {
  collectTaskGroups,
  isIdleTask,
  selectionKey,
  stopTargets,
  type TaskGroup,
} from './overview';

const GRID = 'grid grid-cols-[16px_22px_minmax(0,1fr)_136px_64px_112px] items-center gap-x-3';

/** 所有会话在跑的后台任务：按会话分组、多选、只看疑似闲置、批量停止（需确认）；未打开的会话同样能停 */
export function BackgroundTasksPage() {
  const { t } = useI18n();
  const conversations = useSessionsStore((state) => state.conversations);
  const projects = useSettingsStore((state) => state.projects);
  const idleOnly = useBackgroundTasksView((state) => state.idleOnly);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const groups = useMemo(() => collectTaskGroups(conversations), [conversations]);
  const shown = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          tasks: idleOnly ? group.tasks.filter(isIdleTask) : group.tasks,
        }))
        .filter((group) => group.tasks.length > 0),
    [groups, idleOnly]
  );
  const total = groups.reduce((sum, group) => sum + group.tasks.length, 0);
  const idle = groups.reduce((sum, group) => sum + group.tasks.filter(isIdleTask).length, 0);
  const targets = stopTargets(shown, selected);
  const projectName = (id?: string) => projects.find((project) => project.id === id)?.name;

  // 任务结束后从勾选里拿掉，计数与确认清单只认还在跑的
  useEffect(() => {
    const alive = new Set(
      groups.flatMap((group) =>
        group.tasks.map((task) => selectionKey(group.conversationId, task.taskId))
      )
    );
    setSelected((previous) =>
      [...previous].every((key) => alive.has(key))
        ? previous
        : new Set([...previous].filter((key) => alive.has(key)))
    );
  }, [groups]);
  useEffect(() => {
    if (targets.length === 0) setConfirming(false);
  }, [targets.length]);

  const toggle = (keys: string[], on: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });

  return (
    <div
      data-enso="background-tasks-page"
      className="absolute inset-0 z-10 overflow-y-auto bg-background"
    >
      <div className="relative px-8 pt-6 pb-8">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[18px] font-semibold">{t('Background tasks')}</h1>
          {total > 0 && (
            <span className="text-[12.5px] text-muted-foreground">
              {t('{{count}} running', { count: total })}
              {idle > 0 && (
                <>
                  {' · '}
                  <span className="text-warning">
                    {t('{{count}} suspected idle', { count: idle })}
                  </span>
                </>
              )}
              {' · '}
              {t('from {{count}} sessions', { count: groups.length })}
            </span>
          )}
        </div>
        <div className="mt-4 flex items-center gap-2">
          <Segmented idleOnly={idleOnly} total={total} idle={idle} />
          <span className="flex-1" />
          {targets.length > 0 && (
            <>
              <span className="text-xs text-muted-foreground tabular-nums">
                {t('{{count}} selected', { count: targets.length })}
              </span>
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => setSelected(new Set())}
              >
                {t('Clear selection')}
              </Button>
              <Button
                size="xs"
                variant="destructive"
                data-enso="background-tasks-stop-selected"
                className={cn(confirming && 'ring-2 ring-destructive/25')}
                onClick={() => setConfirming(true)}
              >
                {t('Stop selected')}
              </Button>
            </>
          )}
        </div>
        {total === 0 ? (
          <div className="mt-10 text-center text-sm text-muted-foreground">
            {t('No background tasks are running')}
          </div>
        ) : (
          <>
            <div className={cn(GRID, 'mt-3 px-[13px] pb-1.5 text-[11px] text-subtle-foreground')}>
              <span />
              <span />
              <span>{t('Command')}</span>
              <span>{t('Status')}</span>
              <span>{t('Running for')}</span>
              <span />
            </div>
            <div className="flex flex-col gap-2.5">
              {shown.map((group) => (
                <GroupCard
                  key={group.conversationId}
                  group={group}
                  projectName={group.projectId ? projectName(group.projectId) : undefined}
                  selected={selected}
                  onToggle={toggle}
                />
              ))}
            </div>
            {idleOnly && (
              <div className="mt-3 flex items-center gap-1.5 text-[11px] text-subtle-foreground">
                <Filter className="size-3" />
                {t(
                  'Rule: no new output for 30 minutes, no active connections on listening ports, CPU near 0, all at once. Kept tasks are excluded for an hour.'
                )}
              </div>
            )}
          </>
        )}
        {confirming && targets.length > 0 && (
          <ConfirmStop
            targets={targets}
            onCancel={() => setConfirming(false)}
            onConfirm={() => {
              for (const target of targets)
                stopBackgroundTask(target.conversationId, target.taskId);
              setSelected(new Set());
              setConfirming(false);
            }}
          />
        )}
      </div>
    </div>
  );
}

function Segmented({ idleOnly, total, idle }: { idleOnly: boolean; total: number; idle: number }) {
  const { t } = useI18n();
  const item = 'flex h-6 items-center gap-1 rounded-md px-2.5 text-xs transition-colors';
  const on = 'bg-background text-foreground shadow-xs dark:bg-foreground/10';
  const set = (value: boolean) => useBackgroundTasksView.setState({ idleOnly: value });
  return (
    <div className="inline-flex rounded-lg bg-muted p-0.5 text-muted-foreground">
      <button type="button" className={cn(item, !idleOnly && on)} onClick={() => set(false)}>
        {t('All')} <span className="tabular-nums opacity-70">{total}</span>
      </button>
      <button
        type="button"
        data-enso="background-tasks-idle-only"
        className={cn(item, idleOnly && on)}
        onClick={() => set(true)}
      >
        <Moon className="size-3 text-warning" />
        {t('Suspected idle only')} <span className="tabular-nums opacity-70">{idle}</span>
      </button>
    </div>
  );
}

function GroupCard({
  group,
  projectName,
  selected,
  onToggle,
}: {
  group: TaskGroup;
  projectName?: string;
  selected: ReadonlySet<string>;
  onToggle: (keys: string[], on: boolean) => void;
}) {
  const { t } = useI18n();
  const selectConversation = useSessionsStore((state) => state.selectConversation);
  const keys = group.tasks.map((task) => selectionKey(group.conversationId, task.taskId));
  const all = keys.every((key) => selected.has(key));
  const some = keys.some((key) => selected.has(key));
  return (
    <div
      data-enso="background-tasks-group"
      className="overflow-hidden rounded-xl border bg-card shadow-xs"
    >
      <div className="flex items-center gap-3 border-b border-border/60 px-3 py-2">
        <Checkbox
          checked={all}
          indeterminate={some && !all}
          onCheckedChange={(checked) => onToggle(keys, checked === true)}
          aria-label={t('Select all tasks of this session')}
        />
        <span className="min-w-0 truncate text-[13px] font-medium">
          {group.title || t('New conversation')}
        </span>
        {projectName && (
          <span className="shrink-0 rounded bg-muted px-1.5 text-[11px] text-muted-foreground">
            {projectName}
          </span>
        )}
        {group.unopened && (
          <span className="shrink-0 text-[11px] text-subtle-foreground">
            {t('Session not open')}
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => selectConversation(group.conversationId)}
          className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
        >
          {t('Open session')}
          <ArrowUpRight className="size-3.5" />
        </button>
      </div>
      <div className="divide-y divide-border/50">
        {group.tasks.map((task) => (
          <ListRow
            key={task.taskId}
            conversationId={group.conversationId}
            task={task}
            checked={selected.has(selectionKey(group.conversationId, task.taskId))}
            onCheck={(on) => onToggle([selectionKey(group.conversationId, task.taskId)], on)}
          />
        ))}
      </div>
    </div>
  );
}

function ListRow({
  conversationId,
  task,
  checked,
  onCheck,
}: {
  conversationId: string;
  task: BackgroundTaskInfo;
  checked: boolean;
  onCheck: (on: boolean) => void;
}) {
  const { t } = useI18n();
  const now = useNow();
  return (
    <div
      data-enso="background-tasks-row"
      className={cn(GRID, 'px-3 py-1.5', checked && 'bg-brand/[0.06]')}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onCheck(value === true)}
        aria-label={t('Select task')}
      />
      <TaskNode task={task} />
      <div className="min-w-0">
        <div className="truncate font-mono text-xs text-muted-foreground" title={task.command}>
          {task.command}
        </div>
        <KeepLine task={task} className="mt-0.5" />
      </div>
      <div>
        <TaskStatusBadge task={task} now={now} />
      </div>
      <span className="font-mono text-[11px] text-muted-foreground/80 tabular-nums">
        {shortSpan(now - task.startedAt)}
      </span>
      <div className="flex items-center justify-end gap-0.5">
        {isIdleTask(task) ? (
          <IdleActions sessionId={conversationId} taskId={task.taskId} />
        ) : (
          <StopTaskButton onStop={() => stopBackgroundTask(conversationId, task.taskId)} />
        )}
      </div>
    </div>
  );
}

/** 批量停止的轻量确认：非模态，Esc / 点外面取消；列出任务名和所属会话 */
function ConfirmStop({
  targets,
  onCancel,
  onConfirm,
}: {
  targets: ReturnType<typeof stopTargets>;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onCancel();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onCancel]);
  return (
    <div
      ref={ref}
      role="dialog"
      data-enso="background-tasks-confirm"
      className="absolute top-[94px] right-8 z-10 w-[340px] rounded-xl border bg-popover p-3 shadow-float"
    >
      <div className="text-[13px] font-medium">
        {t('Stop {{count}} background tasks?', { count: targets.length })}
      </div>
      <ul className="mt-2 max-h-60 space-y-1 overflow-y-auto">
        {targets.map((target) => (
          <li
            key={selectionKey(target.conversationId, target.taskId)}
            className="flex min-w-0 items-baseline gap-2 text-xs"
          >
            <span className="min-w-0 truncate font-mono text-foreground/85">{target.command}</span>
            <span className="ml-auto shrink-0 text-[11px] text-subtle-foreground">
              {target.unopened
                ? t('{{title}} (not open)', { title: target.sessionTitle || t('New conversation') })
                : target.sessionTitle || t('New conversation')}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex justify-end gap-1.5">
        <Button size="xs" variant="ghost" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button
          size="xs"
          variant="destructive"
          data-enso="background-tasks-confirm-stop"
          onClick={onConfirm}
        >
          {t('Stop {{count}}', { count: targets.length })}
        </Button>
      </div>
    </div>
  );
}
