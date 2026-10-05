import { base64ToUtf8, readPngText, sniffImage } from '@shared/bots/cardPng';
import {
  type MemberTemplateData,
  memberDraftOfTemplate,
  type ResolvedTemplate,
} from '@shared/bots/templateLibrary';
import type { BotEngine } from '@shared/types/bot';
import { ChevronRight, FileJson, Loader2, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';
import { useBotsStore } from '@/stores/bots';
import { budgetDraft, limitsDraft } from '@/stores/bots/budget';
import { parseCharacterCard } from '@/stores/bots/characterCard';
import { useMemberTemplates } from '@/stores/bots/templateLibrary';
import { AvatarButtons } from './AvatarCropDialog';
import { coverSquare, saveBotAvatar } from './avatarImage';
import { type AbilityForm, BotAbilityFields, DEFAULT_ABILITIES } from './BotAbilities';
import { BotAvatar } from './BotAvatar';
import { AVATAR_PALETTE, ColorPicker, EngineField, FieldLabel, nameError } from './BotFields';
import { botErrorText } from './botText';
import { PersonaSuggestButton } from './PersonaSuggest';

interface Draft extends AbilityForm {
  name: string;
  title: string;
  scope: string;
  persona: string;
  color: string;
  engine: BotEngine | null;
}

type Source = { kind: 'template'; id: string } | { kind: 'blank' } | { kind: 'import' };

const blankDraft = (color: string): Draft => ({
  ...DEFAULT_ABILITIES,
  name: '',
  title: '',
  scope: '',
  persona: '',
  color,
  engine: null,
});

export function NewBotDialog({
  open,
  onOpenChange,
  seed,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 目标式引导推荐的成员：打开时直接填入（来源视为空白，可再改） */
  seed?: { name: string; title: string; scope: string; persona: string };
  /** 创建并打开私聊后回调（引导据此预填第一条消息） */
  onCreated?: (chatId: string) => void;
}) {
  const { t } = useI18n();
  const bots = useBotsStore((s) => s.bots);
  const templates = useMemberTemplates();
  const fileRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<Source>({ kind: 'template', id: 'pm' });
  const [draft, setDraft] = useState<Draft>(() => blankDraft(AVATAR_PALETTE[0]));
  /** 待上传的头像（512 PNG data URL），创建成功后经 Main 写入 */
  const [avatar, setAvatar] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [abilitiesOpen, setAbilitiesOpen] = useState(false);

  const applyBlank = () => {
    setSource({ kind: 'blank' });
    setDraft(blankDraft(AVATAR_PALETTE[bots.length % AVATAR_PALETTE.length]));
    setAvatar(null);
    setError(null);
  };

  const applyTemplate = (template: ResolvedTemplate<MemberTemplateData> | undefined) => {
    if (!template) return applyBlank();
    const input = memberDraftOfTemplate(template.data);
    setSource({ kind: 'template', id: template.id });
    setDraft({
      ...DEFAULT_ABILITIES,
      name: input.name ?? '',
      title: input.title ?? '',
      scope: input.scope ?? '',
      persona: input.persona ?? '',
      color: input.avatar?.color ?? AVATAR_PALETTE[0],
      engine: null,
      approvalMode: input.approvalMode ?? 'auto-edits',
      tools: input.tools ?? 'all',
    });
    setAvatar(null);
    setError(null);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: 每次打开重置
  useEffect(() => {
    if (!open) return;
    if (seed) {
      setSource({ kind: 'blank' });
      setDraft({ ...blankDraft(AVATAR_PALETTE[bots.length % AVATAR_PALETTE.length]), ...seed });
      setAvatar(null);
      setError(null);
    } else applyTemplate(templates[0]);
    setTouched(false);
    setBusy(false);
    setAbilitiesOpen(false);
  }, [open]);

  const patch = (next: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setError(null);
  };

  const importCard = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const isPng = sniffImage(bytes) === 'png';
    const text = isPng
      ? base64ToUtf8(readPngText(bytes, 'chara') ?? readPngText(bytes, 'ccv3') ?? '')
      : new TextDecoder().decode(bytes);
    const result = text ? parseCharacterCard(text) : ({ ok: false, error: 'not-a-card' } as const);
    if (!result.ok) {
      setError(
        result.error === 'invalid-json' && !isPng
          ? t('This file is not valid JSON.')
          : t('This file is not a SillyTavern character card.')
      );
      return;
    }
    const { color, memoryEnabled, ...fields } = result.draft;
    setSource({ kind: 'import' });
    setDraft({
      ...blankDraft(color ?? draft.color),
      ...fields,
      ...(memoryEnabled !== undefined ? { memoryEnabled } : {}),
    });
    setAvatar(isPng ? await coverSquare(file).catch(() => null) : null);
    setTouched(true);
    setError(null);
  };

  const nameIssue = nameError(draft.name, bots, t);

  const create = async () => {
    setTouched(true);
    if (nameIssue) return;
    const budget = budgetDraft(draft);
    if (!budget.ok) {
      setError(t('Budget must be a positive number'));
      return;
    }
    const limits = limitsDraft(draft);
    if (!limits.ok) {
      setError(t('Check the per-turn token limit and delegation time limit'));
      return;
    }
    setBusy(true);
    try {
      const result = await window.electronAPI.bots.create({
        name: draft.name.trim(),
        title: draft.title.trim(),
        scope: draft.scope.trim(),
        ...(limits.delegationTimeoutMinutes
          ? { delegationTimeoutMinutes: limits.delegationTimeoutMinutes }
          : {}),
        ...(limits.maxTokensPerTurn ? { maxTokensPerTurn: limits.maxTokensPerTurn } : {}),
        persona: draft.persona,
        avatar: { color: draft.color },
        engine: draft.engine,
        approvalMode: draft.approvalMode,
        tools: draft.tools,
        skillIds: draft.skillIds,
        mcpServerIds: draft.mcpServerIds,
        delegation: { canDelegateTo: draft.canDelegateTo, acceptFrom: draft.acceptFrom },
        memory: { enabled: draft.memoryEnabled },
        ...(budget.budget ? { budget: budget.budget } : {}),
      });
      if (!result.ok) {
        setError(botErrorText(result.reason, result.error, t));
        return;
      }
      useBotsStore.getState().upsertBot(result.bot);
      if (avatar && !(await saveBotAvatar(result.bot.id, avatar))) {
        addToast({ type: 'error', title: t('Avatar update failed') });
      }
      onOpenChange(false);
      const chatId = await useBotsStore.getState().openDirect(result.bot.id);
      if (chatId) onCreated?.(chatId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('New member')}</DialogTitle>
          <DialogDescription>
            {t(
              'Members have their own persona, model, tools and memory. Their name is how you @ them in groups.'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={source.kind === 'template' ? 'default' : 'outline'}
              disabled={templates.length === 0}
              onClick={() => applyTemplate(templates[0])}
            >
              {t('From template')}
            </Button>
            <Button
              size="sm"
              variant={source.kind === 'blank' ? 'default' : 'outline'}
              onClick={applyBlank}
            >
              {t('Blank')}
            </Button>
            <Button
              size="sm"
              variant={source.kind === 'import' ? 'default' : 'outline'}
              onClick={() => fileRef.current?.click()}
            >
              <FileJson />
              {t('Import character card')}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,.png,application/json,image/png"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void importCard(file);
              }}
            />
          </div>

          {source.kind === 'template' && (
            <div className="grid grid-cols-3 gap-2.5">
              {templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => applyTemplate(template)}
                  className={cn(
                    'flex flex-col items-start gap-1 rounded-xl border bg-card p-3 text-left transition-colors hover:bg-muted',
                    source.id === template.id && 'ring-2 ring-info'
                  )}
                >
                  <BotAvatar
                    bot={{ name: template.data.title, avatar: { color: template.data.color } }}
                  />
                  <span className="font-medium text-sm">{template.data.title}</span>
                  <span className="text-muted-foreground text-xs">{template.data.summary}</span>
                </button>
              ))}
              <button
                type="button"
                onClick={applyBlank}
                className="flex items-center justify-center gap-1 rounded-xl border border-dashed p-3 text-muted-foreground text-sm hover:bg-muted"
              >
                <Plus className="h-4 w-4" />
                {t('Blank member')}
              </button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel hint={t('Used for @ in groups; must be unique')}>{t('Name')}</FieldLabel>
              <Input
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value })}
                onBlur={() => setTouched(true)}
              />
              {touched && nameIssue && <p className="mt-1 text-destructive text-xs">{nameIssue}</p>}
            </div>
            <div>
              <FieldLabel>{t('Title')}</FieldLabel>
              <Input
                value={draft.title}
                onChange={(event) => patch({ title: event.target.value })}
              />
            </div>
            <div>
              <FieldLabel>{t('Model')}</FieldLabel>
              <EngineField
                engine={draft.engine}
                onChange={(engine) => patch({ engine })}
                zIndex={Z_INDEX.DROPDOWN_IN_MODAL}
              />
            </div>
            <div>
              <FieldLabel>{t('Avatar color')}</FieldLabel>
              <div className="flex items-start gap-2.5">
                <BotAvatar
                  bot={{ name: draft.name || '?', avatar: { color: draft.color } }}
                  src={avatar ?? undefined}
                  size="md"
                />
                <div className="min-w-0 space-y-1.5">
                  <ColorPicker value={draft.color} onChange={(color) => patch({ color })} />
                  <AvatarButtons
                    nested
                    hasImage={Boolean(avatar)}
                    onPick={setAvatar}
                    onRemove={() => setAvatar(null)}
                  />
                </div>
              </div>
            </div>
            <div className="col-span-2">
              <FieldLabel hint={t('Used for routing and the delegation directory')}>
                {t('Responsibilities')}
              </FieldLabel>
              <Input
                value={draft.scope}
                onChange={(event) => patch({ scope: event.target.value })}
              />
            </div>
            <div className="col-span-2">
              <FieldLabel action={<PersonaSuggestButton value={draft} onApply={patch} />}>
                {t('Persona')}
              </FieldLabel>
              <Textarea
                rows={4}
                value={draft.persona}
                onChange={(event) => patch({ persona: event.target.value })}
              />
            </div>
            <div className="col-span-2 rounded-lg border">
              <button
                type="button"
                className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm"
                aria-expanded={abilitiesOpen}
                onClick={() => setAbilitiesOpen((value) => !value)}
              >
                <ChevronRight
                  className={cn('h-4 w-4 transition-transform', abilitiesOpen && 'rotate-90')}
                />
                <span className="font-medium">{t('Abilities')}</span>
                <span className="truncate text-muted-foreground text-xs">
                  {t('Tools, approval, skills, MCP, delegation and memory')}
                </span>
              </button>
              {abilitiesOpen && (
                <div className="border-t px-3 py-3">
                  <BotAbilityFields
                    value={draft}
                    onChange={patch}
                    profile={draft}
                    zIndex={Z_INDEX.DROPDOWN_IN_MODAL}
                  />
                </div>
              )}
            </div>
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button
            size="sm"
            disabled={busy || (touched && Boolean(nameIssue))}
            onClick={() => void create()}
          >
            {busy && <Loader2 className="animate-spin" />}
            {t('Create and start chatting')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
