import { dayKey, shiftDay } from '@shared/secretary/daily';
import type { BackgroundTaskInfo } from '@shared/types/agent';
import type {
  SecretaryDaily,
  SecretaryDailyGroupKey,
  SecretaryDailyItem,
} from '@shared/types/secretary';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Inbox,
  Link2,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { isIdleTask } from '@/components/backgroundTasks/overview';
import {
  idleLabel,
  KeepLine,
  keepBackgroundTask,
  shortSpan,
  stopBackgroundTask,
  taskView,
  useNow,
} from '@/components/chat/backgroundTaskUi';
import { HoverActions } from '@/components/ui/hover-actions';
import { useI18n } from '@/i18n';
import { formatClock } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';

/**
 * 列的顺序与配色照 EnsoCode 的 kanban 插件：色值取自插件 PALETTE，
 * 这里按状态语义分配（蓝=进行中、黄=需要你、绿=完成、红=失败）。
 * 一个会话当天只落一列，派出时间退到卡片上显示，所以没有「新派出」列。
 */
const COLUMNS: {
  key: SecretaryDailyGroupKey;
  title: string;
  dot: string;
  /** 终态时间的前缀；还在跑的列没有终态时间 */
  stamp?: string;
}[] = [
  { key: 'running', title: 'In progress', dot: '#3b82f6' },
  { key: 'stopped', title: 'Stopped', dot: '#64748b', stamp: 'Stopped' },
  { key: 'needsYou', title: 'Needed you', dot: '#f59e0b', stamp: 'Needed you' },
  { key: 'done', title: 'What got done', dot: '#10b981', stamp: 'Completed' },
  { key: 'failed', title: 'Failed or interrupted', dot: '#ef4444', stamp: 'Failed' },
  /** 待办列放当天新增或当天完成的待办：一条待办一张卡，完成的划掉 */
  { key: 'todos', title: 'To-dos', dot: '#a855f7' },
  { key: 'changes', title: 'Settings and capabilities', dot: '#06b6d4' },
];

/** 列：插件的 .col —— 55% muted 底 + 1px 内描边，窄面板纵向堆叠、宽了横排并横向滚动 */
const COL_CLASS =
  'flex-none rounded-lg p-1 pb-1.5 bg-[color-mix(in_oklch,var(--muted)_55%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--border)_60%,transparent)] @[560px]:w-[260px]';
/** 卡片：插件的 .card —— 细边框 + 极浅阴影，悬停加深边框与阴影 */
const CARD_CLASS =
  'rounded-md border border-border bg-card px-2.5 py-2 shadow-[0_1px_2px_0_rgb(0_0_0/0.05)] transition-[border-color,box-shadow] duration-200 hover:border-foreground/15 hover:shadow-[0_1px_3px_0_rgb(0_0_0/0.08)]';
/** 徽标：插件的 .chip —— 18px 高、999 圆角、6% 前景底 */
const CHIP_CLASS =
  'inline-flex h-[18px] max-w-full items-center gap-1 rounded-full bg-foreground/[0.06] px-1.5 font-medium';
/** 卡片顶部的收口按钮：与底部徽标同量级，伪元素把可点区域上下各扩 4px */
const SETTLE_CLASS = cn(
  CHIP_CLASS,
  "relative shrink-0 text-[11px] leading-none text-muted-foreground transition-colors before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] hover:bg-foreground/10 hover:text-foreground"
);
const ACTION_CLASS =
  'flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

/** 同一天只显示时刻，跨天补上日期，免得「派出 22:10」看不出是哪天 */
function stampOf(at: number, day: string, locale: string): string {
  const clock = formatClock(at, locale);
  if (dayKey(at) === day) return clock;
  const date = new Date(at);
  return `${date.getMonth() + 1}/${date.getDate()} ${clock}`;
}

/** 遗留任务一行：疑似闲置给时长与「保留」，保留的给理由；停止不确认 */
function LeftoverRow({
  conversationId,
  task,
}: {
  conversationId: string;
  task: BackgroundTaskInfo;
}) {
  const { t } = useI18n();
  const now = useNow();
  const view = taskView(task);
  return (
    <div
      data-enso="secretary-daily-leftover-task"
      className="flex min-w-0 items-center gap-1.5 py-0.5"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[11px] text-foreground/80" title={task.command}>
          {task.command}
        </div>
        {view === 'idle' ? (
          <div className="text-[10.5px] text-warning">{idleLabel(task, now, t)}</div>
        ) : view === 'kept' ? (
          <KeepLine task={task} className="text-[10.5px]" />
        ) : (
          <div className="text-[10.5px] text-muted-foreground tabular-nums">
            {t('Running for {{duration}}', { duration: shortSpan(now - task.startedAt) })}
          </div>
        )}
      </div>
      {view === 'idle' && (
        <button
          type="button"
          onClick={() => keepBackgroundTask(conversationId, task.taskId, '')}
          className="shrink-0 rounded-[5px] px-1 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          {t('Keep')}
        </button>
      )}
      <button
        type="button"
        data-enso="secretary-daily-stop-task"
        onClick={() => stopBackgroundTask(conversationId, task.taskId)}
        className="shrink-0 rounded-[5px] px-1 text-[11px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        {t('Stop')}
      </button>
    </div>
  );
}

