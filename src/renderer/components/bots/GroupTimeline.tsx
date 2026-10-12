import { retryableGroupFailures } from '@shared/bots/groupRetry';
import { splitTaskRef } from '@shared/bots/progress';
import { PASTED_TEXT_FILE_NAME, splitPastedTextRefs } from '@shared/pastedText';
import type { ProjectedMessage } from '@shared/types/agent';
import type { BotChat, BotProfile, BotRoutedBy, Delegation, GroupEntry } from '@shared/types/bot';
import {
  ArrowDown,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CirclePlay,
  CircleX,
  FileText,
  Loader2,
  MessagesSquare,
  Sparkles,
} from 'lucide-react';
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Markdown } from '@/components/chat/Markdown';
import { mentionChipClass } from '@/components/chat/MentionChip';
import { CHAT_COL } from '@/components/chat/MessageTimeline';
import { USER_BUBBLE } from '@/components/chat/TimelineRow';
import { Button } from '@/components/ui/button';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { toolLabel } from '@/lib/toolLabels';
import { cn } from '@/lib/utils';
import { type ChatRuntime, type TimelineState, useBotsStore } from '@/stores/bots';
import { activeDelegations, isRetried } from '@/stores/bots/delegations';
import { windowFocusStep } from '@/stores/bots/focus';
import {
  anchorDelegations,
  buildRows,
  delegationCardSeq,
  locateTurn,
  type TimelineDelegation,
  type TurnStep,
  timelineDelegations,
  turnSteps,
} from '@/stores/bots/groupTimeline';
import { useSettingsStore } from '@/stores/settings';
import { ArtifactCards } from './ArtifactCards';
import { BotAvatar } from './BotAvatar';
import { BotLiveStatus } from './BotLiveStatus';
import { PresenceAvatar } from './BotPresence';
import { chatErrorText, chatTitle } from './botText';
import { DelegationCard } from './DelegationCard';
import { QueuedInterjections } from './QueuedInterjections';
import { RoutineProposalCard } from './RoutineCards';
import { SilenceNote } from './SilenceNote';

const timeOf = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const ROUTED_BY_LABELS: Record<BotRoutedBy, string> = {
  smart: 'Smart pick',
  'smart:build': 'Smart pick · build',
  'smart:answer': 'Smart pick · answer',
  'smart:discuss': 'Smart pick · discuss',
  summary: 'Owner summary',
  'wrap-up': 'Owner wrap-up',
};

interface GroupTimelineProps {
  chat: BotChat;
  bots: Map<string, BotProfile>;
  timeline: TimelineState | undefined;
  runtime: ChatRuntime | undefined;
  /** 本群全部委派记录；进行中的接在时间线末尾 */
  delegations: Delegation[];
  /** 搜索跳转：滚到该条并短暂高亮 */
  focus?: { seq: number; query: string; nonce: number };
  onFocusDone?: (nonce: number) => void;
  onLoadOlder: () => void;
  /** 历史窗口向下翻页 */
  onLoadNewer: () => void;
  /** 跳转：加载目标附近一段 */
  onLoadAround: (seq: number) => Promise<void>;
  onJumpLatest: () => void;
  onOpenConversation: (conversationId: string, title: string) => void;
  /** 实时查看正在回复成员的群会话 */
  onOpenLive: (conversationId: string, botId: string) => void;
}

