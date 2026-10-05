import type { BotProfile } from '@shared/types/bot';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from '@/components/ui/preview-card';
import { type TFunction, useI18n } from '@/i18n';
import { useBotsStore } from '@/stores/bots';
import { formatElapsed } from '@/stores/bots/delegations';
import {
  busyMembers,
  busyNote,
  lastHumanAt,
  type MemberPresence,
  memberPresence,
  type PresenceContext,
  type PresenceInfo,
  presenceTarget,
} from '@/stores/bots/presence';
import { BotAvatar } from './BotAvatar';
import { failureText } from './DelegationCard';
import { PresenceChip, presenceLabel } from './PresenceMark';

function usePresenceContext(chatId: string): PresenceContext {
  const chat = useBotsStore((s) => s.chats.find((item) => item.id === chatId));
  const sessions = useBotsStore((s) => s.sessions);
  const queue = useBotsStore((s) => s.queue);
  const silences = useBotsStore((s) => s.silences);
  const delegations = useBotsStore((s) => s.delegations);
  const holders = useBotsStore((s) => s.browserHolders);
  const chatTabs = useBotsStore((s) => s.browserTabs[chatId]?.tabs);
  const clearedAt = useBotsStore((s) => lastHumanAt(s.timelines[chatId]?.entries ?? []));
  return useMemo(
    () => ({
      chat: chat ?? { id: chatId, sessions: {} },
      delegations,
      sessions,
      queue,
      silences,
      clearedAt,
      holders,
      tabIds: chatTabs ?? [],
    }),
    [chat, chatId, delegations, sessions, queue, silences, clearedAt, holders, chatTabs]
  );
}

/** 成员在该聊天的状态（成员会话 + 进行中委派子会话；做完 / 失败保留到下一条人类消息） */
export function useMemberPresence(chatId: string, botId: string): MemberPresence {
  const ctx = usePresenceContext(chatId);
  return useMemo(() => memberPresence(botId, ctx), [botId, ctx]);
}

function waitText(info: PresenceInfo, t: TFunction): string | undefined {
  const wait = info.wait;
  switch (wait?.kind) {
    case 'approval':
      return t('Your approval: {{title}}', { title: wait.title });
    case 'ask':
      return t('Your answer: {{title}}', { title: wait.title });
    case 'file':
      return t('{{holder}} is editing {{file}}', { holder: wait.holder, file: wait.file });
    case 'workspace':
      return t('{{holder}} is running a workspace-wide command', { holder: wait.holder });
    case 'capacity':
      return t('A free slot (concurrency limit, not a person)');
    case 'turn':
      return t('Its previous turn to finish');
    default:
      return undefined;
  }
}

