import {
  Bot,
  Inbox,
  LayoutTemplate,
  PanelLeft,
  Settings,
  Target,
  UserPlus,
  Users,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ResizeHandle } from '@/components/chat/ResizeHandle';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useBotPendingCount, useBotsStore } from '@/stores/bots';
import { BotChatView } from './BotChatView';
import { seedBotDraft } from './BotComposer';
import { BotInbox } from './BotInbox';
import { BotSearchButton, BotSearchDialog } from './BotSearchDialog';
import { BotSidebar, CountBadge } from './BotSidebar';
import { GoalOnboarding, type GoalPick } from './GoalOnboarding';
import { NewBotDialog } from './NewBotDialog';
import { NewGroupDialog } from './NewGroupDialog';
import { NewTeamDialog } from './NewTeamDialog';

const RAIL_BUTTON =
  'relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

interface BotViewProps {
  sidebarWidth: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onResize: (deltaX: number) => void;
}

/** Bot 模式整块内容区：成员/群聊侧栏 + 聊天 / 收件箱 */
export function BotView({ sidebarWidth, collapsed, onToggleCollapse, onResize }: BotViewProps) {
  const { t } = useI18n();
  const view = useBotsStore((s) => s.view);
  const chats = useBotsStore((s) => s.chats);
  const bots = useBotsStore((s) => s.bots);
  const loaded = useBotsStore((s) => s.loaded);
  const setView = useBotsStore((s) => s.setView);
  const [newMember, setNewMember] = useState(false);
  const [newGroup, setNewGroup] = useState(false);
  const [newTeam, setNewTeam] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  /** 引导选定的推荐：交给成员 / 团队创建对话框，创建后把第一条消息填进输入框 */
  const [pick, setPick] = useState<GoalPick | null>(null);
  /** 创建对话框先关闭再回调 onCreated，第一条消息不能跟随 pick 一起被清掉 */
  const firstMessageRef = useRef('');
  const inboxCount = useBotPendingCount();

  const chat = view?.kind === 'chat' ? chats.find((item) => item.id === view.chatId) : undefined;

  // 记住的聊天已被删除：回到空态
  useEffect(() => {
    if (loaded && view?.kind === 'chat' && !chat) setView(null);
  }, [loaded, view, chat, setView]);

  const startPick = (next: GoalPick) => {
    setGoalOpen(false);
    setPick(next);
    firstMessageRef.current = next.firstMessage.trim();
    if (next.member) setNewMember(true);
    else setNewTeam(true);
  };
  const seedFirstMessage = (chatId: string) => {
    if (firstMessageRef.current) seedBotDraft(chatId, firstMessageRef.current);
    firstMessageRef.current = '';
  };
  /** 普通入口打开创建对话框：不带引导推荐 */
  const openMember = () => {
    setPick(null);
    firstMessageRef.current = '';
    setNewMember(true);
  };
  const openTeam = () => {
    setPick(null);
    firstMessageRef.current = '';
    setNewTeam(true);
  };

  return (
    <>
      {collapsed ? (
        <aside className="flex w-12 shrink-0 flex-col items-center gap-1 border-r bg-background py-2">
          <BotSearchButton className={RAIL_BUTTON} />
          <button
            type="button"
            className={RAIL_BUTTON}
            onClick={() => setGoalOpen(true)}
            title={t('Start from a goal')}
          >
            <Target className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={RAIL_BUTTON}
            onClick={openMember}
            title={t('New member')}
          >
            <UserPlus className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={RAIL_BUTTON}
            onClick={() => setNewGroup(true)}
            title={t('New group chat')}
          >
            <Users className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={RAIL_BUTTON}
            onClick={openTeam}
            title={t('Create team from template')}
          >
            <LayoutTemplate className="h-4 w-4" />
          </button>
          {(inboxCount > 0 || view?.kind === 'inbox') && (
            <button
              type="button"
              className={cn(RAIL_BUTTON, view?.kind === 'inbox' && 'bg-muted text-foreground')}
              onClick={() => setView({ kind: 'inbox' })}
              title={t('Inbox')}
            >
              <Inbox className="h-4 w-4" />
              {inboxCount > 0 && (
                <CountBadge count={inboxCount} className="-top-0.5 -right-1 absolute" />
              )}
            </button>
          )}
          <div className="flex-1" />
          <button
            type="button"
            className={RAIL_BUTTON}
            onClick={() => void window.electronAPI.window.openSettings()}
            title={t('Settings')}
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={RAIL_BUTTON}
            onClick={onToggleCollapse}
            title={t('Expand sidebar')}
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        </aside>
      ) : (
        <>
          <BotSidebar
            width={sidebarWidth}
            onCollapse={onToggleCollapse}
            onNewMember={openMember}
            onNewGroup={() => setNewGroup(true)}
            onNewTeam={openTeam}
            onStartFromGoal={() => setGoalOpen(true)}
          />
          <ResizeHandle onResize={onResize} />
        </>
      )}

      {view?.kind === 'inbox' ? (
        <BotInbox />
      ) : chat ? (
        <BotChatView key={chat.id} chat={chat} />
      ) : (
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-background px-6 text-center">
          <Bot className="h-8 w-8 text-muted-foreground" />
          <p className="font-medium text-lg">{t('Bot mode')}</p>
          <p className="max-w-md text-muted-foreground text-sm">
            {bots.length === 0
              ? t(
                  'Tell us in one sentence what you want done; we will recommend a member or a team and draft your first message.'
                )
              : t('Pick a member or a group chat on the left.')}
          </p>
          {bots.length === 0 && loaded && <GoalOnboarding onPick={startPick} />}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={bots.length === 0 ? 'outline' : 'default'}
              onClick={openMember}
            >
              <UserPlus />
              {t('New member')}
            </Button>
            {bots.length >= 2 && (
              <Button size="sm" variant="outline" onClick={() => setNewGroup(true)}>
                <Users />
                {t('New group chat')}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={openTeam}>
              <LayoutTemplate />
              {t('Create team from template')}
            </Button>
          </div>
        </div>
      )}

      <NewBotDialog
        open={newMember}
        onOpenChange={setNewMember}
        seed={pick?.member}
        onCreated={seedFirstMessage}
      />
      <NewGroupDialog open={newGroup} onOpenChange={setNewGroup} />
      <BotSearchDialog />
      <NewTeamDialog
        open={newTeam}
        onOpenChange={setNewTeam}
        seedTemplateId={pick?.templateId}
        onCreated={seedFirstMessage}
      />
      <Dialog open={goalOpen} onOpenChange={setGoalOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('Start from a goal')}</DialogTitle>
            <DialogDescription>
              {t(
                'Tell us in one sentence what you want done; we will recommend a member or a team and draft your first message.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex justify-center pb-4">
            {goalOpen && <GoalOnboarding onPick={startPick} />}
          </DialogPanel>
        </DialogContent>
      </Dialog>
    </>
  );
}
