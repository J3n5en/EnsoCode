import { dayKey, shiftDay } from '@shared/secretary/daily';
import type {
  SecretaryDaily,
  SecretaryDailyCounts,
  SecretaryDailyGroup,
  SecretaryDailyGroupKey,
  SecretaryDailyItem,
} from '@shared/types/secretary';
import { ArrowUpRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { HOVER_ROW_CLASS, HoverActions } from '@/components/ui/hover-actions';
import { useI18n } from '@/i18n';
import { formatClock } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';

/** 收起时每组只露这么多条，展开看全部 */
const PREVIEW_COUNT = 3;

const GROUP_TITLE: Record<SecretaryDailyGroupKey, string> = {
  done: 'What got done',
  failed: 'Failed or interrupted',
  needsYou: 'Needed you',
  dispatched: 'Newly dispatched',
  todos: 'To-dos',
  changes: 'Settings and capabilities',
};

const COUNT_LABEL: { key: keyof SecretaryDailyCounts; label: string }[] = [
  { key: 'dispatched', label: 'Dispatched' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
  { key: 'needsYou', label: 'Needed you' },
  { key: 'todosDone', label: 'To-dos done' },
  { key: 'merged', label: 'Merged' },
];

/** 状态小徽标的颜色：完成绿、出问题红、需要你黄，其余中性 */
const TONE_DOT: Record<SecretaryDailyGroupKey, string> = {
  done: 'bg-success',
  failed: 'bg-destructive',
  needsYou: 'bg-warning',
  dispatched: 'bg-subtle-foreground',
  todos: 'bg-subtle-foreground',
  changes: 'bg-subtle-foreground',
};

const ACTION_CLASS =
  'flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

function DailyRow({ item, group }: { item: SecretaryDailyItem; group: SecretaryDailyGroupKey }) {
  const { t, locale } = useI18n();
  const selectConversation = useSessionsStore((s) => s.selectConversation);
  const [expanded, setExpanded] = useState(false);
  const open = item.conversationId
    ? () => selectConversation(item.conversationId as string)
    : undefined;
  const refs = [item.branch ? `${t('Branch')} ${item.branch}` : '', item.commit ?? ''].filter(
    Boolean
  );
  return (
    <div
      data-enso="secretary-daily-item"
      data-group={group}
      className={cn(HOVER_ROW_CLASS, 'flex items-start gap-2 rounded-lg px-1.5 py-1.5')}
    >
      <button
        type="button"
        data-enso="secretary-daily-expand"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="min-w-0 flex-1 text-left"
      >
        <span className="flex items-center gap-1.5">
          <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', TONE_DOT[group])} />
          <span className="min-w-0 flex-1 truncate text-[13px]">{item.title}</span>
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-subtle-foreground">
          <span className="tabular-nums">{formatClock(item.at, locale)}</span>
          {item.projectName && <span>· {item.projectName}</span>}
          {item.label && <span className="text-muted-foreground">· {t(item.label)}</span>}
        </span>
        {item.summary && (
          <span
            className={cn(
              'mt-0.5 block text-[12px] text-muted-foreground',
              expanded ? 'whitespace-pre-wrap break-words' : 'line-clamp-1'
            )}
          >
            {expanded ? (item.detail ?? item.summary) : item.summary}
          </span>
        )}
        {expanded && refs.length > 0 && (
          <span
            data-enso="secretary-daily-refs"
            className="mt-1 flex flex-wrap gap-x-2 font-mono text-[11px] text-subtle-foreground"
          >
            {refs.map((ref) => (
              <span key={ref}>{ref}</span>
            ))}
          </span>
        )}
      </button>
      {open && (
        <HoverActions>
          <button
            type="button"
            data-enso="secretary-daily-open"
            title={t('Open session')}
            aria-label={t('Open session')}
            onClick={open}
            className={ACTION_CLASS}
          >
            <ArrowUpRight className="h-3.5 w-3.5" />
          </button>
        </HoverActions>
      )}
    </div>
  );
}

function DailyGroupSection({ group }: { group: SecretaryDailyGroup }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const hidden = group.items.length - PREVIEW_COUNT;
  const items = expanded ? group.items : group.items.slice(0, PREVIEW_COUNT);
  return (
    <section data-enso="secretary-daily-group" data-group={group.key} className="flex flex-col">
      <h3 className="px-1.5 pb-1 text-[12px] text-subtle-foreground">
        {t(GROUP_TITLE[group.key])}
        <span className="ml-1 tabular-nums">{group.items.length}</span>
      </h3>
      {items.map((item) => (
        <DailyRow key={item.id} item={item} group={group.key} />
      ))}
      {(hidden > 0 || expanded) && (
        <button
          type="button"
          data-enso="secretary-daily-more"
          onClick={() => setExpanded((value) => !value)}
          className="self-start rounded-md px-1.5 py-0.5 text-[11.5px] text-subtle-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          {expanded ? t('Collapse') : t('Show all {{count}}', { count: group.items.length })}
        </button>
      )}
    </section>
  );
}

/** 看板：按天回看秘书一天做了什么，数据由 Main 的 secretary:daily 提供 */
export function SecretaryDailyBoard() {
  const { t } = useI18n();
  const [day, setDay] = useState(() => dayKey(Date.now()));
  const [daily, setDaily] = useState<SecretaryDaily | null>(null);
  const today = dayKey(Date.now());

  const load = useCallback((target: string) => {
    void window.electronAPI.secretary
      .daily(target)
      .then((result) => {
        if (result.ok) setDaily(result.daily);
      })
      .catch(() => undefined);
  }, []);

  // 换日期就重读；只有今天跟着状态推送刷新，历史日期定住不动
  useEffect(() => {
    load(day);
  }, [day, load]);
  useEffect(() => {
    if (day !== dayKey(Date.now())) return;
    return window.electronAPI.secretary.onStateChanged(() => load(day));
  }, [day, load]);

  const counts = daily?.counts;
  const groups = daily?.groups ?? [];
  return (
    <div data-enso="secretary-daily" className="flex flex-col gap-2 px-3 py-2">
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
          className="min-w-0 rounded-[6px] border border-border bg-transparent px-1.5 py-0.5 text-[12.5px] tabular-nums outline-none focus:border-foreground/30"
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
        <button
          type="button"
          data-enso="secretary-daily-today"
          disabled={day === today}
          onClick={() => setDay(today)}
          className="ml-auto rounded-md border border-border px-2 py-0.5 text-[11.5px] transition-colors hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent"
        >
          {t('Today')}
        </button>
      </div>
      {counts && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {COUNT_LABEL.map(({ key, label }) => (
            <span
              key={key}
              data-enso="secretary-daily-count"
              data-key={key}
              className="flex items-baseline gap-1 text-[11.5px] text-muted-foreground"
            >
              <span
                className={cn(
                  'text-[14px] font-semibold tabular-nums text-foreground',
                  key === 'needsYou' && counts.needsYou > 0 && 'text-warning'
                )}
              >
                {counts[key]}
              </span>
              {t(label)}
            </span>
          ))}
        </div>
      )}
      {daily && groups.length === 0 && (
        <p
          data-enso="secretary-daily-empty"
          className="px-1.5 py-6 text-center text-[12.5px] text-subtle-foreground"
        >
          {t('Nothing happened this day')}
        </p>
      )}
      {groups.map((group) => (
        <DailyGroupSection key={group.key} group={group} />
      ))}
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
