import { BOT_ROUTING_DEFAULTS } from '@shared/types/bot';
import { Info, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useBotsStore } from '@/stores/bots';
import { useSettingsStore } from '@/stores/settings';
import { BotAvatar } from './BotAvatar';
import { FieldLabel } from './BotFields';
import { BotProjectPicker } from './BotProjectPicker';
import { chatErrorText, localProjects } from './botText';

export function NewGroupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const allBots = useBotsStore((s) => s.bots);
  const bots = useMemo(() => allBots.filter((bot) => bot.archivedAt === undefined), [allBots]);
  const projects = localProjects(useSettingsStore((s) => s.projects));
  const [title, setTitle] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [boss, setBoss] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<'project' | 'chat-home'>('project');
  const [projectId, setProjectId] = useState('');
  const [maxHops, setMaxHops] = useState(String(BOT_ROUTING_DEFAULTS.maxHops));
  const [maxTurns, setMaxTurns] = useState(String(BOT_ROUTING_DEFAULTS.maxTurnsPerBot));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 每次打开重置
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setMembers([]);
    setBoss(null);
    setWorkspace(projects.length > 0 ? 'project' : 'chat-home');
    setProjectId(projects[0]?.id ?? '');
    setMaxHops(String(BOT_ROUTING_DEFAULTS.maxHops));
    setMaxTurns(String(BOT_ROUTING_DEFAULTS.maxTurnsPerBot));
    setBusy(false);
    setError(null);
  }, [open]);

  const toggle = (id: string, checked: boolean) => {
    const next = checked ? [...members, id] : members.filter((item) => item !== id);
    setMembers(next);
    if (!next.includes(boss ?? '')) setBoss(next[0] ?? null);
    else if (!boss && next.length) setBoss(next[0]);
  };

  const canCreate =
    members.length >= 2 && boss !== null && (workspace === 'chat-home' || Boolean(projectId));

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.bots.createChat({
        kind: 'group',
        title: title.trim(),
        members,
        bossBotId: boss,
        workspace: workspace === 'project' ? { kind: 'project', projectId } : { kind: 'chat-home' },
        routing: {
          maxHops: Math.round(Number(maxHops)) || BOT_ROUTING_DEFAULTS.maxHops,
          maxTurnsPerBot: Math.round(Number(maxTurns)) || BOT_ROUTING_DEFAULTS.maxTurnsPerBot,
        },
      });
      if (!result.ok) {
        setError(chatErrorText(result.error, t));
        return;
      }
      const store = useBotsStore.getState();
      store.upsertChat(result.chat);
      store.setView({ kind: 'chat', chatId: result.chat.id });
      void store.loadLatest(result.chat.id);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('New group chat')}</DialogTitle>
          <DialogDescription>
            {t('One member replies at a time. Without @, the best-fit member is picked to reply.')}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div>
            <FieldLabel>{t('Group name')}</FieldLabel>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>

          <div>
            <FieldLabel hint={t('Pick at least two, and one owner')}>{t('Members')}</FieldLabel>
            {bots.length < 2 && (
              <p className="text-muted-foreground text-xs">
                {t('Create at least two members first.')}
              </p>
            )}
            <div className="space-y-0.5">
              {bots.map((bot) => {
                const checked = members.includes(bot.id);
                return (
                  <div
                    key={bot.id}
                    className="flex items-center gap-2.5 rounded-md px-1.5 py-1 hover:bg-muted"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(value) => toggle(bot.id, value === true)}
                    />
                    <BotAvatar bot={bot} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {bot.name}
                      {bot.title && (
                        <span className="ml-1.5 text-muted-foreground text-xs">{bot.title}</span>
                      )}
                    </span>
                    {checked && (
                      <label className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
                        <input
                          type="radio"
                          name="group-owner"
                          checked={boss === bot.id}
                          onChange={() => setBoss(bot.id)}
                          className="accent-primary"
                        />
                        {t('Owner')}
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <FieldLabel>{t('Shared workspace')}</FieldLabel>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => setWorkspace('project')}
                className={cn(
                  'rounded-xl border bg-card p-3 text-left disabled:opacity-50',
                  workspace === 'project' && 'ring-2 ring-info'
                )}
              >
                <div className="font-medium text-sm">{t('Based on a Code project')}</div>
                <div className="mt-0.5 text-muted-foreground text-xs">
                  {t('Members read and write directly in the project folder')}
                </div>
              </button>
              <button
                type="button"
                onClick={() => setWorkspace('chat-home')}
                className={cn(
                  'rounded-xl border bg-card p-3 text-left',
                  workspace === 'chat-home' && 'ring-2 ring-info'
                )}
              >
                <div className="font-medium text-sm">{t('Standalone workspace')}</div>
                <div className="mt-0.5 text-muted-foreground text-xs">
                  {t('A new empty folder for this group, removed with the group')}
                </div>
              </button>
            </div>
            {workspace === 'project' && (
              <BotProjectPicker projectId={projectId} onChange={setProjectId} />
            )}
            <div className="mt-2 flex gap-2 rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 text-xs">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <span>
                {t(
                  'All members share this folder: anyone who can talk to a member can reach its contents through them. You can change it later in group info (members start new conversations).'
                )}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel>{t('@ relay limit (per message of yours)')}</FieldLabel>
              <Input
                type="number"
                min={1}
                max={20}
                value={maxHops}
                onChange={(event) => setMaxHops(event.target.value)}
              />
            </div>
            <div>
              <FieldLabel>{t('Max replies per member')}</FieldLabel>
              <Input
                type="number"
                min={1}
                max={10}
                value={maxTurns}
                onChange={(event) => setMaxTurns(event.target.value)}
              />
            </div>
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button size="sm" disabled={!canCreate || busy} onClick={() => void create()}>
            {busy && <Loader2 className="animate-spin" />}
            {t('Create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