export function GroupTimeline({
  chat,
  bots,
  timeline,
  runtime,
  delegations,
  focus,
  onFocusDone,
  onLoadOlder,
  onLoadNewer,
  onLoadAround,
  onJumpLatest,
  onOpenConversation,
  onOpenLive,
}: GroupTimelineProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  // 条目行按引用 memo：翻页只渲染新增的行
  const openRef = useRef(onOpenConversation);
  openRef.current = onOpenConversation;
  const openConversation = useCallback(
    (conversationId: string, title: string) => openRef.current(conversationId, title),
    []
  );
  /** 翻页 / 裁剪期间的视口锚点：某条目相对视口顶部的位置，落地后据此还原 */
  const anchorRef = useRef<{ seq: number; top: number } | null>(null);
  const wasHistoryRef = useRef(false);
  const loaded = timeline?.entries ?? [];
  // 「委派结果」标签定位卡片：读最新的已加载条目与委派记录，回调保持稳定以免整列重渲染
  const locateRef = useRef({ chatId: chat.id, loaded, delegations });
  locateRef.current = { chatId: chat.id, loaded, delegations };
  const locateDelegation = useCallback(
    (delegationId: string) => {
      const { chatId, loaded, delegations } = locateRef.current;
      const seq = delegationCardSeq(loaded, delegationId);
      if (seq !== undefined) return useBotsStore.getState().focusSeq(chatId, seq);
      const record = delegations.find((item) => item.id === delegationId);
      addToast({
        type: 'info',
        title:
          record && record.deliveredAt === undefined
            ? t('The delegation card is posted after the delegator receives the result.')
            : t('The delegation card is not in the loaded messages.'),
      });
    },
    [t]
  );
  const retryable = retryableGroupFailures(loaded, chat.epochSeq ?? 0);
  const history = timeline?.history;
  // 最近一条「新对话」分隔线之前默认收起，点开才往上加载；历史窗口（跳转）时全部显示
  const epoch = chat.epochSeq ?? 0;
  const [expanded, setExpanded] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 切换聊天或再开新对话时重新收起
  useEffect(() => setExpanded(false), [chat.id, epoch]);
  const folded = epoch > 0 && !expanded && !history;
  const entries = useMemo(
    () => (folded ? loaded.filter((entry) => entry.seq >= epoch) : loaded),
    [loaded, folded, epoch]
  );
  const rows = useMemo(() => buildRows(entries), [entries]);
  const toggleEarlier = () => {
    if (folded && timeline?.hasOlder && !timeline.loading && !loaded.some((e) => e.seq < epoch)) {
      captureAnchor();
      onLoadOlder();
    }
    setExpanded(folded);
  };
  /** 每个成员最后一个显示出来的头像挂状态角标；历史窗口里不是最新，不挂 */
  const latestAvatars = useMemo(() => {
    const byBot = new Map<string, string>();
    if (!history)
      for (const row of rows)
        if (row.kind === 'entry' && row.entry.kind === 'bot' && !row.continued)
          byBot.set(row.entry.botId, row.entry.id);
    return new Set(byBot.values());
  }, [rows, history]);
  const records = useMemo(
    () =>
      new Map(
        delegations.map((item) => [
          item.id,
          { record: item, retried: isRetried(item, delegations) },
        ])
      ),
    [delegations]
  );
  // 进行中与等待自动重试的委派还没有卡片条目，按时间挂进时间线
  const active = useMemo(() => activeDelegations(delegations, chat.id), [delegations, chat.id]);
  const placed = useMemo(
    () => anchorDelegations(entries, timelineDelegations(active)),
    [entries, active]
  );
  const tasks = useBotsStore((s) => s.tasks[chat.id]);
  const merged = active.some((record) => record.appends?.length);
  useEffect(() => {
    if (merged && !tasks) void useBotsStore.getState().refreshTasks(chat.id);
  }, [merged, tasks, chat.id]);
  const card = ({ key, record, append }: TimelineDelegation) => (
    <DelegationCard
      key={key}
      record={record}
      append={append}
      taskSeq={append && tasks?.find((task) => task.id === record.taskId)?.seq}
      fill
      bots={bots}
      onOpenConversation={onOpenConversation}
    />
  );
  const replying = runtime?.current ? bots.get(runtime.current) : undefined;
  const replyingId = runtime?.current ? chat.sessions[runtime.current]?.conversationId : undefined;
  const activity = useBotsStore((s) =>
    replyingId ? s.sessions[replyingId]?.messages.length : undefined
  );

  // 进入聊天先贴底
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在切换聊天时执行
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
  }, [chat.id]);

  const captureAnchor = () => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    for (const node of el.querySelectorAll<HTMLElement>('[data-seq]')) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom <= top) continue;
      anchorRef.current = { seq: Number(node.dataset.seq), top: rect.top - top };
      return;
    }
  };

  // 翻页 / 裁剪 / 加载指示出现消失时按锚点保持视口位置；最新视图贴底时底部新消息跟随
  // biome-ignore lint/correctness/useExhaustiveDependencies: 条目、加载状态、委派与 typing 变化是触发信号
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const anchor = anchorRef.current;
    const settled = !timeline?.loading && !timeline?.loadingNewer;
    if (settled) anchorRef.current = null;
    const leftHistory = wasHistoryRef.current && !history;
    wasHistoryRef.current = Boolean(history);
    const node = anchor && el.querySelector<HTMLElement>(`[data-seq="${anchor.seq}"]`);
    if (anchor && node) {
      el.scrollTop +=
        node.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.top;
      return;
    }
    // 回到最新（整体替换）退出历史窗口时贴底；向下翻页追上最新走上面的锚点
    if (leftHistory) atBottomRef.current = true;
    if (atBottomRef.current && !history) el.scrollTop = el.scrollHeight;
  }, [
    entries,
    history,
    timeline?.loading,
    timeline?.loadingNewer,
    active.length,
    replying?.id,
    activity,
    runtime?.routing,
  ]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || !timeline) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = fromBottom < 40;
    // 加载期间用户继续滚动：锚点跟着更新，落地时不把视口拉回去
    if (anchorRef.current) captureAnchor();
    // 收起时读到分隔线就不再往上自动加载
    if (entries.length === 0 || (folded && (loaded[0]?.seq ?? 0) <= epoch)) return;
    if (el.scrollTop < 80 && timeline.hasOlder && !timeline.loading) {
      captureAnchor();
      onLoadOlder();
    }
    if (fromBottom < 80 && history && !timeline.loadingNewer) {
      captureAnchor();
      onLoadNewer();
    }
  };

  const [flashSeq, setFlashSeq] = useState<number | null>(null);
  const handledFocus = useRef<number | null>(null);
  const [jump, setJump] = useState<{ nonce: number; done: boolean } | null>(null);
  // 目标不在已加载范围内就直接按窗口加载；布局阶段滚动，避免先闪到别处
  // biome-ignore lint/correctness/useExhaustiveDependencies: 条目加载与跳转状态是推进信号
  useLayoutEffect(() => {
    if (!focus || handledFocus.current === focus.nonce) return;
    if (folded && focus.seq < epoch) {
      setExpanded(true);
      return;
    }
    const first = entries[0]?.seq;
    const last = entries.at(-1)?.seq;
    const mine = jump?.nonce === focus.nonce ? jump : null;
    const step = windowFocusStep({
      target: focus.seq,
      range: !timeline
        ? undefined
        : first === undefined || last === undefined
          ? null
          : [first, last],
      loading: Boolean(mine && !mine.done),
      jumped: Boolean(mine?.done),
    });
    if (step === 'wait') return;
    if (step === 'jump') {
      const nonce = focus.nonce;
      atBottomRef.current = false;
      anchorRef.current = null;
      setJump({ nonce, done: false });
      void onLoadAround(focus.seq).finally(() =>
        setJump((value) => (value?.nonce === nonce ? { nonce, done: true } : value))
      );
      return;
    }
    handledFocus.current = focus.nonce;
    onFocusDone?.(focus.nonce);
    if (step !== 'scroll') return;
    atBottomRef.current = false;
    anchorRef.current = null;
    setFlashSeq(focus.seq);
    scrollRef.current
      ?.querySelector(`[data-seq="${focus.seq}"]`)
      ?.scrollIntoView({ block: 'center' });
  }, [focus, entries, timeline === undefined, jump, folded]);
  useEffect(() => {
    if (flashSeq === null) return;
    const timer = window.setTimeout(() => setFlashSeq(null), 2500);
    return () => window.clearTimeout(timer);
  }, [flashSeq]);

  const backToLatest = () => {
    atBottomRef.current = true;
    anchorRef.current = null;
    onJumpLatest();
  };
  const newCount = history && timeline ? timeline.lastSeq - history.sinceSeq : 0;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 select-text overflow-y-auto"
      >
        <div className="@container">
          <div data-slot="bot-timeline" className={cn(CHAT_COL, 'flex flex-col gap-3 py-4')}>
            {timeline?.loading && (
              <div className="flex justify-center py-1 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            )}
            {timeline && !timeline.hasOlder && !folded && entries.length > 0 && (
              <div className="text-center text-[11px] text-muted-foreground">
                {t('Beginning of the chat')}
              </div>
            )}
            {!timeline && (
              <div className="flex justify-center py-6 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            )}
            {timeline && entries.length === 0 && (
              <p className="py-10 text-center text-muted-foreground text-sm">
                {t('Say something. Mention a member with @, or the group owner replies.')}
              </p>
            )}
            {placed.head.map(card)}
            {rows.map((row) =>
              row.kind === 'day' ? (
                <div key={row.key} className="py-1 text-center text-[11px] text-muted-foreground">
                  {new Date(row.at).toLocaleDateString()}
                </div>
              ) : (
                <Fragment key={row.key}>
                  {epoch > 0 && !history && row.entry.seq === epoch && (
                    <button
                      type="button"
                      onClick={toggleEarlier}
                      className="flex items-center gap-1 self-center rounded-md px-2 py-1 text-muted-foreground text-xs hover:bg-muted hover:text-foreground"
                    >
                      {folded ? (
                        <ChevronRight className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" />
                      )}
                      {folded
                        ? t('Earlier conversation · {{n}} messages', { n: epoch - 1 })
                        : t('Collapse earlier conversation')}
                    </button>
                  )}
                  <div
                    data-seq={row.entry.seq}
                    className={cn(
                      '-mx-2 flex flex-col rounded-lg px-2 transition-colors duration-500',
                      flashSeq === row.entry.seq && 'bg-brand/10'
                    )}
                  >
                    <EntryRow
                      chatId={chat.id}
                      entry={row.entry}
                      continued={row.continued}
                      latest={latestAvatars.has(row.entry.id)}
                      retryable={retryable.has(row.entry.id) && chat.archivedAt === undefined}
                      retryBusy={Boolean(runtime?.current || runtime?.routing)}
                      bots={bots}
                      records={records}
                      onOpenConversation={openConversation}
                      onLocateDelegation={locateDelegation}
                    />
                  </div>
                  {placed.after.get(row.entry.id)?.map(card)}
                </Fragment>
              )
            )}
            {timeline?.loadingNewer && (
              <div className="flex justify-center py-1 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            )}
            {!history && !replying && runtime?.routing && (
              <div className="flex items-center gap-2 text-muted-foreground text-xs">
                <TypingDots />
                {t('Choosing who replies…')}
              </div>
            )}
            {!history && <QueuedInterjections chatId={chat.id} bots={bots} />}
            {!history && replying && (
              <button
                type="button"
                disabled={!replyingId}
                title={t('View live')}
                onClick={() => replyingId && onOpenLive(replyingId, replying.id)}
                className="-mx-2 flex gap-2.5 rounded-lg px-2 py-1 text-left hover:bg-muted/60 disabled:pointer-events-none"
              >
                <BotAvatar bot={replying} size="sm" busy />
                <div className="min-w-0">
                  <div className="text-muted-foreground text-xs">
                    <span className="mr-1.5 font-semibold text-foreground">{replying.name}</span>
                    {t('Replying')}
                  </div>
                  <BotLiveStatus
                    conversationId={replyingId}
                    leading={<TypingDots />}
                    trailing={
                      <>
                        <SilenceNote conversationId={replyingId} />
                        {replyingId && (
                          <span className="shrink-0 underline-offset-2 hover:underline">
                            {t('View live')}
                          </span>
                        )}
                      </>
                    }
                  />
                </div>
              </button>
            )}
          </div>
        </div>
      </div>
      {history && (
        <button
          type="button"
          onClick={backToLatest}
          className="absolute bottom-4 left-1/2 z-10 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border bg-card px-3 text-muted-foreground text-xs shadow-float transition-colors hover:text-foreground"
        >
          <ArrowDown className="h-3 w-3" />
          {newCount > 0 ? t('Back to latest · {{n}} new', { n: newCount }) : t('Back to latest')}
        </button>
      )}
    </div>
  );
}

function TypingDots() {
  return (
    <span className="flex gap-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground"
          style={{ animationDelay: `${i * 0.2}s` }}
        />
      ))}
    </span>
  );
}

const EntryRow = memo(function EntryRow({
  chatId,
  entry,
  continued,
  latest,
  bots,
  records,
  onOpenConversation,
  onLocateDelegation,
  retryable,
  retryBusy,
}: {
  chatId: string;
  entry: GroupEntry;
  continued: boolean;
  /** 该成员最新一个头像：显示状态角标 */
  latest: boolean;
  retryable: boolean;
  retryBusy: boolean;
  bots: Map<string, BotProfile>;
  records: Map<string, { record: Delegation; retried: boolean }>;
  onOpenConversation: (conversationId: string, title: string) => void;
  /** 委派结果消息 → 定位对应的委派卡片 */
  onLocateDelegation: (delegationId: string) => void;
}) {
  const { t } = useI18n();
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const result = await window.electronAPI.bots.retry(chatId, entry.id);
      if (!result.ok)
        addToast({
          type: 'error',
          title: t('Retry failed'),
          description: chatErrorText(result.error, t),
        });
    } catch {
      addToast({ type: 'error', title: t('Retry failed') });
    } finally {
      setRetrying(false);
    }
  };
  switch (entry.kind) {
    case 'system':
      if (entry.newConversation)
        return (
          <div className="flex items-center gap-3 text-muted-foreground text-xs">
            <div className="h-px flex-1 bg-border" />
            {t('New conversation')} · {timeOf(entry.at)}
            <div className="h-px flex-1 bg-border" />
          </div>
        );
      return entry.routine ? (
        <RoutineProposalCard text={entry.text} target={entry.routine} />
      ) : (
        <div
          data-slot="bot-notice"
          className="self-center rounded-full bg-muted px-2.5 py-0.5 text-center text-muted-foreground text-xs"
        >
          {entry.text}
          {retryable && (
            <Button
              size="xs"
              variant="outline"
              className="ml-2"
              disabled={retryBusy || retrying}
              onClick={retry}
            >
              {t('Retry')}
            </Button>
          )}
        </div>
      );
    case 'human':
      return (
        <div className="flex w-full flex-col items-end">
          {entry.text && (
            <div className={cn(USER_BUBBLE, 'whitespace-pre-wrap break-words')}>
              <MentionText text={entry.text} bots={bots} />
            </div>
          )}
          {entry.images?.length ? <ArtifactCards target={{ chatId, entryId: entry.id }} /> : null}
          {(entry.refs?.skill || entry.refs?.chats?.length) && <HumanRefs refs={entry.refs} />}
          {!continued && (
            <span className="mt-0.5 text-[11px] text-muted-foreground">{timeOf(entry.at)}</span>
          )}
        </div>
      );
    case 'progress':
      return (
        <ProgressRow
          chatId={chatId}
          entry={entry}
          bots={bots}
          failed={records.get(entry.delegationId)?.record.state === 'failed'}
        />
      );
    case 'delegation':
      return (
        <DelegationCard
          record={records.get(entry.delegationId)?.record}
          retried={records.get(entry.delegationId)?.retried}
          entry={entry}
          fill
          bots={bots}
          onOpenConversation={onOpenConversation}
        />
      );
    case 'bot': {
      const bot = bots.get(entry.botId);
      return (
        <div className={cn('flex w-full gap-2.5', continued && '-mt-1.5')}>
          {continued ? (
            <span className="w-6 shrink-0" />
          ) : latest ? (
            <PresenceAvatar chatId={chatId} botId={entry.botId} bot={bot} />
          ) : (
            <BotAvatar bot={bot} size="sm" />
          )}
          <div className="min-w-0 flex-1">
            {!continued && (
              <div className="mb-0.5 text-muted-foreground text-xs">
                <span className="mr-1.5 font-semibold text-foreground">
                  {bot?.name ?? t('Deleted member')}
                </span>
                {bot?.title ? `${bot.title} · ` : ''}
                {timeOf(entry.at)}
                {entry.model && (
                  <span className="ml-1.5 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                    {entry.model}
                  </span>
                )}
                {entry.delegationId && (
                  <button
                    type="button"
                    title={t('Locate the delegation card')}
                    onClick={() => entry.delegationId && onLocateDelegation(entry.delegationId)}
                    className="ml-1.5 rounded bg-info/15 px-1 py-px text-[10px] text-info hover:bg-info/25"
                  >
                    {t('Delegation result')}
                  </button>
                )}
                {entry.routedBy && (
                  <span
                    title={t(
                      entry.routedBy === 'summary'
                        ? 'Asked to sum up after the assigned members replied'
                        : 'Picked automatically because nobody was @-mentioned'
                    )}
                    className="ml-1.5 rounded border px-1 py-px text-[10px]"
                  >
                    {t(ROUTED_BY_LABELS[entry.routedBy])}
                  </span>
                )}
              </div>
            )}
            <div className="text-sm">
              <Markdown text={entry.text} />
            </div>
            <ArtifactCards target={{ chatId, entryId: entry.id }} />
            <TurnProcess
              entry={entry}
              onOpen={() => onOpenConversation(entry.conversationId, bot?.name ?? '')}
            />
          </div>
        </div>
      );
    }
  }
});

