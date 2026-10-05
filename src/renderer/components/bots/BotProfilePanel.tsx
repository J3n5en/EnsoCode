import { utf8ToBase64, writePngText } from '@shared/bots/cardPng';
import type { BotChat, BotEngine, BotProfile } from '@shared/types/bot';
import type { BotDraftInput, BotSessionRecord } from '@shared/types/botIpc';
import { Archive, Download, Loader2, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { useBotsStore } from '@/stores/bots';
import { budgetDraft, budgetFormOf, limitsDraft, limitsFormOf } from '@/stores/bots/budget';
import { buildCharacterCard } from '@/stores/bots/characterCard';
import { AvatarButtons } from './AvatarCropDialog';
import {
  botAvatarSrc,
  coverSquare,
  dataUrlBytes,
  downloadBlob,
  generatedAvatarPng,
  saveBotAvatar,
} from './avatarImage';
import { type AbilityForm, BotAbilityFields } from './BotAbilities';
import { BotAvatar } from './BotAvatar';
import { ColorPicker, EngineField, FieldLabel, nameError } from './BotFields';
import { BotUsageCard } from './BotUsageCard';
import { botErrorText, chatTitle } from './botText';
import { MemorySpaceList } from './MemorySpaceList';
import { NotesEditor } from './NotesEditor';
import { PersonaSuggestButton } from './PersonaSuggest';
import { RoutineList } from './RoutineList';

interface FormState extends AbilityForm {
  name: string;
  title: string;
  scope: string;
  persona: string;
  color: string;
  engine: BotEngine | null;
}

function formOf(bot: BotProfile, persona: string): FormState {
  return {
    name: bot.name,
    title: bot.title,
    scope: bot.scope,
    persona,
    color: bot.avatar.color,
    engine: bot.engine ?? null,
    tools: bot.tools,
    approvalMode: bot.approvalMode,
    skillIds: bot.skillIds,
    mcpServerIds: bot.mcpServerIds,
    canDelegateTo: bot.delegation.canDelegateTo,
    acceptFrom: bot.delegation.acceptFrom,
    memoryEnabled: bot.memory.enabled,
    ...budgetFormOf(bot.budget),
    ...limitsFormOf(bot),
  };
}

function draftOf(form: FormState): BotDraftInput | null {
  const budget = budgetDraft(form);
  const limits = limitsDraft(form);
  if (!budget.ok || !limits.ok) return null;
  return {
    name: form.name.trim(),
    title: form.title.trim(),
    scope: form.scope.trim(),
    persona: form.persona,
    avatar: { color: form.color },
    engine: form.engine,
    tools: form.tools,
    approvalMode: form.approvalMode,
    skillIds: form.skillIds,
    mcpServerIds: form.mcpServerIds,
    delegation: { canDelegateTo: form.canDelegateTo, acceptFrom: form.acceptFrom },
    memory: { enabled: form.memoryEnabled },
    budget: budget.budget,
    delegationTimeoutMinutes: limits.delegationTimeoutMinutes,
    maxTokensPerTurn: limits.maxTokensPerTurn,
  };
}

/** SillyTavern V2 PNG 人物卡（chara tEXt）：图用头像，无图用颜色圆；renderer 内生成并下载 */
async function exportCard(bot: BotProfile, persona: string) {
  const src = botAvatarSrc(bot);
  const image = src
    ? await fetch(src)
        .then((response) => response.blob())
        .then(coverSquare)
        .catch(() => null)
    : null;
  const png = writePngText(
    dataUrlBytes(image ?? (await generatedAvatarPng(bot.name, bot.avatar.color))),
    'chara',
    utf8ToBase64(JSON.stringify(buildCharacterCard(bot, persona))),
    ['ccv3']
  );
  if (!png) throw new Error('png');
  downloadBlob(new Blob([new Uint8Array(png)], { type: 'image/png' }), `${bot.name}.png`);
}

interface BotProfilePanelProps {
  botId: string;
  chat: BotChat;
  onOpenHistory: (conversationId: string, title: string) => void;
}

export function BotProfilePanel({ botId, chat, onOpenHistory }: BotProfilePanelProps) {
  const { t } = useI18n();
  const bot = useBotsStore((s) => s.bots.find((item) => item.id === botId));
  const bots = useBotsStore((s) => s.bots);
  const [persona, setPersona] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [edited, setEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [confirm, setConfirm] = useState<'archive' | 'delete' | null>(null);

  const reload = useCallback(async () => {
    const result = await window.electronAPI.bots.get(botId);
    if (!result.ok) return;
    useBotsStore.getState().upsertBot(result.bot);
    setPersona(result.persona);
    setForm(formOf(result.bot, result.persona));
    setEdited(false);
  }, [botId]);

  useEffect(() => {
    setPersona(null);
    setForm(null);
    void reload();
  }, [reload]);

  const baseline = useMemo(
    () => (bot && persona !== null ? formOf(bot, persona) : null),
    [bot, persona]
  );
  const dirty =
    edited && Boolean(form && baseline && JSON.stringify(form) !== JSON.stringify(baseline));

  // 别处改了成员且本地没有未保存修改：跟随最新版本
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在版本变化时同步
  useEffect(() => {
    if (!edited && baseline) setForm(baseline);
  }, [bot?.version]);

  if (!bot || !form) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const patch = (next: Partial<FormState>) => {
    setForm((current) => (current ? { ...current, ...next } : current));
    setEdited(true);
  };
  const nameIssue = nameError(form.name, bots, t, bot.id);

  const changeAvatar = async (dataUrl: string | null) => {
    setAvatarBusy(true);
    try {
      if (!(await saveBotAvatar(bot.id, dataUrl)))
        addToast({ type: 'error', title: t('Avatar update failed') });
    } finally {
      setAvatarBusy(false);
    }
  };

  const save = async () => {
    const draft = draftOf(form);
    if (!draft) {
      addToast({
        type: 'error',
        title: limitsDraft(form).ok
          ? t('Budget must be a positive number')
          : t('Check the per-turn token limit and delegation time limit'),
      });
      return;
    }
    setSaving(true);
    try {
      const result = await window.electronAPI.bots.update({
        botId: bot.id,
        expectedVersion: bot.version,
        draft,
      });
      if (result.ok) {
        useBotsStore.getState().upsertBot(result.bot);
        setPersona(form.persona);
        setForm(formOf(result.bot, form.persona));
        setEdited(false);
        return;
      }
      addToast({
        type: 'error',
        title: botErrorText(result.reason, result.error, t),
        ...(result.reason === 'conflict'
          ? { actions: [{ label: t('Refresh'), onClick: () => void reload() }] }
          : {}),
      });
    } finally {
      setSaving(false);
    }
  };

  const runDanger = async () => {
    const action = confirm;
    setConfirm(null);
    if (action === 'archive') {
      const result = await window.electronAPI.bots.archive(bot.id, true);
      if (result.ok) useBotsStore.getState().upsertBot(result.bot);
      else addToast({ type: 'error', title: botErrorText(result.reason, result.error, t) });
      return;
    }
    const result = await window.electronAPI.bots.remove(bot.id);
    if (result.ok) {
      useBotsStore.getState().setView(null);
      await Promise.all([
        useBotsStore.getState().refreshCatalog(),
        useBotsStore.getState().refreshChats(),
      ]);
      return;
    }
    if (result.reason === 'boss') {
      const chats = useBotsStore.getState().chats;
      const titles = (result.chatIds ?? [])
        .map((id) => chats.find((item) => item.id === id))
        .filter((item): item is BotChat => Boolean(item))
        .map((item) => chatTitle(item, bots, t));
      addToast({
        type: 'warning',
        title: t('{{name}} owns group chats', { name: bot.name }),
        description: t('Choose another owner in {{groups}} first.', { groups: titles.join('、') }),
      });
      return;
    }
    addToast({ type: 'error', title: botErrorText(result.reason, result.error, t) });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 px-4 pt-4">
        <BotAvatar
          bot={{
            id: bot.id,
            name: form.name || bot.name,
            avatar: { ...bot.avatar, color: form.color },
          }}
          size="lg"
        />
        <div className="min-w-0">
          <div className="truncate font-semibold text-base">{bot.name}</div>
          <div className="truncate text-muted-foreground text-sm">{bot.title}</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                exportCard(bot, persona ?? '').catch(() =>
                  addToast({ type: 'error', title: t('Export failed') })
                )
              }
            >
              <Download />
              {t('Export character card')}
            </Button>
            <AvatarButtons
              hasImage={Boolean(bot.avatar.image)}
              disabled={avatarBusy}
              onPick={(dataUrl) => void changeAvatar(dataUrl)}
              onRemove={() => void changeAvatar(null)}
            />
          </div>
        </div>
      </div>

      <Tabs defaultValue="profile" className="mt-3 flex min-h-0 flex-1 flex-col">
        <TabsList variant="underline" className="shrink-0 px-2">
          <TabsTab value="profile">{t('Profile')}</TabsTab>
          <TabsTab value="abilities">{t('Abilities')}</TabsTab>
          <TabsTab value="memory">{t('Memory')}</TabsTab>
          <TabsTab value="routines">{t('Routines')}</TabsTab>
          <TabsTab value="history">{t('History')}</TabsTab>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <TabsPanel value="profile" className="space-y-3">
            <BotUsageCard bot={bot} />
            <div>
              <FieldLabel hint={t('Used for @ in groups; must be unique')}>{t('Name')}</FieldLabel>
              <Input value={form.name} onChange={(event) => patch({ name: event.target.value })} />
              {nameIssue && <p className="mt-1 text-destructive text-xs">{nameIssue}</p>}
            </div>
            <div>
              <FieldLabel>{t('Title')}</FieldLabel>
              <Input
                value={form.title}
                onChange={(event) => patch({ title: event.target.value })}
              />
            </div>
            <div>
              <FieldLabel hint={t('Used for routing and the delegation directory')}>
                {t('Responsibilities')}
              </FieldLabel>
              <Textarea
                rows={2}
                value={form.scope}
                onChange={(event) => patch({ scope: event.target.value })}
              />
            </div>
            <div>
              <FieldLabel action={<PersonaSuggestButton value={form} onApply={patch} />}>
                {t('Persona')}
              </FieldLabel>
              <Textarea
                rows={8}
                value={form.persona}
                onChange={(event) => patch({ persona: event.target.value })}
              />
            </div>
            <div>
              <FieldLabel>{t('Avatar color')}</FieldLabel>
              <ColorPicker value={form.color} onChange={(color) => patch({ color })} />
            </div>
            <div className="flex gap-2 border-t pt-3">
              <Button size="xs" variant="outline" onClick={() => setConfirm('archive')}>
                <Archive />
                {t('Archive member')}
              </Button>
              <Button size="xs" variant="destructive-outline" onClick={() => setConfirm('delete')}>
                <Trash2 />
                {t('Delete permanently')}
              </Button>
            </div>
          </TabsPanel>

          <TabsPanel value="abilities" className="space-y-4">
            <div>
              <FieldLabel>{t('Model')}</FieldLabel>
              <EngineField engine={form.engine} onChange={(engine) => patch({ engine })} />
            </div>
            <BotAbilityFields value={form} onChange={patch} profile={form} botId={bot.id} />
          </TabsPanel>

          <TabsPanel value="memory">
            <div className="mb-4">
              <FieldLabel hint={t('Injected into every new conversation')}>
                {t('Core notes')}
              </FieldLabel>
              <NotesEditor
                target={{ botId: bot.id }}
                emptyText={t(
                  'No notes yet. Key preferences and facts are summarized here automatically after memories are organized.'
                )}
              />
            </div>
            <MemorySpaceList spaceId={`bot:${bot.id}`} emptyText={t('No memories yet')} />
          </TabsPanel>

          <TabsPanel value="routines">
            <RoutineList botId={bot.id} />
          </TabsPanel>

          <TabsPanel value="history">
            <SessionList chat={chat} botId={bot.id} onOpen={(id) => onOpenHistory(id, bot.name)} />
          </TabsPanel>
        </div>
      </Tabs>

      {dirty && (
        <div className="flex shrink-0 justify-end gap-2 border-t bg-muted/50 px-4 py-2.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (baseline) setForm(baseline);
              setEdited(false);
            }}
          >
            {t('Discard')}
          </Button>
          <Button size="sm" disabled={saving || Boolean(nameIssue)} onClick={() => void save()}>
            {saving && <Loader2 className="animate-spin" />}
            {t('Save')}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={
          confirm === 'delete'
            ? t('Delete {{name}}?', { name: bot.name })
            : t('Archive {{name}}?', { name: bot.name })
        }
        description={
          confirm === 'delete'
            ? t(
                'The member, their private chats, persona, memories and workspace are deleted. This cannot be undone.'
              )
            : t(
                'Archived members stop replying and are hidden from the list. You can restore them later.'
              )
        }
        confirmLabel={confirm === 'delete' ? t('Delete permanently') : t('Archive member')}
        onConfirm={() => void runDanger()}
      />
    </div>
  );
}

function SessionList({
  chat,
  botId,
  onOpen,
}: {
  chat: BotChat;
  botId: string;
  onOpen: (conversationId: string) => void;
}) {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<BotSessionRecord[] | null>(null);
  useEffect(() => {
    let alive = true;
    void window.electronAPI.bots.chatSessions(chat.id).then((result) => {
      if (alive)
        setSessions(result.ok ? result.sessions.filter((item) => item.botId === botId) : []);
    });
    return () => {
      alive = false;
    };
  }, [chat.id, botId]);
  if (sessions === null) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  if (sessions.length === 0)
    return <p className="text-muted-foreground text-xs">{t('No conversations yet')}</p>;
  return (
    <div className="space-y-1">
      {sessions.map((session, index) => (
        <button
          key={session.conversationId}
          type="button"
          onClick={() => onOpen(session.conversationId)}
          className="flex w-full items-center justify-between rounded-lg border bg-card px-2.5 py-2 text-left text-xs hover:bg-muted"
        >
          <span>{t('Conversation {{n}}', { n: sessions.length - index })}</span>
          <span className="text-muted-foreground">
            {session.current ? t('Current') : t('Read-only')}
          </span>
        </button>
      ))}
    </div>
  );
}