/** 跳到输入框上方该会话的审批 / 提问条并闪一下 */
function revealPending(conversationId: string) {
  const el = document.querySelector<HTMLElement>(
    `[data-pending-conversation="${CSS.escape(conversationId)}"]`
  );
  el?.scrollIntoView({ block: 'nearest' });
  el?.animate([{ backgroundColor: 'var(--color-warning)' }, { backgroundColor: 'transparent' }], {
    duration: 1200,
  });
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-12 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

/** 悬停详情：在做什么、谁派的、用时、在等什么、在用哪个标签页（侧栏与忙碌条共用） */
function PresenceDetails({ info, bot }: { info: MemberPresence; bot: BotProfile | undefined }) {
  const { t } = useI18n();
  const parent = useBotsStore((s) =>
    info.delegation ? s.bots.find((item) => item.id === info.delegation?.parentBotId) : undefined
  );
  const record = info.delegation;
  const wait = waitText(info, t);
  const browserTitle = useBotsStore((s) =>
    info.browserTab ? s.browserTitles[info.browserTab] || t('Browser') : undefined
  );
  const pending = info.wait && 'conversationId' in info.wait ? info.wait.conversationId : undefined;
  return (
    <PreviewCardPopup align="start" className="w-72 flex-col gap-1.5 p-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-sm">{bot?.name ?? t('Deleted member')}</span>
        <PresenceChip info={info} />
      </div>
      {info.state === 'idle' ? (
        <div className="text-muted-foreground">{t('Nothing in progress')}</div>
      ) : (
        <>
          {record && (
            <>
              <Row label={t('Task')}>
                <span className="line-clamp-2">{record.task}</span>
              </Row>
              <Row label={t('From')}>{parent?.name ?? t('Deleted member')}</Row>
              <Row label={t('Time')}>
                {formatElapsed((record.finishedAt ?? Date.now()) - record.createdAt)}
              </Row>
            </>
          )}
          {wait && <Row label={t('Waiting on')}>{wait}</Row>}
          {browserTitle && (
            <Row label={t('Browser')}>
              <span className="line-clamp-1">{browserTitle}</span>
            </Row>
          )}
          {info.quietSince !== undefined && (
            <div className="text-muted-foreground">
              {t('Still running, no output for {{time}}', {
                time: formatElapsed(Date.now() - info.quietSince),
              })}
            </div>
          )}
          {record && info.state === 'stuck' && record.state === 'failed' && (
            <div className="text-muted-foreground">{failureText(record, t)}</div>
          )}
          {record && info.state === 'done' && record.result && (
            <div className="line-clamp-3 text-muted-foreground">{record.result}</div>
          )}
          {pending && (
            <Button size="xs" className="mt-1 self-start" onClick={() => revealPending(pending)}>
              {t('Go handle it')}
            </Button>
          )}
        </>
      )}
    </PreviewCardPopup>
  );
}

/** 带状态角标的成员头像；悬停看在做什么、谁派的、用时、在等什么 */
export function PresenceAvatar({
  chatId,
  botId,
  bot,
  size = 'sm',
}: {
  chatId: string;
  botId: string;
  bot: BotProfile | undefined;
  size?: 'xs' | 'sm' | 'md';
}) {
  const { t } = useI18n();
  const info = useMemberPresence(chatId, botId);
  return (
    <PreviewCard>
      <PreviewCardTrigger render={<span className="relative inline-flex shrink-0" />}>
        <BotAvatar bot={bot} size={size} presence={info.state} />
        <span className="sr-only">{presenceLabel(info, t)}</span>
      </PreviewCardTrigger>
      <PresenceDetails info={info} bot={bot} />
    </PreviewCard>
  );
}

/** 输入框上方忙碌条：只列非闲成员，全闲不显示；点击打开其正在跑的过程，等你跳到审批 / 提问 */
export function MemberBusyBar({
  chatId,
  memberIds,
  bots,
  onOpenLive,
}: {
  chatId: string;
  memberIds: readonly string[];
  bots: Map<string, BotProfile>;
  onOpenLive: (conversationId: string, botId: string) => void;
}) {
  const { t } = useI18n();
  const ctx = usePresenceContext(chatId);
  const busy = useMemo(() => busyMembers(memberIds, ctx), [memberIds, ctx]);
  if (busy.length === 0) return null;
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1">
      {busy.map(({ botId, info }) => {
        const bot = bots.get(botId);
        const name = bot?.name ?? t('Deleted member');
        const note = busyNote(info);
        const target = presenceTarget(info);
        return (
          <PreviewCard key={botId}>
            <PreviewCardTrigger
              render={
                <button
                  type="button"
                  onClick={() =>
                    target?.kind === 'pending'
                      ? revealPending(target.conversationId)
                      : target && onOpenLive(target.conversationId, botId)
                  }
                  className="flex h-7 min-w-0 items-center gap-1.5 rounded-full px-1 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
                />
              }
            >
              <BotAvatar bot={bot} size="xs" presence={info.state} />
              {note ? (
                <span className="max-w-56 truncate pr-1.5">
                  {[name, presenceLabel(info, t), note].join(' · ')}
                </span>
              ) : (
                <span className="sr-only">{`${name} · ${presenceLabel(info, t)}`}</span>
              )}
            </PreviewCardTrigger>
            <PresenceDetails info={info} bot={bot} />
          </PreviewCard>
        );
      })}
    </div>
  );
}