const PROGRESS_TONE = {
  started: { icon: CirclePlay, className: 'border-brand/50 text-brand' },
  blocked: { icon: CircleAlert, className: 'border-warning/60 text-warning' },
  failed: { icon: CircleX, className: 'border-destructive/60 text-destructive' },
  delivered: { icon: CircleCheck, className: 'border-success/60 text-success' },
} as const;

/** 开工 / 卡住 / 交付进度：一行，#N 可点打开看板上的任务卡 */
function ProgressRow({
  chatId,
  entry,
  bots,
  failed,
}: {
  chatId: string;
  entry: Extract<GroupEntry, { kind: 'progress' }>;
  bots: Map<string, BotProfile>;
  failed: boolean;
}) {
  const { t } = useI18n();
  const openTask = useBotsStore((s) => s.openTask);
  const bot = bots.get(entry.botId);
  const tone = PROGRESS_TONE[entry.phase === 'blocked' && failed ? 'failed' : entry.phase];
  const Icon = tone.icon;
  const ref = splitTaskRef(entry.text, entry.taskSeq);
  return (
    <div data-slot="bot-progress" data-phase={entry.phase} className="flex w-full gap-2.5">
      <BotAvatar bot={bot} size="sm" />
      <div
        className={cn(
          'flex min-w-0 max-w-lg items-start gap-1.5 rounded-md border-l-2 bg-muted/50 px-2 py-1 text-xs',
          tone.className
        )}
      >
        <Icon aria-hidden className="mt-px size-3.5 shrink-0" />
        <div className="line-clamp-2 min-w-0 break-words text-muted-foreground">
          <span className="font-medium text-foreground">{bot?.name ?? t('Deleted member')}</span>{' '}
          {ref ? (
            <>
              <MentionText text={ref[0]} bots={bots} />
              <button
                type="button"
                aria-label={t('Open task card #{{n}}', { n: entry.taskSeq })}
                className="rounded px-0.5 font-medium text-foreground underline decoration-dotted underline-offset-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => openTask(chatId, entry.taskId)}
              >
                {ref[1]}
              </button>
              <MentionText text={ref[2]} bots={bots} />
            </>
          ) : (
            <MentionText text={entry.text} bots={bots} />
          )}
        </div>
        <span className="shrink-0 text-[11px] text-muted-foreground">{timeOf(entry.at)}</span>
      </div>
    </div>
  );
}

