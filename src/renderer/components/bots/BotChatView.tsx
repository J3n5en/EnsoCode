import type { BotChat, BotProfile } from '@shared/types/bot';
import { findVirtualModel } from '@shared/virtualModels';
import { motion } from 'framer-motion';
import { Globe, Info, MessageSquarePlus, Shield, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApprovalBar } from '@/components/chat/ApprovalBar';
import { APPROVAL_MODE_META } from '@/components/chat/ApprovalModePicker';
import { AskBar } from '@/components/chat/AskBar';
import { CHAT_COL } from '@/components/chat/MessageTimeline';
import { ResizeHandle } from '@/components/chat/ResizeHandle';
import { sidePanelWidthTransition } from '@/components/sidepanel/sidePanelWidthAnim';
import { addToast } from '@/components/ui/toast';
import { useSpeechStatus } from '@/hooks/useSpeechStatus';
import { useIsMobile } from '@/hooks/useViewport';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { startDesktopVoiceSession } from '@/lib/voiceSession';
import { useBotsStore } from '@/stores/bots';
import { activeDelegations, delegationLiveTarget, pendingOwners } from '@/stores/bots/delegations';
import { chatSummary, type PendingItem, pendingItems } from '@/stores/bots/selectors';
import { groupReadMark } from '@/stores/bots/unread';
import { useMaterializedProviders } from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';
import {
  CHAT_MIN_WIDTH,
  resolveSidePanelWidth,
  SIDE_PANEL_HANDLE_WIDTH,
} from '@/stores/sidePanel/width';
import { ArtifactCards } from './ArtifactCards';
import { botAvatarSrc } from './avatarImage';
import { BotAvatar, GroupAvatar } from './BotAvatar';
import { BotBrowserPanel } from './BotBrowserPanel';
import {
  BotComposer,
  type BotComposerPayload,
  type ChatRefOption,
  type SkillOption,
} from './BotComposer';
import { BotLiveStatus } from './BotLiveStatus';
import { MemberBusyBar } from './BotPresence';
import { BotProfilePanel } from './BotProfilePanel';
import { chatErrorText, chatTitle } from './botText';
import { DelegationCard } from './DelegationCard';
import { GroupInfoPanel } from './GroupInfoPanel';
import { GroupTimeline } from './GroupTimeline';
import { LiveSessionDialog, LiveSessionTimeline, type MessageFocus } from './LiveSessionTimeline';
import { SessionHistoryDialog } from './SessionHistoryDialog';
import { SessionSwitcher } from './SessionSwitcher';
import { SilenceNote } from './SilenceNote';
import { ThreadSwitcher } from './ThreadSwitcher';
import { WorkspaceMenu } from './WorkspaceMenu';

export function useModelLabel(bot: BotProfile | undefined): string {
  const { t } = useI18n();
  const providers = useMaterializedProviders();
  const virtualModels = useSettingsStore((s) => s.virtualModels);
  if (!bot?.engine) return t('Default model');
  const { providerId, modelId } = bot.engine;
  const virtual = findVirtualModel(virtualModels, bot.engine);
  if (virtual) return virtual.name;
  const model = providers.find((p) => p.id === providerId)?.models.find((m) => m.id === modelId);
  return model?.label ?? modelId;
}

