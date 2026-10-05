import type {
  PairBotActivity,
  PairBotChatSummary,
  PairBotInboxItem,
  PairBotMember,
} from '@enso/pair';
import { cn } from '@/lib/utils';
import { BotAvatar } from './BotAvatar';
import { activityLine, botChatSections, chatActivities, inboxLabel } from './botState';

interface Props {
  bots: PairBotMember[];
  chats: PairBotChatSummary[];
  activeChatId: string | null;
  onSelect(chatId: string): void;
  /** 收件箱（未结束且未忽略）；提示类条目可忽略 */
  inbox?: PairBotInboxItem[];
  onDismiss?(key: string): void;
  /** 成员实时运行态：有就替换聊天行的末条摘要 */
  activities?: PairBotActivity[];
}

const STATUS_TEXT = { running: '工作中', queued: '排队中' } as const;

function lastLine(
  chat: PairBotChatSummary,
  byId: Map<string, PairBotMember>,
  live: PairBotActivity | undefined
): string {
  if (live) {
    const line = activityLine(live);
    const who = byId.get(live.botId)?.name;
    return chat.kind === 'group' && who ? `${who}：${line}` : line;
  }
  if (chat.status !== 'idle') return STATUS_TEXT[chat.status];
  const last = chat.last;
  if (!last) return chat.kind === 'group' ? `${chat.members.length} 位成员` : '';
  const who = last.kind === 'human' ? '我' : last.botId ? byId.get(last.botId)?.name : undefined;
  return who && chat.kind === 'group' ? `${who}：${last.text}` : last.text;
}

/** 抽屉「Bot」分段：群聊在上、成员私聊在下；新建/编辑只在桌面端 */
export function BotDrawerPanel({
  bots,
  chats,
  activeChatId,
  onSelect,
  inbox = [],
  onDismiss,
  activities = [],
}: Props) {
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const { groups, directs } = botChatSections(chats, bots);
  const row = (chat: PairBotChatSummary) => {
    const member = chat.kind === 'direct' ? byId.get(chat.members[0]) : undefined;
    const live = chatActivities(activities, chat.id)[0];
    const busy = live ? live.state !== 'queued' : chat.status === 'running';
    const idle = !live && chat.status === 'idle';
    return (
      <button
        key={chat.id}
        type="button"
        onClick={() => onSelect(chat.id)}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/60',
          chat.id === activeChatId && 'bg-muted'
        )}
      >
        {member ? (
          <BotAvatar bot={member} busy={busy} />
        ) : (
          <span className="flex shrink-0 -space-x-2">
            {chat.members.slice(0, 3).map((id) => (
              <BotAvatar key={id} bot={byId.get(id)} size="sm" />
            ))}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-sm">
            {member?.name ?? (chat.title || '群聊')}
          </span>
          <span
            className={cn('block truncate text-xs', idle ? 'text-muted-foreground' : 'text-brand')}
          >
            {lastLine(chat, byId, live) || member?.title || '\u00a0'}
          </span>
        </span>
      </button>
    );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {groups.length === 0 && directs.length === 0 && (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-muted-foreground text-sm">
            桌面端还没有 Bot 聊天
          </p>
        )}
        {inbox.length > 0 && (
          <div>
            <p className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
              收件箱 · {inbox.length}
            </p>
            {inbox.map((item) => {
              const member = item.botId ? byId.get(item.botId) : undefined;
              const owner = item.ownerBotId ? byId.get(item.ownerBotId) : undefined;
              return (
                <div key={item.key} className="flex items-center gap-2 rounded-lg px-2 py-2">
                  <button
                    type="button"
                    disabled={!item.chatId}
                    onClick={() => item.chatId && onSelect(item.chatId)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  >
                    <BotAvatar bot={member} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-sm">
                        {member?.name ?? '成员'}
                        {owner ? ` 替 ${owner.name}` : ''}
                        <span className="ml-1.5 font-normal text-brand text-xs">
                          {inboxLabel(item, Date.now())}
                        </span>
                      </span>
                      <span className="block truncate text-muted-foreground text-xs">
                        {item.text || '\u00a0'}
                      </span>
                    </span>
                  </button>
                  {item.dismissible && onDismiss && (
                    <button
                      type="button"
                      onClick={() => onDismiss(item.key)}
                      className="shrink-0 rounded px-2 py-1 text-muted-foreground text-xs hover:bg-muted"
                    >
                      忽略
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {groups.length > 0 && (
          <div>
            <p className="px-2 py-1.5 font-medium text-muted-foreground text-xs">群聊</p>
            {groups.map(row)}
          </div>
        )}
        {directs.length > 0 && (
          <div>
            <p className="px-2 py-1.5 font-medium text-muted-foreground text-xs">成员</p>
            {directs.map(row)}
          </div>
        )}
      </div>
      <p className="shrink-0 px-3 py-2 text-center text-[11px] text-muted-foreground">
        新建成员 / 群聊、例行任务请在桌面端管理
      </p>
    </div>
  );
}