function MentionText({ text, bots }: { text: string; bots: Map<string, BotProfile> }) {
  const parts = useMemo(() => {
    const names = [...bots.values()].map((bot) => bot.name).sort((a, b) => b.length - a.length);
    const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
    const pattern = names.length
      ? new RegExp(`(@(?:${escaped.join('|')}|所有人|everyone|all))`, 'giu')
      : null;
    // 超长粘贴附件路径可能含空格，先整体切出渲染成卡片
    return splitPastedTextRefs(text).flatMap(
      (segment): (string | { type: 'file'; path: string } | { type: 'mention'; part: string })[] =>
        segment.type === 'file'
          ? [segment]
          : (pattern ? segment.text.split(pattern) : [segment.text]).map((part, index) =>
              part.startsWith('@') && index % 2 === 1 ? { type: 'mention' as const, part } : part
            )
    );
  }, [text, bots]);
  return (
    <>
      {parts.map((part, index) =>
        typeof part === 'string' ? (
          part
        ) : part.type === 'file' ? (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: 拆分片段按位置稳定
            key={index}
            className={cn(mentionChipClass('file'), 'mx-0.5 leading-4')}
            title={part.path}
          >
            <FileText className="h-3 w-3 shrink-0" />
            <span className="truncate">{PASTED_TEXT_FILE_NAME}</span>
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: 拆分片段按位置稳定
          <span key={index} className="font-medium underline underline-offset-2">
            {part.part}
          </span>
        )
      )}
    </>
  );
}