/** chat 为当前话题（群）或私聊；group 为根群，群级信息（成员面板、浏览器、工作区）按它展示 */
export function BotChatView({ chat, group = chat }: { chat: BotChat; group?: BotChat }) {
  const { t } = useI18n();
  const bots = useBotsStore((s) => s.bots);
  const chats = useBotsStore((s) => s.chats);
  const sessions = useBotsStore((s) => s.sessions);
  const queue = useBotsStore((s) => s.queue);
  const delegations = useBotsStore((s) => s.delegations);
  const timeline = useBotsStore((s) => s.timelines[chat.id]);
  const runtime = useBotsStore((s) => s.runtime[chat.id]);
  const markRead = useBotsStore((s) => s.markRead);
  const panelOpen = useBotsStore((s) => s.panelOpen);
  const panelTab = useBotsStore((s) => s.panelTab);
  const browserTabCount = useBotsStore((s) => s.browserTabs[group.id]?.tabs.length ?? 0);
  const panelWidth = useBotsStore((s) => s.panelWidth);
  const skillCatalog = useSettingsStore((s) => s.skills);
  const voiceInputEnabled = useSettingsStore((s) => s.voiceInputEnabled);
  const voiceModel = useSettingsStore((s) => s.voiceModel);
  const { status: speechStatus } = useSpeechStatus(voiceInputEnabled);
  const voiceReady =
    voiceInputEnabled &&
    speechStatus?.state !== 'unsupported' &&
    speechStatus?.models.find((model) => model.id === voiceModel)?.state === 'ready';
  const [resizing, setResizing] = useState(false);
  const [workspaceW, setWorkspaceW] = useState(0);
  // 窄屏没有并排空间：打开即全屏盖住聊天区
  const isMobile = useIsMobile();
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const parent = asideRef.current?.parentElement;
    if (!parent) return;
    const update = () => setWorkspaceW(parent.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);
  const width = isMobile ? workspaceW : resolveSidePanelWidth(panelWidth, workspaceW);
  const targetW = panelOpen ? width : 0;
  const resizePanel = useCallback((deltaX: number) => {
    const parent = asideRef.current?.parentElement;
    if (parent) useBotsStore.getState().nudgePanelWidth(-deltaX, parent.clientWidth);
  }, []);
  const [history, setHistory] = useState<{ id: string; title: string } | null>(null);
  const [historyFocus, setHistoryFocus] = useState<MessageFocus | undefined>();
  const [live, setLive] = useState<{ id: string; botId: string; title: string } | null>(null);
  const focus = useBotsStore((s) => (s.focus?.chatId === chat.id ? s.focus : null));
  const clearFocus = useBotsStore((s) => s.clearFocus);

  const byId = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const names = useMemo(() => Object.fromEntries(bots.map((bot) => [bot.id, bot.name])), [bots]);
  const members = chat.members.map((id) => byId.get(id)).filter((bot): bot is BotProfile => !!bot);
  const memberKey = members.map((bot) => `${bot.id}:${bot.skillIds.join(',')}`).join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: memberKey 概括成员与技能变化
  const skillOptions = useMemo<SkillOption[]>(
    () =>
      skillCatalog.flatMap((skill) => {
        const owners = members
          .filter((bot) => bot.skillIds.includes(skill.id))
          .map((bot) => bot.id);
        return owners.length
          ? [{ id: skill.id, name: skill.name, description: skill.description, owners }]
          : [];
      }),
    [skillCatalog, memberKey]
  );
  const chatOptions = useMemo<ChatRefOption[]>(
    () =>
      chats
        .filter((item) => item.id !== group.id && !item.parentId && item.archivedAt === undefined)
        .map((item) => ({ id: item.id, title: chatTitle(item, bots, t), kind: item.kind })),
    [chats, group.id, bots, t]
  );
  const summary = chatSummary(chat, { sessions, timeline, queue, names });
  const read = useBotsStore((s) => s.reads[summary.key]);
  // 群聊历史窗口里不把窗口之外的未读标为已读
  const readMark = chat.kind === 'group' ? groupReadMark(timeline, read) : summary.marker;
  const chatDelegations = useMemo(
    () => delegations.filter((item) => item.chatId === chat.id),
    [delegations, chat.id]
  );
  const pending = useMemo(
    () => pendingItems(sessions, pendingOwners(chats, delegations), chat.id),
    [sessions, chats, delegations, chat.id]
  );

  /** 只读会话的发言人：委派子会话 → 目标成员；否则按会话归属或时间线条目 */
  const speakerOf = (conversationId: string): BotProfile | undefined => {
    const delegated = chatDelegations.find((item) => item.childConversationId === conversationId);
    if (delegated) return byId.get(delegated.targetBotId);
    const owner = Object.entries(chat.sessions).find(
      ([, session]) => session.conversationId === conversationId
    )?.[0];
    const entry = timeline?.entries.find(
      (item) => item.kind === 'bot' && item.conversationId === conversationId
    );
    return byId.get(
      owner ?? (entry?.kind === 'bot' ? entry.botId : chat.kind === 'direct' ? chat.members[0] : '')
    );
  };
  const historySpeaker = history ? speakerOf(history.id) : undefined;
  const liveBot = live ? byId.get(live.botId) : undefined;
  const livePending = live ? pending.filter((item) => item.conversationId === live.id) : [];
  const liveTitle = live?.title ?? liveBot?.name ?? t('Deleted member');
  const liveQueued =
    live && delegations.find((item) => item.childConversationId === live.id)?.state === 'queued';

  /**
   * 委派「查看过程」与成员回复共用此回调：排队/进行中的委派子会话看实时投影
   * （排队时尚未落盘，历史是空的），其余走历史快照。
   */
  const openConversation = useCallback((conversationId: string, title: string) => {
    const target = delegationLiveTarget(useBotsStore.getState().delegations, conversationId);
    if (target) {
      if (!useBotsStore.getState().sessions[conversationId])
        void useBotsStore.getState().trackSession(conversationId);
      setLive({ id: conversationId, botId: target.botId, title });
    } else {
      setHistory({ id: conversationId, title });
    }
  }, []);

  useEffect(() => {
    markRead(summary.key, readMark);
  }, [markRead, summary.key, readMark]);

  useEffect(() => {
    if (chat.kind === 'group') {
      const state = useBotsStore.getState();
      // 重新进入停在历史窗口的群：回到最新（搜索跳转进来的除外）
      if (state.timelines[chat.id]?.history && state.focus?.chatId !== chat.id)
        void state.jumpLatest(chat.id);
      else void state.loadLatest(chat.id);
      void useBotsStore.getState().refreshRuntime(chat.id);
    }
  }, [chat.id, chat.kind]);

  const direct = chat.kind === 'direct' ? members[0] : undefined;
  const directConversationId = direct ? chat.sessions[direct.id]?.conversationId : undefined;
  const locator = focus?.locator;
  const directFocus =
    focus && locator?.kind === 'session' && locator.conversationId === directConversationId
      ? { messageIndex: locator.messageIndex, query: focus.query, nonce: focus.nonce }
      : undefined;
  const groupFocus =
    focus && locator?.kind === 'timeline'
      ? { seq: locator.seq, query: focus.query, nonce: focus.nonce }
      : undefined;

  // 命中私聊的历史会话（或已换新会话）：在只读历史弹窗里定位
  useEffect(() => {
    if (focus?.locator.kind !== 'session') return;
    if (focus.locator.conversationId === directConversationId) return;
    setHistory({ id: focus.locator.conversationId, title: t('History') });
    setHistoryFocus({
      messageIndex: focus.locator.messageIndex,
      query: focus.query,
      nonce: focus.nonce,
    });
    clearFocus(focus.nonce);
  }, [focus, directConversationId, clearFocus, t]);
  const historyId = history?.id;
  const historyFooter = useCallback(
    (messageIndex: number) =>
      chat.kind === 'direct' && historyId ? (
        <ArtifactCards target={{ chatId: chat.id, conversationId: historyId, messageIndex }} />
      ) : null,
    [chat.id, chat.kind, historyId]
  );
  const archived = chat.archivedAt !== undefined;
  const replying = runtime?.current ? byId.get(runtime.current) : undefined;

  const hint = (() => {
    if (archived) return t('This chat is archived. Restore it before sending.');
    if (chat.kind === 'group') {
      const base =
        chat.routing.mode === 'smart'
          ? t('Without @, the best-fit member is picked to reply')
          : t('Without @, the group owner replies');
      if (replying)
        return `${base} · ${t('{{name}} is replying; new messages are routed after they finish', { name: replying.name })}`;
      return base;
    }
    if (summary.running && direct)
      return t('{{name}} is working; your message joins the current turn', { name: direct.name });
    return null;
  })();

  const send = async ({ text, images, ...refs }: BotComposerPayload) => {
    const result = await useBotsStore.getState().send(chat.id, text, images, refs);
    if (!result.ok) {
      addToast({
        type: 'error',
        title: t('Message not sent'),
        description: chatErrorText(result.error, t),
      });
      return false;
    }
    if (result.queued) addToast({ type: 'info', title: t('Queued until a session slot frees up') });
    // 在历史窗口里发言：回到最新，看到自己刚发的消息
    if (useBotsStore.getState().timelines[chat.id]?.history)
      void useBotsStore.getState().jumpLatest(chat.id);
    return true;
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <header className="@container flex h-[52px] shrink-0 items-center gap-2.5 border-b px-4">
          {direct ? (
            <BotAvatar bot={direct} busy={summary.running} />
          ) : (
            <GroupAvatar bots={members} busy={summary.running} />
          )}
          <div className="min-w-0">
            <div className="truncate font-semibold text-sm">{chatTitle(chat, bots, t)}</div>
            <div className="truncate text-muted-foreground text-xs">
              {direct ? (
                <DirectSubtitle
                  bot={direct}
                  running={summary.running}
                  queued={summary.queued}
                  conversationId={chat.sessions[direct.id]?.conversationId}
                />
              ) : (
                t('{{n}} members · Owner {{name}}', {
                  n: members.length,
                  name: byId.get(chat.bossBotId ?? '')?.name ?? '—',
                })
              )}
            </div>
          </div>
          <div className="flex-1" />
          <WorkspaceMenu chat={group} />
          {direct ? (
            <>
              <SessionSwitcher
                chat={chat}
                botId={direct.id}
                running={summary.running}
                onView={(id, title) => setHistory({ id, title })}
              />
              <button
                type="button"
                disabled={archived}
                onClick={() =>
                  void window.electronAPI.bots.newSession(chat.id).then((result) => {
                    if (!result.ok)
                      addToast({ type: 'error', title: chatErrorText(result.error, t) });
                    else void useBotsStore.getState().refreshChats();
                  })
                }
                className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                title={t('New conversation')}
                aria-label={t('New conversation')}
              >
                <MessageSquarePlus className="h-3.5 w-3.5 shrink-0" />
                <span className="@min-[28rem]:inline hidden">{t('New conversation')}</span>
              </button>
            </>
          ) : (
            <ThreadSwitcher group={group} thread={chat} />
          )}
        </header>

        {direct ? (
          <>
            <ActiveDelegations
              items={activeDelegations(chatDelegations, chat.id)}
              bots={byId}
              onOpenConversation={openConversation}
            />
            <DirectTimeline chat={chat} bot={direct} focus={directFocus} onFocusDone={clearFocus} />
          </>
        ) : (
          <GroupTimeline
            chat={chat}
            bots={byId}
            timeline={timeline}
            runtime={runtime}
            delegations={chatDelegations}
            focus={groupFocus}
            onFocusDone={clearFocus}
            onLoadOlder={() => void useBotsStore.getState().loadOlder(chat.id)}
            onLoadNewer={() => void useBotsStore.getState().loadNewer(chat.id)}
            onLoadAround={(seq) => useBotsStore.getState().loadAround(chat.id, seq)}
            onJumpLatest={() => void useBotsStore.getState().jumpLatest(chat.id)}
            onOpenConversation={openConversation}
            onOpenLive={(id, botId) =>
              setLive({ id, botId, title: byId.get(botId)?.name ?? t('Deleted member') })
            }
          />
        )}

        <div className="@container pt-1">
          <div className={cn(CHAT_COL, 'pb-4')}>
            {direct && (summary.running || summary.queued) && (
              <BotLiveStatus
                conversationId={chat.sessions[direct.id]?.conversationId}
                className="mb-2 rounded-lg border bg-muted/30 px-3 py-2"
              />
            )}
            <PendingBars items={pending} bots={byId} showNames={chat.kind === 'group'} />
            {chat.kind === 'group' && (
              <MemberBusyBar
                chatId={chat.id}
                memberIds={chat.members}
                bots={byId}
                onOpenLive={(id, botId) =>
                  setLive({ id, botId, title: byId.get(botId)?.name ?? t('Deleted member') })
                }
              />
            )}
            <BotComposer
              key={chat.id}
              chatId={chat.id}
              placeholder={
                direct
                  ? t('Message {{name}}…', { name: direct.name })
                  : t('@ a member, or just say it…')
              }
              members={chat.kind === 'group' ? members : undefined}
              chatOptions={chatOptions}
              skills={skillOptions}
              voice={voiceReady ? startDesktopVoiceSession : undefined}
              requestMicAccess={window.electronAPI.speech.requestMicAccess}
              running={summary.running || Boolean(runtime?.current || runtime?.routing)}
              disabled={archived}
              hint={hint}
              toolbar={direct ? <DirectChips bot={direct} /> : null}
              onSend={send}
              onStop={() => void useBotsStore.getState().stop(chat.id)}
            />
          </div>
        </div>
      </div>

      {panelOpen && !isMobile && (
        <ResizeHandle onResize={resizePanel} onResizingChange={setResizing} />
      )}
      <motion.aside
        ref={asideRef}
        initial={false}
        animate={{ width: targetW }}
        style={
          isMobile
            ? undefined
            : { maxWidth: `max(0px, calc(100% - ${CHAT_MIN_WIDTH + SIDE_PANEL_HANDLE_WIDTH}px))` }
        }
        transition={sidePanelWidthTransition({ skip: resizing, cover: isMobile, targetW })}
        className={cn(
          'flex min-h-0 shrink-0 flex-col overflow-hidden bg-background',
          isMobile ? 'absolute inset-y-0 right-0 z-10' : 'relative'
        )}
      >
        {/* 内容固定目标宽度，开合动画只裁切不重排 */}
        <div
          className={cn('flex h-full min-h-0 flex-col', !panelOpen && 'invisible')}
          style={{ width }}
        >
          <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
            {(['info', 'browser'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => useBotsStore.getState().setPanelTab(tab)}
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors',
                  panelTab === tab
                    ? 'bg-brand/10 font-medium text-foreground dark:bg-brand/15'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {tab === 'info' ? (
                  <Info className="h-3.5 w-3.5" />
                ) : (
                  <Globe className="h-3.5 w-3.5" />
                )}
                {tab === 'info' ? t(direct ? 'Member' : 'Group info') : t('Browser')}
                {tab === 'browser' && browserTabCount > 0 && (
                  <span className="text-muted-foreground tabular-nums">{browserTabCount}</span>
                )}
              </button>
            ))}
          </div>
          {panelTab === 'browser' ? (
            <BotBrowserPanel chatId={group.id} visible={panelOpen} />
          ) : direct ? (
            <BotProfilePanel botId={direct.id} chat={chat} onOpenHistory={openConversation} />
          ) : (
            <GroupInfoPanel chat={group} thread={chat} onOpenConversation={openConversation} />
          )}
        </div>
      </motion.aside>

      <SessionHistoryDialog
        conversationId={history?.id ?? null}
        title={history?.title ?? ''}
        speaker={
          historySpeaker
            ? {
                name: historySpeaker.name,
                color: historySpeaker.avatar.color,
                image: botAvatarSrc(historySpeaker),
              }
            : undefined
        }
        focus={historyFocus}
        turnFooter={historyFooter}
        onClose={() => {
          setHistory(null);
          setHistoryFocus(undefined);
        }}
      />
      <LiveSessionDialog
        conversationId={live?.id ?? null}
        title={liveTitle}
        speaker={{
          name: liveBot?.name ?? liveTitle,
          color: liveBot?.avatar.color ?? '#64748b',
          image: liveBot ? botAvatarSrc(liveBot) : undefined,
        }}
        emptyTitle={liveQueued ? t('Queued and has not started yet') : undefined}
        emptyDescription={liveQueued ? '' : undefined}
        footer={
          liveBot && livePending.length > 0 ? (
            <PendingBars items={livePending} bots={byId} showNames={false} />
          ) : undefined
        }
        onClose={() => setLive(null)}
      />
    </div>
  );
}

