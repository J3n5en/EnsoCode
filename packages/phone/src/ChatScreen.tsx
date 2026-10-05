import type { CatalogEntry } from '@enso/pair';
import { localCompactionNoticeIndex } from '@shared/pair/guestProjection';
import type { AttachedImage, ProjectedMessage, SlashCommand } from '@shared/types/agent';
import type { StartVoiceSession } from '@shared/types/speech';
import {
  Bot,
  ChevronDown,
  ChevronLeft,
  Loader2,
  MessageCircle,
  PanelLeft,
  SquarePen,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { ApprovalBar } from '@/components/chat/ApprovalBar';
import { AskBar } from '@/components/chat/AskBar';
import { Composer } from '@/components/chat/Composer';
import { ChatHostContext } from '@/components/chat/chatHost';
import { EnsoMark } from '@/components/chat/EnsoMark';
import { GoalBar } from '@/components/chat/GoalBar';
import { MessageQueue } from '@/components/chat/MessageQueue';
import {
  CHAT_COL,
  MessageTimeline,
  type MessageTimelineHandle,
} from '@/components/chat/MessageTimeline';
import { RetryBar } from '@/components/chat/RetryBar';
import { TaskBar } from '@/components/chat/TaskBar';
import { TodoBar } from '@/components/chat/TodoBar';
import { cn } from '@/lib/utils';
import { buildTimeline } from '@/stores/sessions/timeline';
import { BotArtifacts } from './BotArtifacts';
import { phoneChatHost } from './chatHost';
import type { ConnState, SessionView } from './client';
import { compressWithin, imageBudget } from './image';
import { appendEchoMessages, type QueueSendEcho } from './queueSendEcho';
import { readOnlyBanner } from './readOnly';
import { SessionStatsLine } from './SessionStatsLine';
import { setDisplayedConversation } from './stubs/sessions-store';

interface Props {
  sessionId: string | null;
  title: string;
  projectName: string;
  /** 工具执行目录：项目内绝对路径在时间线里收成相对路径 */
  cwd?: string;
  view: SessionView | null;
  /** 本机时钟 − host 时钟（审批 / 提问卡剩余时间） */
  clockOffset?: number;
  connState: ConnState;
  stateLabel: string;
  /** 订阅会话同步中：标题旁状态灯用 amber pulse */
  syncing?: boolean;
  canCreate: boolean;
  onOpenDrawer(): void;
  onNewSession(): void;
  /** 当前模型标签；undefined = 子会话或目录未含模型信息，不显示切换入口 */
  modelLabel?: string;
  onOpenConfig?(): void;
  /** 还有更早的历史可上滑加载 */
  hasOlder?: boolean;
  /** 上滑翻页在途 */
  historyLoading?: boolean;
  onLoadOlder?(): void;
  /** 桌面语音识别可用时才给：Composer 据此显示麦克风 */
  voice?: StartVoiceSession;
  /** coworker tab 组（仅当父会话雇有 coworker 时有值）：主会话 + 子会话 */
  tabGroup?: { parent: CatalogEntry; children: CatalogEntry[] };
  onSelectTab?(sessionId: string): void;
  /** 排队中的消息（桌面下发）：本轮未结束时发的消息先入队 */
  queued?: { id: string; text: string; hasImages?: boolean }[];
  /** 马上发送的本地乐观回显：steer 送达前浮在权威消息之后 */
  echoes?: QueueSendEcho[];
  /** 会话目标（桌面下发）：GoalBar 展示与暂停/继续/清除 */
  goal?: CatalogEntry['goal'];
  /** 输入框下状态栏的上下文占用（桌面下发） */
  context?: CatalogEntry['context'];
  usageTotals?: CatalogEntry['usageTotals'];
  slashCommands?: SlashCommand[];
  onSend(text: string, images: AttachedImage[]): void;
  onAbort(): void;
  onApproval(requestId: string, decision: 'allow' | 'allowSession' | 'deny'): void;
  onAsk(requestId: string, answer: string): void;
  /** Bot 成员会话：发送走 bot-send，无回退/重试/斜杠命令；readOnly = 群聊「查看过程」 */
  bot?: { readOnly?: boolean; onBack?(): void; notice?: string | null; outbox?: ReactNode };
  /** Bot 私聊：每轮最终回复下方挂产物卡片与 send_image 图 */
  artifacts?: { chatId: string; conversationId: string };
  /** 桌面把本设备设为只读：只能查看，隐藏输入/审批/回答等写操作 */
  deviceReadOnly?: boolean;
  /** 有写操作刚被桌面以只读拦下 */
  readOnlyRejected?: boolean;
}

/** 会话页：复用桌面的时间线 / 审批条 / 输入框，保持与桌面一致的渲染 */
export function ChatScreen(props: Props) {
  const { view, sessionId } = props;
  const timelineRef = useRef<MessageTimelineHandle>(null);
  // tabs sliding：pill 位置/尺寸由 JS 测量写入，CSS 负责补间；首帧挂起过渡避免从 0 宽飞入
  const tabsRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const pillReady = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: effect 通过 ref 读写 DOM，依赖项是重定位 pill/镜像层的真实触发信号
  useLayoutEffect(() => {
    const bar = tabsRef.current;
    const pill = pillRef.current;
    const active = bar?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!bar || !pill || !active) return;
    if (!pillReady.current) pill.style.transition = 'none';
    pill.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
    pill.style.width = `${active.offsetWidth}px`;
    pill.style.height = `${active.offsetHeight}px`;
    if (!pillReady.current) {
      void pill.offsetWidth;
      pill.style.transition = '';
      pillReady.current = true;
    }
  }, [sessionId, props.tabGroup]);
  const running = view?.status === 'running';
  const bot = props.bot;
  const readOnly = Boolean(bot?.readOnly || props.deviceReadOnly);
  const artifactChatId = props.artifacts?.chatId;
  const artifactConversationId = props.artifacts?.conversationId;
  const host = useMemo(
    () => ({
      ...phoneChatHost({ sessionId, bot, deviceReadOnly: props.deviceReadOnly }),
      ...(artifactChatId && artifactConversationId
        ? {
            turnFooter: (messageIndex: number) => (
              <BotArtifacts
                target={{
                  chatId: artifactChatId,
                  conversationId: artifactConversationId,
                  messageIndex,
                }}
              />
            ),
          }
        : {}),
    }),
    [sessionId, bot, props.deviceReadOnly, artifactChatId, artifactConversationId]
  );
  const slashCommands = useMemo<SlashCommand[]>(() => {
    if (bot) return [];
    const base: SlashCommand[] = [
      {
        name: '/goal',
        description: 'Set a session goal (/goal <objective> · pause · resume · clear)',
      },
      {
        name: '/compact',
        description: 'Compact the context now (/compact [summary focus])',
      },
    ];
    const extra = (props.slashCommands ?? []).filter(
      (command) => command.name !== '/goal' && command.name !== '/compact'
    );
    return [...base, ...extra];
  }, [props.slashCommands, bot]);

  const entries = useMemo(
    () => (view ? [...view.messages.entries()].sort((a, b) => a[0] - b[0]) : []),
    [view]
  );
  const messages = useMemo<ProjectedMessage[]>(
    () =>
      appendEchoMessages(
        entries.map(([, message]) => message),
        props.echoes ?? [],
        sessionId ?? ''
      ),
    [entries, props.echoes, sessionId]
  );
  const started = messages.length > 0 || view?.status === 'running' || view?.status === 'failed';

  // 供复用组件内部读取（RunningElapsed 计时；Rewind/Retry 入口）
  setDisplayedConversation(
    sessionId
      ? {
          id: sessionId,
          projectId: '',
          status: view?.status ?? 'idle',
          started,
          spawning: false,
          messages,
          queuedMessages: props.queued?.map((q) => ({ id: q.id, text: q.text })),
        }
      : null
  );

  const timeline = useMemo(
    () =>
      buildTimeline(messages, running, [], props.cwd, {
        pendingApprovals: view?.approvals,
        compaction: view?.compaction,
        // 尾窗是稀疏绝对 index，buildTimeline 要的是数组下标
        compactionNoticeAt: localCompactionNoticeIndex(
          entries.map(([index]) => index),
          view?.compactionNoticeAt
        ),
      }),
    [
      messages,
      entries,
      running,
      props.cwd,
      view?.approvals,
      view?.compaction,
      view?.compactionNoticeAt,
    ]
  );

  /*
   * 上滑分页的滚动锚定：iOS Safari 不支持 overflow-anchor，旧页插到顶部后
   * scrollTop 不动、内容整体下压，画面会跳到更早的消息。请求前记下
   * scrollHeight，旧页渲染完（最早 index 变小）用差值补偿 scrollTop。
   */
  const minIndex = view?.messages.size ? Math.min(...view.messages.keys()) : null;
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const loadOlder = useCallback(() => {
    if (!props.hasOlder || !props.onLoadOlder) return;
    const el = timelineRef.current?.getScroller();
    anchorRef.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
    props.onLoadOlder();
  }, [props.hasOlder, props.onLoadOlder]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: minIndex 变小 = 旧页已渲染，此时才补偿
  useLayoutEffect(() => {
    const el = timelineRef.current?.getScroller();
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    anchorRef.current = null;
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
  }, [minIndex]);

  /*
   * 兜底跟随：Virtuoso 的 followOutput 只在 data 长度变化时触发，而流式输出是
   * 按同一 index 覆盖最后一条、长度不变，于是不会跟随。这里在时间线内容变化时
   * 补一次单帧贴底——不能用 scrollToBottom，那会为每次更新都起一个纠正循环，
   * 叠在一起抢滚动位置会让画面闪烁。贴底判定用 Virtuoso 自己的（自己算
   * scrollHeight 会被 increaseViewportBy 的预渲染空间干扰，距底永远归不了零）。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: timeline 是触发信号，effect 内只用 ref
  useEffect(() => {
    if (timelineRef.current?.isAtBottom()) timelineRef.current.pinToBottom();
  }, [timeline]);

  const send = async (text: string, images: AttachedImage[]) => {
    // 手机拍照动辄数 MB，压到单帧上限内再发
    const budget = imageBudget(images.length);
    const compressed: AttachedImage[] = [];
    for (const image of images) {
      compressed.push(await compressImageIfNeeded(image, budget));
    }
    props.onSend(text, compressed);
    timelineRef.current?.scrollToBottom();
  };

  return (
    <ChatHostContext.Provider value={host}>
      <div className="phone-chat-root flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center gap-1 border-b bg-background px-2 py-2 pt-safe">
          <button
            type="button"
            onClick={bot?.onBack ?? props.onOpenDrawer}
            aria-label={bot?.onBack ? '返回群聊' : '打开会话列表'}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {bot?.onBack ? (
              <ChevronLeft className="h-4.5 w-4.5" />
            ) : (
              <PanelLeft className="h-4.5 w-4.5" />
            )}
          </button>
          <div className="min-w-0 flex-1 text-center">
            <p className="flex min-w-0 items-center justify-center gap-1.5">
              {props.connState !== 'host-offline' && props.connState !== 'unauthorized' && (
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    props.connState === 'online' && !props.syncing
                      ? 'bg-emerald-500'
                      : 'animate-pulse bg-amber-500'
                  )}
                  title={
                    props.connState === 'online' && props.syncing ? '同步中…' : props.stateLabel
                  }
                />
              )}
              <span className="truncate font-medium text-sm">{props.title}</span>
            </p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {props.projectName || props.stateLabel}
            </p>
          </div>
          {bot ? (
            <span className="h-9 w-9 shrink-0" />
          ) : (
            <button
              type="button"
              onClick={props.onNewSession}
              disabled={!props.canCreate}
              aria-label="新建会话"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <SquarePen className="h-4.5 w-4.5" />
            </button>
          )}
        </header>

        {props.connState === 'host-offline' && (
          <div className="flex shrink-0 items-center justify-center gap-1.5 bg-amber-500/10 py-1 text-amber-700 text-xs dark:text-amber-400">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            <span>{props.stateLabel}</span>
          </div>
        )}

        {/* coworker tab 条：与桌面 CoworkerTabs 同观感，无 coworker 时不渲染；手机不提供雇佣/解雇 */}
        {props.tabGroup && props.tabGroup.children.length > 0 && (
          <div
            ref={tabsRef}
            role="tablist"
            className="t-tabs relative flex shrink-0 items-center justify-start gap-1 overflow-x-auto border-b px-2 py-1"
          >
            <span
              ref={pillRef}
              aria-hidden="true"
              className="t-tabs-pill pointer-events-none absolute top-0 left-0 z-0 rounded-md bg-muted"
            />
            <button
              type="button"
              role="tab"
              aria-selected={sessionId === props.tabGroup.parent.id}
              className={tabClass(sessionId === props.tabGroup.parent.id)}
              onClick={() => props.onSelectTab?.(props.tabGroup?.parent.id ?? '')}
            >
              <MessageCircle className="h-3 w-3 shrink-0" />
              <span className="max-w-40 truncate">{props.tabGroup.parent.title || '新对话'}</span>
            </button>
            {props.tabGroup.children.map((child) => (
              <button
                key={child.id}
                type="button"
                role="tab"
                aria-selected={sessionId === child.id}
                className={tabClass(sessionId === child.id)}
                onClick={() => props.onSelectTab?.(child.id)}
              >
                <Bot className="h-3 w-3 shrink-0" />
                <span className="max-w-28 truncate">{child.title || 'coworker'}</span>
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    child.status === 'running'
                      ? 'animate-pulse bg-brand'
                      : child.status === 'failed'
                        ? 'bg-destructive'
                        : 'bg-muted-foreground/30'
                  )}
                />
              </button>
            ))}
          </div>
        )}

        {sessionId === null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="mb-3 flex size-11 items-center justify-center rounded-[13px] border border-brand/20 bg-brand/8 text-brand dark:bg-brand/14">
              <EnsoMark className="size-6" />
            </span>
            <p className="font-semibold text-[22px] tracking-tight">EnsoCode</p>
            <p className="text-muted-foreground text-sm">
              {props.connState === 'online' ? '从左上角选择会话，或新建一个' : props.stateLabel}
            </p>
          </div>
        ) : (
          <MessageTimeline
            key={sessionId}
            ref={timelineRef}
            items={timeline}
            // 本地已有正文就不要盖「正在读取历史」；无正文且同步中才是加载态
            busy={view === null ? Boolean(props.syncing) : running}
            loading={view === null}
            running={running}
            error={undefined}
            emptyTitle={props.projectName || 'EnsoCode'}
            // 手机端不虚拟化：见 MessageTimeline 里 virtualize 的说明
            virtualize={false}
            historyLoading={props.historyLoading}
            hasOlder={props.hasOlder}
            firstItemIndex={minIndex ?? 0}
            onStartReached={props.hasOlder ? loadOlder : undefined}
          />
        )}

        {sessionId !== null && (
          // 浏览器里 safe-area 为 0，用 0.5rem 兜底不贴边；standalone 下取
          // home indicator 的实际高度，不再叠加，避免下方留出多余空白
          <div className="phone-dock @container shrink-0 pt-1 pb-safe">
            <div className={CHAT_COL}>
              {/* 自动重试横幅：只展示不可取消（pair 桥无 abort-retry 通道，整轮 abort 已够用） */}
              {view?.retry && <RetryBar retry={view.retry} />}
              {/* 排队区：复用桌面组件，编辑/删除/立即发送/打断并发送经桩发 pair 命令 */}
              {!readOnly && (
                <MessageQueue
                  conversationId={sessionId}
                  queued={(props.queued ?? []).map((q) => ({ id: q.id, text: q.text }))}
                />
              )}
              {props.goal && !readOnly && (
                <GoalBar conversationId={sessionId} goal={{ ...props.goal, noProgressRuns: 0 }} />
              )}
              <TodoBar key={sessionId} conversationId={sessionId} />
              {/* 后台任务 / subagent 胶囊：停止按钮经 stub 发 pair 命令 */}
              <TaskBar
                sessionId={sessionId}
                tasks={view?.tasks ?? []}
                subagents={view?.subagents ?? []}
                readOnly={props.deviceReadOnly}
              />
              {bot?.outbox}
              {bot?.notice && (
                <p className="mb-1 rounded-md bg-destructive/10 px-2 py-1 text-destructive text-xs">
                  {bot.notice}
                </p>
              )}
              {props.deviceReadOnly ? (
                <p className="mb-1 rounded-md bg-muted px-2 py-1 text-center text-muted-foreground text-xs">
                  {readOnlyBanner(props.readOnlyRejected)}
                </p>
              ) : (
                <>
                  <ApprovalBar
                    approvals={view?.approvals ?? []}
                    onRespond={props.onApproval}
                    clockOffset={props.clockOffset}
                  />
                  <AskBar
                    asks={view?.asks ?? []}
                    onAnswer={props.onAsk}
                    clockOffset={props.clockOffset}
                  />
                </>
              )}
              {!readOnly && (
                <Composer
                  commands={slashCommands}
                  running={running}
                  busy={running}
                  locked={(view?.approvals ?? []).length > 0}
                  focusKey={sessionId}
                  // 移动端不自动聚焦：一进会话就弹键盘会挡住消息
                  autoFocus={false}
                  // 软键盘的「换行」就是 Enter：Enter 只换行，发送必须点按钮
                  enterToSend={false}
                  toolbar={
                    props.modelLabel && props.onOpenConfig ? (
                      <button
                        type="button"
                        onClick={props.onOpenConfig}
                        className="flex min-w-0 items-center gap-0.5 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        <span className="truncate">{props.modelLabel}</span>
                        <ChevronDown className="h-3 w-3 shrink-0" />
                      </button>
                    ) : undefined
                  }
                  onSend={(payload) => {
                    // 手机端不支持 @mention 派发，只取文本与图片
                    void send(payload.text, payload.images);
                    return undefined;
                  }}
                  onAbort={props.onAbort}
                  voice={props.voice}
                  voiceMode="hold"
                />
              )}
              {!readOnly && (
                <SessionStatsLine usageTotals={props.usageTotals} context={props.context} />
              )}
            </div>
          </div>
        )}
      </div>
    </ChatHostContext.Provider>
  );
}

/** 与桌面 CoworkerTabs 的 tabClass 同款 */
function tabClass(active: boolean): string {
  return cn(
    't-tab flex min-w-0 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
    active ? 'font-medium' : 'text-muted-foreground'
  );
}

/** Composer 已把图片读成 base64，这里只在超出本张预算（整帧按张数均分）时再压一轮 */
async function compressImageIfNeeded(image: AttachedImage, budget: number): Promise<AttachedImage> {
  if (image.data.length * 0.75 <= budget) return image;
  const blob = await (await fetch(`data:${image.mimeType};base64,${image.data}`)).blob();
  return compressWithin(new File([blob], 'image', { type: image.mimeType }), budget);
}