function DailyCard({
  item,
  column,
  day,
}: {
  item: SecretaryDailyItem;
  column: (typeof COLUMNS)[number];
  day: string;
}) {
  const { t, locale } = useI18n();
  const selectConversation = useSessionsStore((s) => s.selectConversation);
  const [expanded, setExpanded] = useState(false);
  const [stopping, setStopping] = useState(false);
  const body = item.summary ?? item.detail;
  const detail = item.detail ?? item.summary;
  // 待办卡把新增与完成时间都挂在卡上，已完成的划掉，与未完成区分开
  const done = item.doneAt !== undefined;
  const times = [
    item.dispatchedAt !== undefined
      ? `${t('Dispatched')} ${stampOf(item.dispatchedAt, day, locale)}`
      : '',
    item.addedAt !== undefined ? `${t('Added')} ${stampOf(item.addedAt, day, locale)}` : '',
    item.doneAt !== undefined ? `${t('Done')} ${stampOf(item.doneAt, day, locale)}` : '',
    column.stamp ? `${t(column.stamp)} ${stampOf(item.at, day, locale)}` : '',
  ].filter(Boolean);
  // 手动收口只对派发或接管跟踪的会话开放，普通会话不显示。
  // 已停止的会话同时给「标记完成」和「移出」：一个收口成完成，一个只从看板上拿掉。
  const mark = !item.tracked ? null : item.manual && column.key === 'done' ? 'undo' : null;
  const settle = item.tracked && (column.key === 'running' || column.key === 'stopped');
  // 已完成但还有遗留任务：卡片内逐个保留/停止；悬停的停止只停疑似闲置的，已保留的不动
  const liveTasks = useSessionsStore((state) =>
    item.conversationId ? state.conversations[item.conversationId]?.backgroundTasks : undefined
  );
  const leftovers = item.leftover
    ? (liveTasks ?? []).filter((task) => task.status === 'running')
    : [];
  const idleLeftovers = leftovers.filter(isIdleTask).length;
  // 会话投影里已经没有在跑的任务：遗留标记只是还没刷新，按普通「已完成」显示
  const leftoverGone =
    item.leftover !== undefined && liveTasks !== undefined && leftovers.length === 0;
  const stopLeftover =
    item.leftover &&
    item.conversationId &&
    !leftoverGone &&
    (leftovers.length === 0 || idleLeftovers > 0)
      ? item.conversationId
      : null;
  return (
    <div
      data-enso="secretary-daily-card"
      data-item={item.id}
      data-done={done ? 'true' : undefined}
      className={cn(CARD_CLASS, 'group/row relative')}
    >
      {stopLeftover && (
        <HoverActions className="from-card">
          <button
            type="button"
            data-enso="secretary-daily-stop-leftover"
            title={t('Stop suspected idle leftover tasks')}
            aria-label={t('Stop suspected idle leftover tasks')}
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              void window.electronAPI.secretary
                .stopTasks(stopLeftover)
                .finally(() => setStopping(false));
            }}
            className={cn(
              ACTION_CLASS,
              'w-auto px-1 text-[11px] hover:bg-destructive/10 hover:text-destructive'
            )}
          >
            {t('Stop')}
          </button>
        </HoverActions>
      )}
      {(mark || settle) && (
        <div
          data-enso="secretary-daily-actions"
          className="mb-1.5 flex flex-wrap items-center justify-start gap-1"
        >
          {(mark || settle) && (
            <button
              type="button"
              data-enso={settle ? 'secretary-daily-mark-done' : 'secretary-daily-mark-undo'}
              title={settle ? t('Mark done') : t('Undo mark done')}
              aria-label={settle ? t('Mark done') : t('Undo mark done')}
              onClick={() => {
                if (!item.conversationId) return;
                void window.electronAPI.secretary.markResult(
                  item.conversationId,
                  settle ? 'done' : 'undo'
                );
              }}
              className={SETTLE_CLASS}
            >
              {settle ? <Check className="size-[11px]" /> : <Undo2 className="size-[11px]" />}
              <span>{settle ? t('Mark done') : t('Undo mark done')}</span>
            </button>
          )}
          {settle && (
            <button
              type="button"
              data-enso="secretary-daily-dismiss"
              title={t('Move off the board')}
              aria-label={t('Move off the board')}
              onClick={() => {
                if (!item.conversationId) return;
                void window.electronAPI.secretary.markResult(item.conversationId, 'dismiss');
              }}
              className={SETTLE_CLASS}
            >
              <X className="size-[11px]" />
              <span>{t('Move off the board')}</span>
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        data-enso="secretary-daily-expand"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="block w-full text-left"
      >
        <span
          className={cn(
            'block text-[12.5px] font-medium leading-[1.45] break-words',
            done && 'text-muted-foreground line-through'
          )}
        >
          {item.title}
        </span>
        {body && (
          <span
            className={cn(
              'mt-[3px] block whitespace-pre-wrap break-words text-[12px] text-muted-foreground',
              expanded ? undefined : 'line-clamp-3'
            )}
          >
            {expanded ? detail : body}
          </span>
        )}
      </button>
      {leftovers.length > 0 && item.conversationId && (
        <div
          data-enso="secretary-daily-leftover-tasks"
          className="mt-[7px] rounded-[5px] bg-foreground/[0.04] px-1.5 py-1"
        >
          {leftovers.map((task) => (
            <LeftoverRow
              key={task.taskId}
              conversationId={item.conversationId as string}
              task={task}
            />
          ))}
        </div>
      )}
      <div className="mt-[7px] flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        {item.projectName && <span className={CHIP_CLASS}>{item.projectName}</span>}
        {item.label && <span className={CHIP_CLASS}>{t(item.label)}</span>}
        {item.leftover && !leftoverGone && (
          <span
            data-enso="secretary-daily-leftover"
            className={cn(
              CHIP_CLASS,
              (leftovers.length === 0 || idleLeftovers > 0) && 'text-warning'
            )}
          >
            {leftovers.length > 0 && idleLeftovers === 0
              ? t('Done ({{count}} kept tasks)', { count: leftovers.length })
              : t('Done ({{count}} leftover tasks)', {
                  count: leftovers.length || item.leftover.count,
                })}
          </span>
        )}
        {item.persistent && (
          <span data-enso="secretary-daily-persistent" className={cn(CHIP_CLASS, 'text-warning')}>
            {t('Service running')}
          </span>
        )}
        {item.branch && (
          <span data-enso="secretary-daily-branch" className={cn(CHIP_CLASS, 'font-mono')}>
            {item.branch}
          </span>
        )}
        {item.commit && (
          <span data-enso="secretary-daily-commit" className={cn(CHIP_CLASS, 'font-mono')}>
            {item.commit}
          </span>
        )}
        {item.conversationId && (
          <button
            type="button"
            data-enso="secretary-daily-open"
            title={t('Open session')}
            aria-label={t('Open session')}
            onClick={() => selectConversation(item.conversationId as string)}
            className={cn(
              CHIP_CLASS,
              'cursor-pointer text-foreground transition-colors hover:bg-brand/15 hover:text-brand'
            )}
          >
            <Link2 className="size-[11px] shrink-0" />
            <span className="truncate">{t('Session')}</span>
          </button>
        )}
        <span data-enso="secretary-daily-times" className="tabular-nums">
          {times.length > 0 ? times.join(' · ') : stampOf(item.at, day, locale)}
        </span>
      </div>
    </div>
  );
}

function DailyColumn({
  column,
  items,
  folded,
  onToggleFold,
  day,
}: {
  column: (typeof COLUMNS)[number];
  items: SecretaryDailyItem[];
  folded: boolean;
  onToggleFold: () => void;
  day: string;
}) {
  const { t } = useI18n();
  return (
    <section data-enso="secretary-daily-column" data-group={column.key} className={COL_CLASS}>
      <div className="flex min-h-[30px] items-center gap-1 pt-0.5 pb-1.5">
        <button
          type="button"
          data-enso="secretary-daily-fold"
          aria-expanded={!folded}
          aria-label={folded ? t('Expand') : t('Collapse')}
          onClick={onToggleFold}
          className={cn(ACTION_CLASS, 'size-6')}
        >
          <ChevronDown
            className={cn('size-3.5 transition-transform duration-300', folded && '-rotate-90')}
          />
        </button>
        <span
          aria-hidden
          className="mx-0.5 size-[7px] shrink-0 rounded-full"
          style={{
            background: column.dot,
            boxShadow: `0 0 0 3px color-mix(in oklch, ${column.dot} 18%, transparent)`,
          }}
        />
        <span className="min-w-0 truncate px-1.5 py-0.5 text-[12.5px] font-semibold">
          {t(column.title)}
        </span>
        <span
          data-enso="secretary-daily-count"
          data-key={column.key}
          className="rounded-full bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11px] leading-none tabular-nums text-muted-foreground"
        >
          {items.length}
        </span>
      </div>
      {!folded && (
        <div className="flex min-h-1.5 flex-col gap-1.5">
          {items.map((item) => (
            <DailyCard key={item.id} item={item} column={column} day={day} />
          ))}
          {items.length === 0 && (
            <div
              data-enso="secretary-daily-empty-column"
              className="flex flex-col items-center gap-1 px-2 pt-3.5 pb-2 text-center text-[11.5px] text-subtle-foreground"
            >
              <Inbox className="size-5 opacity-60" />
              {t('No cards yet')}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** 看板：按天回看秘书一天做了什么，数据由 Main 的 secretary:daily 提供 */
export function SecretaryDailyBoard({ secretaryId }: { secretaryId?: string } = {}) {
  const { t } = useI18n();
  const [day, setDay] = useState(() => dayKey(Date.now()));
  const [daily, setDaily] = useState<SecretaryDaily | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<SecretaryDailyGroupKey>>(() => new Set());
  const today = dayKey(Date.now());

  const load = useCallback(
    (target: string) => {
      void window.electronAPI.secretary
        .daily(target, secretaryId)
        .then((result) => {
          if (result.ok) setDaily(result.daily);
        })
        .catch(() => undefined);
    },
    [secretaryId]
  );

  // 换日期就重读；只有今天跟着状态推送刷新，历史日期定住不动
  useEffect(() => {
    load(day);
  }, [day, load]);
  useEffect(() => {
    if (day !== dayKey(Date.now())) return;
    return window.electronAPI.secretary.onStateChanged(() => load(day));
  }, [day, load]);

  const itemsOf = (key: SecretaryDailyGroupKey): SecretaryDailyItem[] =>
    daily?.groups.find((group) => group.key === key)?.items ?? [];
  const total = (daily?.groups ?? []).reduce((sum, group) => sum + group.items.length, 0);
  const done = itemsOf('done').length;
  const dispatched = daily?.counts.dispatched ?? 0;
  const toggleFold = (key: SecretaryDailyGroupKey) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div data-enso="secretary-daily" className="@container flex flex-col gap-2 px-3 py-2">
      <div className="flex items-center gap-1">
        <button
          type="button"
          data-enso="secretary-daily-prev"
          title={t('Previous day')}
          aria-label={t('Previous day')}
          onClick={() => setDay((value) => shiftDay(value, -1))}
          className={ACTION_CLASS}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <input
          type="date"
          data-enso="secretary-daily-date"
          aria-label={t('Daily board')}
          value={day}
          max={today}
          onChange={(event) => {
            const next = event.target.value;
            if (next) setDay(next);
          }}
          className="min-w-0 flex-1 rounded-[6px] border border-border bg-transparent px-1.5 py-0.5 text-[12.5px] tabular-nums outline-none focus:border-foreground/30"
        />
        <button
          type="button"
          data-enso="secretary-daily-next"
          title={t('Next day')}
          aria-label={t('Next day')}
          disabled={day >= today}
          onClick={() => setDay((value) => shiftDay(value, 1))}
          className={cn(ACTION_CLASS, 'disabled:opacity-40 disabled:hover:bg-transparent')}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <span
          data-enso="secretary-daily-stat"
          title={`${t('Dispatched')} / ${t('What got done')} / ${t('All')}`}
          className="shrink-0 whitespace-nowrap font-mono text-[11.5px] tabular-nums text-muted-foreground"
        >
          {t('Dispatched')} {dispatched} · {done}/{total}
        </span>
        <button
          type="button"
          data-enso="secretary-daily-today"
          disabled={day === today}
          onClick={() => setDay(today)}
          className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[11.5px] whitespace-nowrap transition-colors hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent"
        >
          {t('Today')}
        </button>
      </div>
      <div
        data-enso="secretary-daily-board"
        className="flex flex-col gap-2.5 @[560px]:flex-row @[560px]:items-start @[560px]:overflow-x-auto @[560px]:pb-1"
      >
        {COLUMNS.map((column) => (
          <DailyColumn
            key={column.key}
            column={column}
            items={itemsOf(column.key)}
            folded={folded.has(column.key)}
            onToggleFold={() => toggleFold(column.key)}
            day={day}
          />
        ))}
      </div>
      {daily?.earliest && (
        <p
          data-enso="secretary-daily-earliest"
          className="px-1.5 pt-1 text-[11px] text-subtle-foreground"
        >
          {t('Look back to {{day}}', { day: daily.earliest })}
        </p>
      )}
    </div>
  );
}