/** 「查看过程」：按 conversationId 读会话，定位该轮并列出工具调用 */
function TurnProcess({
  entry,
  onOpen,
}: {
  entry: Extract<GroupEntry, { kind: 'bot' }>;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<
    { steps: TurnStep[]; exact: boolean } | { error: string } | null
  >(null);

  useEffect(() => {
    if (!open || state) return;
    let alive = true;
    const resolve = (messages: ProjectedMessage[]) => {
      const range = locateTurn(messages, entry.text);
      if (!alive) return;
      if (!range) return setState({ error: t('No process recorded.') });
      setState({ steps: turnSteps(messages.slice(range.start, range.end)), exact: range.exact });
    };
    const live = useBotsStore.getState().sessions[entry.conversationId]?.messages;
    if (live?.some((message) => message.role === 'assistant')) {
      resolve(live);
    } else {
      void window.electronAPI.bots
        .sessionHistory({ conversationId: entry.conversationId })
        .then((result) =>
          result.ok ? resolve(result.messages) : alive && setState({ error: result.error })
        );
    }
    return () => {
      alive = false;
    };
  }, [open, state, entry.conversationId, entry.text, t]);

  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
      >
        <Icon className="h-3 w-3" />
        {t('View process')}
        {state && 'steps' in state && ` · ${t('{{n}} steps', { n: state.steps.length })}`}
      </button>
      {open && (
        <div
          data-slot="bot-card"
          className="mt-1.5 rounded-lg border bg-card px-3 py-2 font-mono text-muted-foreground text-xs leading-relaxed"
        >
          {!state && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {state && 'error' in state && <span>{state.error}</span>}
          {state && 'steps' in state && (
            <>
              {!state.exact && (
                <div className="mb-1 font-sans italic">
                  {t('Could not locate this reply; showing the latest turn.')}
                </div>
              )}
              {state.steps.length === 0 && (
                <div className="font-sans">{t('No tool calls in this turn.')}</div>
              )}
              {state.steps.map((step) => (
                <div key={step.id} className={cn('truncate', step.error && 'text-destructive')}>
                  {step.error ? '✗' : '·'} {toolLabel(step.name, t)}
                  {step.detail && <span className="text-foreground/80"> {step.detail}</span>}
                </div>
              ))}
            </>
          )}
          <button
            type="button"
            onClick={onOpen}
            className="mt-1.5 font-sans text-foreground underline-offset-2 hover:underline"
          >
            {t('Open full conversation')}
          </button>
        </div>
      )}
    </div>
  );
}

/** 人类消息的 @聊天 / $技能 引用（时间线只存标识，名称在这里查） */
function HumanRefs({
  refs,
}: {
  refs: NonNullable<Extract<GroupEntry, { kind: 'human' }>['refs']>;
}) {
  const { t } = useI18n();
  const chats = useBotsStore((s) => s.chats);
  const bots = useBotsStore((s) => s.bots);
  const skills = useSettingsStore((s) => s.skills);
  const chip = 'inline-flex h-6 max-w-56 items-center gap-1 rounded-md px-1.5 text-xs';
  return (
    <div className="mt-1 flex flex-wrap justify-end gap-1.5">
      {refs.skill && (
        <span className={cn(chip, 'bg-info/15 text-info')}>
          <Sparkles className="h-3 w-3 shrink-0" />
          <span className="min-w-0 truncate">
            {skills.find((skill) => skill.id === refs.skill)?.name ?? refs.skill}
          </span>
        </span>
      )}
      {refs.chats?.map((id) => {
        const chat = chats.find((item) => item.id === id);
        return (
          <span key={id} className={cn(chip, 'bg-muted')} title={t('Referenced chat')}>
            <MessagesSquare className="h-3 w-3 shrink-0" />
            <span className="min-w-0 truncate">
              {chat ? chatTitle(chat, bots, t) : t('Unavailable chat')}
            </span>
          </span>
        );
      })}
    </div>
  );
}
