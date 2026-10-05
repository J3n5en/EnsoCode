import type { BotChat, BotProfile } from '@shared/types/bot';
import type { BotChatUpdateInput } from '@shared/types/botIpc';
import {
  AlarmClock,
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  CircleCheck,
  Copy,
  Inbox,
  LayoutTemplate,
  Mail,
  MoreHorizontal,
  PanelLeftClose,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Target,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubPopup,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useBotPendingCount, useBotsStore } from '@/stores/bots';
import { pendingOwners } from '@/stores/bots/delegations';
import {
  type ChatSummary,
  chatSummary,
  pendingItems,
  reorderPinned,
  snoozeTimes,
  sortChats,
} from '@/stores/bots/selectors';
import { isUnread, unreadMark } from '@/stores/bots/unread';
import { BotAvatar, GroupAvatar } from './BotAvatar';
import { BotSearchButton } from './BotSearchDialog';
import { chatErrorText, chatTitle } from './botText';
import { CloneGroupDialog } from './CloneGroupDialog';

const ICON_BUTTON_CLASS =
  'relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

interface BotSidebarProps {
  width: number;
  onCollapse: () => void;
  onNewMember: () => void;
  onNewGroup: () => void;
  onNewTeam: () => void;
  onStartFromGoal: () => void;
}