/** 私聊顶部：该成员发起、仍在进行的委派 */
function ActiveDelegations({
  items,
  bots,
  onOpenConversation,
}: {
  items: ReturnType<typeof activeDelegations>;
  bots: Map<string, BotProfile>;
  onOpenConversation: (conversationId: string, title: string) => void;
}) {
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <div className="shrink-0 border-b bg-muted/30">
      <div className={cn(CHAT_COL, 'py-2')}>
        <div className="mb-1.5 text-muted-foreground text-xs">
          {t('Delegations in progress · {{n}}', { n: items.length })}
        </div>
        <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
          {items.map((record) => (
            <DelegationCard
              key={record.id}
              record={record}
              bots={bots}
              onOpenConversation={onOpenConversation}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DirectSubtitle({
  bot,
  running,
  queued,
  conversationId,
}: {
  bot: BotProfile;
  running: boolean;
  queued: boolean;
  conversationId: string | undefined;
}) {
  const { t } = useI18n();
  const model = useModelLabel(bot);
  const status = running ? t('Working') : queued ? t('Queued') : t('Idle');
  return (
    <>
      {[bot.title, model, status].filter(Boolean).join(' · ')}
      {running && <SilenceNote conversationId={conversationId} className="ml-1.5 text-warning" />}
    </>
  );
}

function DirectChips({ bot }: { bot: BotProfile }) {
  const { t } = useI18n();
  const model = useModelLabel(bot);
  const meta = APPROVAL_MODE_META[bot.approvalMode];
  return (
    <>
      <span className="flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground text-xs">
        <Sparkles className="h-3 w-3 shrink-0" />
        <span className="max-w-32 truncate">{model}</span>
      </span>
      <span className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground text-xs">
        <Shield className="h-3 w-3" />
        {t(meta.labelKey)}
      </span>
    </>
  );
}

function DirectTimeline({
  chat,
  bot,
  focus,
  onFocusDone,
}: {
  chat: BotChat;
  bot: BotProfile;
  focus?: MessageFocus;
  onFocusDone: (nonce: number) => void;
}) {
  const { t } = useI18n();
  const conversationId = chat.sessions[bot.id]?.conversationId;
  const archived = chat.archivedAt !== undefined;
  // 私聊当前会话可回退 / 重试；Main 校验空闲并收尾委派与记忆水位
  const controls = useMemo(() => {
    if (archived || !conversationId) return undefined;
    const report = (result: { ok: boolean; error?: string }) => {
      if (!result.ok)
        addToast({ type: 'error', title: chatErrorText(result.error ?? 'unavailable', t) });
    };
    return {
      subscribe: useBotsStore.subscribe,
      projection: () => useBotsStore.getState().sessions[conversationId],
      rewind: (entryId: string, restoreFiles: boolean) =>
        void useBotsStore.getState().rewind(chat.id, entryId, restoreFiles).then(report),
      retry: () => void useBotsStore.getState().retry(chat.id).then(report),
    };
  }, [chat.id, conversationId, archived, t]);
  const turnFooter = useCallback(
    (messageIndex: number) =>
      conversationId ? (
        <ArtifactCards target={{ chatId: chat.id, conversationId, messageIndex }} />
      ) : null,
    [chat.id, conversationId]
  );
  if (!conversationId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <BotAvatar bot={bot} size="lg" />
        <p className="font-medium text-lg">{bot.name}</p>
        <p className="max-w-sm text-muted-foreground text-sm">{bot.scope || bot.title}</p>
      </div>
    );
  }
  return (
    <LiveSessionTimeline
      conversationId={conversationId}
      speaker={{ name: bot.name, color: bot.avatar.color, image: botAvatarSrc(bot) }}
      emptyTitle={t('Say hi to {{name}}', { name: bot.name })}
      focus={focus}
      onFocusDone={onFocusDone}
      turnFooter={turnFooter}
      controls={controls}
      dataSlot="bot-timeline"
    />
  );
}

/** 该聊天相关成员会话的待审批 / 提问，按会话分组内联在输入框上方 */
export function PendingBars({
  items,
  bots,
  showNames,
}: {
  items: PendingItem[];
  bots: Map<string, BotProfile>;
  showNames: boolean;
}) {
  const { t } = useI18n();
  const groups = new Map<string, PendingItem[]>();
  for (const item of items)
    groups.set(item.conversationId, [...(groups.get(item.conversationId) ?? []), item]);
  return (
    <>
      {[...groups.entries()].map(([conversationId, list]) => {
        const bot = bots.get(list[0].botId);
        const delegation = list[0].delegation;
        const name = bot?.name ?? t('Deleted member');
        const approvals = list.flatMap((item) => (item.kind === 'approval' ? [item.request] : []));
        const asks = list.flatMap((item) => (item.kind === 'ask' ? [item.request] : []));
        return (
          <div key={conversationId} data-pending-conversation={conversationId}>
            {(showNames || delegation) && (
              <div className="mb-1 flex items-center gap-1.5 text-muted-foreground text-xs">
                <BotAvatar bot={bot} size="xs" />
                {delegation
                  ? t('{{name}} (on behalf of {{owner}}) needs you', {
                      name,
                      owner: bots.get(delegation.parentBotId)?.name ?? t('Deleted member'),
                    })
                  : t('{{name}} needs you', { name })}
              </div>
            )}
            <ApprovalBar
              approvals={approvals}
              onRespond={(requestId, decision) =>
                void window.electronAPI.agent.respondApproval(conversationId, requestId, decision)
              }
            />
            <AskBar
              asks={asks}
              onAnswer={(requestId, answer) =>
                void window.electronAPI.agent.respondAsk(conversationId, requestId, answer)
              }
            />
          </div>
        );
      })}
    </>
  );
}
