import { buildTeamFile, type TeamFile } from '@shared/bots/team';
import {
  addCustomTemplate,
  parseTeamTemplate,
  teamTemplateFromSpec,
} from '@shared/bots/templateLibrary';
import type { BotChat, BotProfile, BotRoutingMode } from '@shared/types/bot';
import type { BotChatUpdateInput } from '@shared/types/botIpc';
import {
  BellOff,
  BookmarkPlus,
  Crown,
  Download,
  MoreHorizontal,
  Plus,
  UserMinus,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { useBotsStore } from '@/stores/bots';
import { updateTemplateLibrary } from '@/stores/bots/templateLibrary';
import { useSettingsStore } from '@/stores/settings';
import { BotAvatar } from './BotAvatar';
import { PresenceAvatar } from './BotPresence';
import { chatErrorText } from './botText';
import { GroupDelegations, TaskBoard } from './GroupBoard';
import { MemorySpaceList } from './MemorySpaceList';
import { NotesEditor } from './NotesEditor';
import { RoutineList } from './RoutineList';
import { WorkspaceMenu } from './WorkspaceMenu';

export function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h4 className="mb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
        {title}
      </h4>
      {children}
    </section>
  );
}

export function KeyValue({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-dashed py-1.5 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{value}</span>
    </div>
  );
}

/** 团队文件：人设逐个从 Main 取，其余剥离由 buildTeamFile 完成 */
async function teamFileOf(chat: BotChat, bots: readonly BotProfile[]): Promise<TeamFile | null> {
  const personas: Record<string, string> = {};
  for (const botId of chat.members) {
    const result = await window.electronAPI.bots.get(botId);
    if (!result.ok) return null;
    personas[botId] = result.persona;
  }
  return buildTeamFile(chat, bots, personas, new Date().toISOString());
}

async function exportTeam(chat: BotChat, bots: readonly BotProfile[]): Promise<boolean> {
  const file = await teamFileOf(chat, bots);
  if (!file) return false;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `${chat.title || 'team'}.team.json`;
  link.click();
  URL.revokeObjectURL(url);
  return true;
}

async function saveTeamTemplate(chat: BotChat, bots: readonly BotProfile[]): Promise<boolean> {
  const file = await teamFileOf(chat, bots);
  const data = file && parseTeamTemplate(teamTemplateFromSpec(file.team));
  if (!data) return false;
  return updateTemplateLibrary((library) => ({
    ...library,
    teams: addCustomTemplate(library.teams, data, crypto.randomUUID()),
  }));
}