export function BotSidebar({
  width,
  onCollapse,
  onNewMember,
  onNewGroup,
  onNewTeam,
  onStartFromGoal,
}: BotSidebarProps) {
  const { t, locale } = useI18n();
  const createActions = [
    { label: t('Start from a goal'), icon: Target, onClick: onStartFromGoal },
    { label: t('New member'), icon: UserPlus, onClick: onNewMember },
    { label: t('New group chat'), icon: Users, onClick: onNewGroup },
    { label: t('Create team from template'), icon: LayoutTemplate, onClick: onNewTeam },
  ];
  const bots = useBotsStore((s) => s.bots);
  const chats = useBotsStore((s) => s.chats);
  const queue = useBotsStore((s) => s.queue);
  const sessions = useBotsStore((s) => s.sessions);
  const delegations = useBotsStore((s) => s.delegations);
  const timelines = useBotsStore((s) => s.timelines);
  const reads = useBotsStore((s) => s.reads);
  const view = useBotsStore((s) => s.view);
  const setView = useBotsStore((s) => s.setView);
  const openDirect = useBotsStore((s) => s.openDirect);
  const upsertChat = useBotsStore((s) => s.upsertChat);
  const upsertBot = useBotsStore((s) => s.upsertBot);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveQuery, setArchiveQuery] = useState('');
  const [deleting, setDeleting] = useState<BotChat | null>(null);
  const [cloning, setCloning] = useState<BotChat | null>(null);

  const byId = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const names = useMemo(() => Object.fromEntries(bots.map((bot) => [bot.id, bot.name])), [bots]);
  const pending = useMemo(
    () => pendingItems(sessions, pendingOwners(chats, delegations)),
    [sessions, chats, delegations]
  );
  const rows = useMemo(
    () =>
      chats.map((chat) => ({
        chat,
        summary: {
          ...chatSummary(chat, { sessions, timeline: timelines[chat.id], queue, names }),
          pending: pending.filter((item) => item.chatId === chat.id).length,
        },
      })),
    [chats, sessions, timelines, queue, names, pending]
  );
  const live = rows.filter((row) => !row.chat.archivedAt);
  const groups = sortChats(
    live.filter((row) => row.chat.kind === 'group' && row.chat.settledAt === undefined)
  );
  const directByBot = new Map(
    live.filter((row) => row.chat.kind === 'direct').map((row) => [row.chat.members[0], row])
  );
  const members = bots
    .filter(
      (bot) => bot.archivedAt === undefined && directByBot.get(bot.id)?.chat.settledAt === undefined
    )
    .map((bot) => ({ bot, row: directByBot.get(bot.id) }))
    .sort((a, b) => {
      const pin = Number(b.row?.chat.pinned ?? false) - Number(a.row?.chat.pinned ?? false);
      const order =
        (a.row?.chat.pinOrder ?? Number.POSITIVE_INFINITY) -
        (b.row?.chat.pinOrder ?? Number.POSITIVE_INFINITY);
      return (
        pin ||
        (a.row?.chat.pinned && order ? order : 0) ||
        (b.row?.summary.activityAt ?? b.bot.updatedAt) -
          (a.row?.summary.activityAt ?? a.bot.updatedAt)
      );
    });
  /** 已搁置：最近搁置的在前；成员已归档的私聊不列 */
  const settled = live
    .filter(
      (row) =>
        row.chat.settledAt !== undefined &&
        (row.chat.kind === 'group' || byId.get(row.chat.members[0])?.archivedAt === undefined)
    )
    .sort((a, b) => (b.chat.settledAt ?? 0) - (a.chat.settledAt ?? 0));
  const pinnedGroups = groups.filter((row) => row.chat.pinned).map((row) => row.chat.id);
  const pinnedDirects = members.flatMap(({ row }) => (row?.chat.pinned ? [row.chat.id] : []));
  const [dragging, setDragging] = useState<string | null>(null);
  const [showSettled, setShowSettled] = useState(true);
  const archivedChats = rows.filter((row) => row.chat.archivedAt !== undefined);
  const archivedBots = bots.filter((bot) => bot.archivedAt !== undefined);
  const archivedCount = archivedChats.length + archivedBots.length;
  const archiveNeedle = archiveQuery.trim().toLowerCase();
  const archiveMatch = (...texts: string[]) =>
    !archiveNeedle || texts.some((text) => text.toLowerCase().includes(archiveNeedle));
  const shownArchivedChats = archivedChats
    .filter(({ chat, summary }) => archiveMatch(chatTitle(chat, bots, t), summary.preview ?? ''))
    .sort((a, b) => (b.chat.archivedAt ?? 0) - (a.chat.archivedAt ?? 0));
  const shownArchivedBots = archivedBots
    .filter((bot) => archiveMatch(bot.name, bot.title, bot.scope))
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  const inboxCount = useBotPendingCount();
  const activeChatId = view?.kind === 'chat' ? view.chatId : null;

  const updateChat = async (chat: BotChat, patch: Omit<BotChatUpdateInput, 'chatId'>) => {
    const result = await window.electronAPI.bots.updateChat({ chatId: chat.id, ...patch });
    if (result.ok) upsertChat(result.chat);
    else addToast({ type: 'error', title: chatErrorText(result.error, t) });
  };
  /** 置顶时排到置顶末尾 */
  const togglePin = (chat: BotChat) =>
    updateChat(
      chat,
      chat.pinned
        ? { pinned: false }
        : {
            pinned: true,
            pinOrder:
              Math.max(
                -1,
                ...chats.filter((item) => item.pinned).map((item) => item.pinOrder ?? 0)
              ) + 1,
          }
    );
  const movePinned = (ids: string[], chatId: string, toIndex: number) => {
    const orders = Object.fromEntries(chats.map((chat) => [chat.id, chat.pinOrder]));
    for (const change of reorderPinned(ids, chatId, toIndex, orders)) {
      const chat = chats.find((item) => item.id === change.chatId);
      if (chat) void updateChat(chat, { pinOrder: change.pinOrder });
    }
  };
  const manage = (chat: BotChat, pinnedIds: string[]): ChatManageActions => {
    const index = pinnedIds.indexOf(chat.id);
    const summary = rows.find((row) => row.chat.id === chat.id)?.summary;
    return {
      onSettle: () => void updateChat(chat, { settled: chat.settledAt === undefined }),
      onSnooze: (at) => void updateChat(chat, { snoozedUntil: at }),
      onMarkUnread:
        summary &&
        activeChatId !== chat.id &&
        !isUnread(summary.marker, reads[summary.key]) &&
        unreadMark(summary.marker) !== undefined
          ? () => useBotsStore.getState().markUnread(chat.id)
          : undefined,
      onMoveUp: index > 0 ? () => movePinned(pinnedIds, chat.id, index - 1) : undefined,
      onMoveDown:
        index >= 0 && index < pinnedIds.length - 1
          ? () => movePinned(pinnedIds, chat.id, index + 1)
          : undefined,
    };
  };
  /** 置顶行之间拖拽排序 */
  const dragProps = (chat: BotChat | undefined, pinnedIds: string[]) =>
    chat?.pinned
      ? {
          draggable: true,
          onDragStart: (event: React.DragEvent) => {
            event.dataTransfer.effectAllowed = 'move';
            setDragging(chat.id);
          },
          onDragEnd: () => setDragging(null),
          onDragOver: (event: React.DragEvent) => {
            if (dragging && dragging !== chat.id && pinnedIds.includes(dragging))
              event.preventDefault();
          },
          onDrop: (event: React.DragEvent) => {
            event.preventDefault();
            if (dragging && pinnedIds.includes(dragging))
              movePinned(pinnedIds, dragging, pinnedIds.indexOf(chat.id));
            setDragging(null);
          },
        }
      : {};
  const archiveBot = async (bot: BotProfile, archived: boolean) => {
    const result = await window.electronAPI.bots.archive(bot.id, archived);
    if (result.ok) upsertBot(result.bot);
    else addToast({ type: 'error', title: result.error });
  };

  const status = (summary: ChatSummary | undefined): string | null => {
    if (!summary) return null;
    if (summary.running) return t('Working');
    if (summary.queued) return t('Queued');
    return summary.activityAt ? formatRelativeTime(summary.activityAt, locale) : null;
  };

  return (
    <aside
      className="flex shrink-0 flex-col overflow-hidden border-r bg-background"
      style={{ width }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto pt-2 pb-2">
        <SectionHeader title={t('Group chats')} onAdd={onNewGroup} addLabel={t('New group chat')} />
        {groups.length === 0 && (
          <p className="px-4 py-1 text-muted-foreground text-xs">{t('No group chats yet')}</p>
        )}
        {groups.map(({ chat, summary }) => (
          <ChatContextMenu
            key={chat.id}
            chat={chat}
            onPin={() => void togglePin(chat)}
            onArchive={() => void updateChat(chat, { archived: true })}
            onDelete={() => setDeleting(chat)}
            onClone={() => setCloning(chat)}
            manage={manage(chat, pinnedGroups)}
          >
            <ChatRow
              {...dragProps(chat, pinnedGroups)}
              active={activeChatId === chat.id}
              avatar={
                <GroupAvatar bots={chat.members.map((id) => byId.get(id))} busy={summary.running} />
              }
              title={chatTitle(chat, bots, t)}
              pinned={chat.pinned}
              meta={status(summary)}
              preview={summary.preview}
              unread={isUnread(summary.marker, reads[summary.key]) && activeChatId !== chat.id}
              pending={summary.pending}
              onClick={() => setView({ kind: 'chat', chatId: chat.id })}
            />
          </ChatContextMenu>
        ))}

        <SectionHeader title={t('Members')} onAdd={onNewMember} addLabel={t('New member')} />
        {members.length === 0 && (
          <p className="px-4 py-1 text-muted-foreground text-xs">{t('No members yet')}</p>
        )}
        {members.map(({ bot, row }) => (
          <ChatContextMenu
            key={bot.id}
            chat={row?.chat}
            onPin={row ? () => void togglePin(row.chat) : undefined}
            onArchive={row ? () => void updateChat(row.chat, { archived: true }) : undefined}
            onArchiveMember={() => void archiveBot(bot, true)}
            manage={row ? manage(row.chat, pinnedDirects) : undefined}
          >
            <ChatRow
              {...dragProps(row?.chat, pinnedDirects)}
              active={Boolean(row && activeChatId === row.chat.id)}
              avatar={<BotAvatar bot={bot} busy={row?.summary.running} />}
              title={bot.name}
              pinned={row?.chat.pinned}
              meta={status(row?.summary)}
              preview={row?.summary.preview || bot.title || bot.scope}
              unread={Boolean(
                row &&
                  isUnread(row.summary.marker, reads[row.summary.key]) &&
                  activeChatId !== row.chat.id
              )}
              pending={row?.summary.pending ?? 0}
              onClick={() => void openDirect(bot.id)}
            />
          </ChatContextMenu>
        ))}

        {settled.length > 0 && (
          <SectionHeader
            title={`${t('Settled')} · ${settled.length}`}
            onToggle={() => setShowSettled((value) => !value)}
          />
        )}
        {showSettled &&
          settled.map(({ chat, summary }) => {
            const bot = chat.kind === 'direct' ? byId.get(chat.members[0]) : undefined;
            return (
              <ChatContextMenu
                key={chat.id}
                chat={chat}
                onPin={() => void togglePin(chat)}
                onArchive={() => void updateChat(chat, { archived: true })}
                onClone={chat.kind === 'group' ? () => setCloning(chat) : undefined}
                manage={manage(chat, [])}
              >
                <ChatRow
                  className="opacity-75"
                  active={activeChatId === chat.id}
                  avatar={
                    bot ? (
                      <BotAvatar bot={bot} busy={summary.running} />
                    ) : (
                      <GroupAvatar
                        bots={chat.members.map((id) => byId.get(id))}
                        busy={summary.running}
                      />
                    )
                  }
                  title={bot ? bot.name : chatTitle(chat, bots, t)}
                  meta={
                    chat.snoozedUntil !== undefined
                      ? t('Remind {{time}}', {
                          time: formatRelativeTime(chat.snoozedUntil, locale),
                        })
                      : status(summary)
                  }
                  preview={summary.preview}
                  unread={isUnread(summary.marker, reads[summary.key]) && activeChatId !== chat.id}
                  pending={summary.pending}
                  onClick={() =>
                    bot ? void openDirect(bot.id) : setView({ kind: 'chat', chatId: chat.id })
                  }
                />
              </ChatContextMenu>
            );
          })}
      </div>

      <div className="@container flex shrink-0 items-center justify-between border-t p-2">
        <button
          type="button"
          onClick={onCollapse}
          className={ICON_BUTTON_CLASS}
          title={t('Collapse sidebar')}
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
        <div className="flex items-center">
          <BotSearchButton className={ICON_BUTTON_CLASS} />
          {createActions.map(({ label, icon: Icon, onClick }) => (
            <button
              key={label}
              type="button"
              className={cn(ICON_BUTTON_CLASS, 'hidden @min-[18.5rem]:flex')}
              onClick={onClick}
              title={label}
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
          <Menu>
            <MenuTrigger
              className={cn(ICON_BUTTON_CLASS, '@min-[18.5rem]:hidden')}
              title={t('More actions')}
            >
              <MoreHorizontal className="h-4 w-4" />
            </MenuTrigger>
            <MenuPopup align="end" side="top">
              {createActions.map(({ label, icon: Icon, onClick }) => (
                <MenuItem key={label} onClick={onClick}>
                  <Icon />
                  {label}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
          {(inboxCount > 0 || view?.kind === 'inbox') && (
            <button
              type="button"
              className={cn(
                ICON_BUTTON_CLASS,
                view?.kind === 'inbox' && 'bg-muted text-foreground'
              )}
              onClick={() => setView({ kind: 'inbox' })}
              title={t('Inbox')}
            >
              <Inbox className="h-4 w-4" />
              {inboxCount > 0 && (
                <CountBadge count={inboxCount} className="-top-0.5 -right-1 absolute" />
              )}
            </button>
          )}
          {archivedCount > 0 && (
            <button
              type="button"
              className={ICON_BUTTON_CLASS}
              onClick={() => {
                setArchiveQuery('');
                setArchiveOpen(true);
              }}
              title={`${t('Archived')} (${archivedCount})`}
            >
              <Archive className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            className={ICON_BUTTON_CLASS}
            onClick={() => void window.electronAPI.window.openSettings()}
            title={t('Settings')}
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </div>

      <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <DialogContent className="h-[min(40rem,85vh)] max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-baseline gap-2">
              {t('Archived')}
              <span className="font-sans text-muted-foreground text-sm tabular-nums">
                {archivedCount}
              </span>
            </DialogTitle>
            <InputGroup data-size="sm" className="mt-1">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                value={archiveQuery}
                placeholder={t('Search conversations...')}
                onChange={(event) => setArchiveQuery(event.target.value)}
              />
            </InputGroup>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-y-3 border-t pt-3!">
            {shownArchivedChats.length + shownArchivedBots.length === 0 && (
              <p className="py-10 text-center text-muted-foreground text-sm">
                {archiveQuery.trim() ? t('No matching conversations') : t('Nothing archived')}
              </p>
            )}
            {shownArchivedChats.length > 0 && (
              <ArchivedGroup title={t('Chat threads')} count={shownArchivedChats.length}>
                {shownArchivedChats.map(({ chat, summary }) => (
                  <ArchivedRow
                    key={chat.id}
                    avatar={
                      chat.kind === 'group' ? (
                        <GroupAvatar bots={chat.members.map((id) => byId.get(id))} />
                      ) : (
                        <BotAvatar bot={byId.get(chat.members[0])} />
                      )
                    }
                    title={chatTitle(chat, bots, t)}
                    preview={summary.preview}
                    onOpen={() => {
                      setView({ kind: 'chat', chatId: chat.id });
                      setArchiveOpen(false);
                    }}
                    onRestore={() => void updateChat(chat, { archived: false })}
                    onDelete={chat.kind === 'group' ? () => setDeleting(chat) : undefined}
                  />
                ))}
              </ArchivedGroup>
            )}
            {shownArchivedBots.length > 0 && (
              <ArchivedGroup title={t('Members')} count={shownArchivedBots.length}>
                {shownArchivedBots.map((bot) => (
                  <ArchivedRow
                    key={bot.id}
                    avatar={<BotAvatar bot={bot} />}
                    title={bot.name}
                    preview={bot.title || bot.scope}
                    onRestore={() => void archiveBot(bot, false)}
                  />
                ))}
              </ArchivedGroup>
            )}
          </DialogPanel>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('Delete group chat?')}
        description={t(
          'The group timeline and its standalone workspace are deleted. Member sessions stay readable in their history.'
        )}
        confirmLabel={t('Delete')}
        onConfirm={() => {
          const chat = deleting;
          setDeleting(null);
          if (!chat) return;
          void window.electronAPI.bots.deleteChat(chat.id).then((result) => {
            if (!result.ok) addToast({ type: 'error', title: chatErrorText(result.error, t) });
            else {
              if (activeChatId === chat.id) setView(null);
              void useBotsStore.getState().refreshChats();
            }
          });
        }}
      />
      <CloneGroupDialog chat={cloning} onOpenChange={(open) => !open && setCloning(null)} />
    </aside>
  );
}

export function CountBadge({ count, className }: { count: number; className?: string }) {
  return (
    <span
      className={cn(
        'min-w-4 rounded-full bg-destructive px-1 text-center font-medium text-[10px] text-white leading-4',
        className
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

function ArchivedGroup({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 pr-0.5 pl-2">
        <span className="min-w-0 flex-1 truncate py-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
          {title}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">{count}</span>
      </div>
      <div className="flex flex-col gap-y-0.5">{children}</div>
    </div>
  );
}

function ArchivedRow({
  avatar,
  title,
  preview,
  onOpen,
  onRestore,
  onDelete,
}: {
  avatar: ReactNode;
  title: string;
  preview?: string;
  onOpen?: () => void;
  onRestore: () => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  const action =
    'shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100';
  return (
    <div className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/60">
      <button
        type="button"
        disabled={!onOpen}
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:cursor-default"
      >
        {avatar}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{title}</span>
          {preview && (
            <span className="block truncate text-muted-foreground text-xs">{preview}</span>
          )}
        </span>
      </button>
      <button type="button" className={action} onClick={onRestore} title={t('Unarchive')}>
        <ArchiveRestore className="h-3.5 w-3.5" />
      </button>
      {onDelete && (
        <button
          type="button"
          className={cn(action, 'hover:text-destructive')}
          onClick={onDelete}
          title={t('Delete')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function SectionHeader({
  title,
  onAdd,
  addLabel,
  onToggle,
}: {
  title: string;
  onAdd?: () => void;
  addLabel?: string;
  onToggle?: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-4 pt-3 pb-1 text-[11px] text-muted-foreground">
      {onToggle ? (
        <button type="button" onClick={onToggle} className="hover:text-foreground">
          {title}
        </button>
      ) : (
        <span>{title}</span>
      )}
      {onAdd && (
        <button
          type="button"
          onClick={onAdd}
          title={addLabel}
          aria-label={addLabel}
          className="rounded p-0.5 transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

interface ChatRowProps extends React.ComponentProps<'div'> {
  active: boolean;
  avatar: ReactNode;
  title: string;
  pinned?: boolean;
  meta?: string | null;
  preview?: string;
  unread?: boolean;
  pending?: number;
  action?: { label: string; onClick: () => void };
}

function ChatRow({
  active,
  avatar,
  title,
  pinned,
  meta,
  preview,
  unread,
  pending = 0,
  action,
  className,
  ...rest
}: ChatRowProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      {...rest}
      onKeyDown={(event) => {
        if (event.key === 'Enter') rest.onClick?.(event as never);
      }}
      className={cn(
        'mx-1.5 flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-muted',
        active && 'bg-muted',
        className
      )}
    >
      {avatar}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 truncate font-medium text-sm">{title}</span>
          {pinned && <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />}
          <span className="flex-1" />
          {pending > 0 ? (
            <CountBadge count={pending} />
          ) : (
            meta && <span className="shrink-0 text-[11px] text-muted-foreground">{meta}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">{preview}</span>
          {unread && <span className="h-2 w-2 shrink-0 rounded-full bg-info" />}
          {action && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                action.onClick();
              }}
              className="shrink-0 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-background hover:text-foreground"
            >
              {action.label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface ChatManageActions {
  onSettle: () => void;
  onSnooze: (at: number) => void;
  onMarkUnread?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

function ChatContextMenu({
  chat,
  children,
  onPin,
  onArchive,
  onDelete,
  onArchiveMember,
  onClone,
  manage,
}: {
  chat: BotChat | undefined;
  children: React.ReactElement;
  onPin?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  onArchiveMember?: () => void;
  onClone?: () => void;
  manage?: ChatManageActions;
}) {
  const { t } = useI18n();
  const snooze = (key: 'hour' | 'later' | 'tomorrow') =>
    manage?.onSnooze(snoozeTimes(Date.now())[key]);
  return (
    <ContextMenu>
      <ContextMenuTrigger render={children as React.ReactElement<Record<string, unknown>>} />
      <ContextMenuPopup className="min-w-40">
        {onPin && (
          <ContextMenuItem onClick={onPin}>
            {chat?.pinned ? <PinOff /> : <Pin />}
            {chat?.pinned ? t('Unpin') : t('Pin')}
          </ContextMenuItem>
        )}
        {manage?.onMoveUp && (
          <ContextMenuItem onClick={manage.onMoveUp}>
            <ArrowUp />
            {t('Move up')}
          </ContextMenuItem>
        )}
        {manage?.onMoveDown && (
          <ContextMenuItem onClick={manage.onMoveDown}>
            <ArrowDown />
            {t('Move down')}
          </ContextMenuItem>
        )}
        {manage && (
          <ContextMenuItem onClick={manage.onSettle}>
            {chat?.settledAt !== undefined ? <RotateCcw /> : <CircleCheck />}
            {chat?.settledAt !== undefined ? t('Back to in progress') : t('Settle')}
          </ContextMenuItem>
        )}
        {manage && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <AlarmClock />
              {t('Remind me later')}
            </ContextMenuSubTrigger>
            <ContextMenuSubPopup className="min-w-36">
              <ContextMenuItem onClick={() => snooze('hour')}>{t('In 1 hour')}</ContextMenuItem>
              <ContextMenuItem onClick={() => snooze('later')}>{t('In 3 hours')}</ContextMenuItem>
              <ContextMenuItem onClick={() => snooze('tomorrow')}>
                {t('Tomorrow 9:00')}
              </ContextMenuItem>
            </ContextMenuSubPopup>
          </ContextMenuSub>
        )}
        {manage?.onMarkUnread && (
          <ContextMenuItem onClick={manage.onMarkUnread}>
            <Mail />
            {t('Mark as unread')}
          </ContextMenuItem>
        )}
        {onClone && (
          <ContextMenuItem onClick={onClone}>
            <Copy />
            {t('Clone group chat')}
          </ContextMenuItem>
        )}
        {onArchive && (
          <ContextMenuItem onClick={onArchive}>
            <Archive />
            {t('Archive chat')}
          </ContextMenuItem>
        )}
        {onArchiveMember && (
          <ContextMenuItem onClick={onArchiveMember}>
            <ArchiveRestore />
            {t('Archive member')}
          </ContextMenuItem>
        )}
        {onDelete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 />
              {t('Delete group chat')}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuPopup>
    </ContextMenu>
  );
}