export function GroupInfoPanel({
  chat,
  onOpenConversation,
}: {
  chat: BotChat;
  onOpenConversation: (conversationId: string, title: string) => void;
}) {
  const { t } = useI18n();
  const bots = useBotsStore((s) => s.bots);
  const runtime = useBotsStore((s) => s.runtime[chat.id]);
  const upsertChat = useBotsStore((s) => s.upsertChat);
  const openDirect = useBotsStore((s) => s.openDirect);
  const projects = useSettingsStore((s) => s.projects);
  const byId = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const [title, setTitle] = useState(chat.title);
  const [hops, setHops] = useState(String(chat.routing.maxHops));
  const [turns, setTurns] = useState(String(chat.routing.maxTurnsPerBot));
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    setTitle(chat.title);
    setHops(String(chat.routing.maxHops));
    setTurns(String(chat.routing.maxTurnsPerBot));
  }, [chat.title, chat.routing.maxHops, chat.routing.maxTurnsPerBot]);

  const update = async (patch: Omit<BotChatUpdateInput, 'chatId' | 'expectedVersion'>) => {
    const result = await window.electronAPI.bots.updateChat({
      chatId: chat.id,
      expectedVersion: chat.version,
      ...patch,
    });
    if (result.ok) upsertChat(result.chat);
    else {
      addToast({ type: 'error', title: chatErrorText(result.error, t) });
      void useBotsStore.getState().refreshChats();
    }
  };

  const members = chat.members.map((id) => ({ id, bot: byId.get(id) }));
  const muted = chat.routing.muted ?? [];
  const candidates = bots.filter((bot) => !bot.archivedAt && !chat.members.includes(bot.id));
  const name = (id: string | null | undefined) => (id ? (byId.get(id)?.name ?? '?') : '—');
  const workspaceProject =
    chat.workspace.kind === 'project'
      ? projects.find(
          (project) => chat.workspace.kind === 'project' && project.id === chat.workspace.projectId
        )
      : undefined;
  const routingDirty =
    hops !== String(chat.routing.maxHops) || turns !== String(chat.routing.maxTurnsPerBot);
  const modeItems: Array<{ value: BotRoutingMode; label: string }> = [
    { value: 'boss', label: t('Group owner replies') },
    { value: 'smart', label: t('Smart pick') },
  ];

  return (
    <Tabs defaultValue="info" className="flex min-h-0 flex-1 flex-col">
      <TabsList variant="underline" className="shrink-0 px-2 pt-2">
        <TabsTab value="info">{t('Group info')}</TabsTab>
        <TabsTab value="board">{t('Task board')}</TabsTab>
        <TabsTab value="delegations">{t('Delegations')}</TabsTab>
        <TabsTab value="routines">{t('Routines')}</TabsTab>
      </TabsList>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <TabsPanel value="board">
          <TaskBoard chat={chat} />
        </TabsPanel>
        <TabsPanel value="delegations">
          <GroupDelegations chat={chat} onOpenConversation={onOpenConversation} />
        </TabsPanel>
        <TabsPanel value="routines">
          <RoutineList chatId={chat.id} />
        </TabsPanel>
        <TabsPanel value="info">
          <Input
            className="mt-2"
            value={title}
            placeholder={t('Group name')}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => title.trim() !== chat.title && void update({ title: title.trim() })}
            onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
          />

          <PanelSection title={t('Members')}>
            {members.map(({ id, bot }) => (
              <div key={id} className="group flex items-center gap-2 rounded-lg py-1.5">
                <button
                  type="button"
                  onClick={() => void openDirect(id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <PresenceAvatar chatId={chat.id} botId={id} bot={bot} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-sm">
                      <span className="truncate">{bot?.name ?? t('Deleted member')}</span>
                      {chat.bossBotId === id && (
                        <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
                          {t('Owner')}
                        </span>
                      )}
                      {muted.includes(id) && (
                        <span
                          title={t('Replies only when @-mentioned by name')}
                          className="flex shrink-0 items-center gap-0.5 rounded bg-muted px-1.5 text-[10px] text-muted-foreground"
                        >
                          <BellOff className="h-2.5 w-2.5" />
                          {t('Muted')}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-muted-foreground text-xs">
                      {bot?.scope || bot?.title}
                    </div>
                  </div>
                </button>
                <Menu>
                  <MenuTrigger className="rounded p-1 text-muted-foreground opacity-0 hover:bg-muted group-hover:opacity-100 data-popup-open:opacity-100">
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem
                      disabled={chat.bossBotId === id}
                      onClick={() => void update({ bossBotId: id })}
                    >
                      <Crown />
                      {t('Make owner')}
                    </MenuItem>
                    <MenuItem
                      disabled={chat.bossBotId === id}
                      onClick={() =>
                        void update({
                          routing: {
                            muted: muted.includes(id)
                              ? muted.filter((member) => member !== id)
                              : [...muted, id],
                          },
                        })
                      }
                    >
                      <BellOff />
                      {muted.includes(id) ? t('Unmute') : t('Mute')}
                    </MenuItem>
                    <MenuItem
                      disabled={chat.bossBotId === id || chat.members.length <= 2}
                      onClick={() =>
                        void update({ members: chat.members.filter((member) => member !== id) })
                      }
                    >
                      <UserMinus />
                      {t('Remove from group')}
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </div>
            ))}
            <Popover open={adding} onOpenChange={setAdding}>
              <PopoverTrigger
                disabled={candidates.length === 0}
                className="mt-1 flex h-7 items-center gap-1 rounded-md border px-2 text-muted-foreground text-xs hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" />
                {t('Add member')}
              </PopoverTrigger>
              <PopoverPopup
                side="bottom"
                align="start"
                className="w-56 [&_[data-slot=popover-viewport]]:p-1"
              >
                {candidates.map((bot: BotProfile) => (
                  <button
                    key={bot.id}
                    type="button"
                    onClick={() => {
                      setAdding(false);
                      void update({ members: [...chat.members, bot.id] });
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                  >
                    <BotAvatar bot={bot} size="sm" />
                    <span className="min-w-0 truncate">{bot.name}</span>
                  </button>
                ))}
              </PopoverPopup>
            </Popover>
          </PanelSection>

          <PanelSection title={t('Reply queue')}>
            <KeyValue
              label={t('Current')}
              value={
                runtime?.current
                  ? `${name(runtime.current)}（${t('relay {{n}}/{{max}}', { n: runtime.hops, max: chat.routing.maxHops })}）`
                  : runtime?.routing
                    ? t('Choosing who replies…')
                    : '—'
              }
            />
            <KeyValue
              label={t('Waiting')}
              value={runtime?.queue.length ? runtime.queue.map((id) => name(id)).join('、') : '—'}
            />
            <KeyValue
              label={t('Per-member limit')}
              value={t('{{n}} replies', { n: chat.routing.maxTurnsPerBot })}
            />
          </PanelSection>

          <PanelSection title={t('Workspace')}>
            <div className="rounded-lg border bg-card px-2.5 py-2">
              <WorkspaceMenu chat={chat} className="w-full max-w-none" />
              <p className="mt-1.5 text-muted-foreground text-xs">
                {workspaceProject ? `${workspaceProject.path} · ` : ''}
                {t('Shared by all members')}
              </p>
            </div>
          </PanelSection>

          <PanelSection title={t('Routing limits')}>
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-muted-foreground text-xs">{t('Without @')}</span>
              <Select
                items={modeItems}
                value={chat.routing.mode}
                onValueChange={(mode) => {
                  if (mode !== chat.routing.mode)
                    void update({ routing: { mode: mode as BotRoutingMode } });
                }}
              >
                <SelectTrigger size="sm" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {modeItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="text-muted-foreground text-xs">{t('@ relay limit')}</span>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={hops}
                  onChange={(event) => setHops(event.target.value)}
                />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground text-xs">{t('Replies per member')}</span>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={turns}
                  onChange={(event) => setTurns(event.target.value)}
                />
              </label>
            </div>
            {routingDirty && (
              <Button
                size="xs"
                className="mt-2"
                onClick={() =>
                  void update({
                    routing: {
                      maxHops: Math.round(Number(hops)) || chat.routing.maxHops,
                      maxTurnsPerBot: Math.round(Number(turns)) || chat.routing.maxTurnsPerBot,
                    },
                  })
                }
              >
                {t('Save')}
              </Button>
            )}
          </PanelSection>

          <PanelSection title={t('Group notes')}>
            <NotesEditor
              target={{ chatId: chat.id }}
              emptyText={t(
                'No group notes yet. Group conventions and decisions are summarized here automatically after memories are organized.'
              )}
            />
          </PanelSection>

          <PanelSection title={t('Group memory')}>
            <MemorySpaceList spaceId={`chat:${chat.id}`} emptyText={t('No group memories yet')} />
          </PanelSection>

          <PanelSection title={t('Team')}>
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void exportTeam(chat, bots).then(
                  (ok) => ok || addToast({ type: 'error', title: t('Export failed') })
                )
              }
            >
              <Download />
              {t('Export team')}
            </Button>
            <Button
              size="xs"
              variant="outline"
              className="ml-1.5"
              onClick={() =>
                void saveTeamTemplate(chat, bots).then((ok) =>
                  addToast(
                    ok
                      ? { type: 'success', title: t('Saved as team template') }
                      : { type: 'error', title: t('Could not save as team template') }
                  )
                )
              }
            >
              <BookmarkPlus />
              {t('Save as team template')}
            </Button>
            <p className="mt-1.5 text-muted-foreground text-xs">
              {t(
                'Group settings and member personas only. Memory, sessions, timeline, tasks, routines, models, skills and MCP are not included.'
              )}
            </p>
          </PanelSection>
        </TabsPanel>
      </div>
    </Tabs>
  );
}
