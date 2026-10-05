import { CHAT_REF_MAX_PER_MESSAGE } from '@shared/bots/composerRefs';
import { mentionCandidates, parseMentions } from '@shared/bots/mentions';
import type { AttachedImage } from '@shared/types/agent';
import { BOT_MENTION_ALL, type BotProfile } from '@shared/types/bot';
import type { StartVoiceSession } from '@shared/types/speech';
import { ArrowUp, FileText, ImagePlus, MessagesSquare, Sparkles, Square, X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { extractSkillQuery } from '@/components/chat/skillCompletion';
import { VoiceInputButton } from '@/components/chat/VoiceInputButton';
import { useMentionSearch } from '@/hooks/useMentionSearch';
import { useI18n } from '@/i18n';
import { effectiveKeybindings } from '@/lib/keybindings';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { BotAvatar } from './BotAvatar';
import {
  type BotComposerDraft,
  EMPTY_BOT_DRAFT,
  onBotDraftSeeded,
  readBotDraft,
  writeBotDraft,
} from './botDraft';

export { seedBotDraft } from './botDraft';

/** @聊天候选：其他 Bot 聊天（只传 id，摘录由 Main 生成） */
export interface ChatRefOption {
  id: string;
  title: string;
  kind: 'direct' | 'group';
}

/** $技能候选；owners = 拥有该技能的成员 id（群聊里按被投递成员各自解析） */
export interface SkillOption {
  id: string;
  name: string;
  description: string;
  owners: string[];
}

export interface BotComposerPayload {
  text: string;
  images: AttachedImage[];
  files: string[];
  chats: string[];
  skill?: string;
}

type Item =
  | { kind: 'bot'; bot: BotProfile }
  | { kind: 'all' }
  | { kind: 'chat'; chat: ChatRefOption }
  | { kind: 'file'; path: string; name: string }
  | { kind: 'skill'; skill: SkillOption };

type Popup = { kind: 'at' | 'skill'; start: number; query: string };

interface BotComposerProps {
  chatId: string;
  placeholder: string;
  /** 群聊成员：有值时启用 @ 成员补全 */
  members?: BotProfile[];
  chatOptions?: ChatRefOption[];
  skills?: SkillOption[];
  running: boolean;
  disabled?: boolean;
  toolbar?: ReactNode;
  hint?: ReactNode;
  voice?: StartVoiceSession;
  requestMicAccess?: () => Promise<boolean>;
  /** 返回 false = 发送失败，输入回滚 */
  onSend: (payload: BotComposerPayload) => Promise<boolean>;
  onStop?: () => void;
}

const SECTION: Record<Item['kind'], string> = {
  bot: 'Mention a member',
  all: 'Mention a member',
  chat: 'Reference a chat',
  file: 'Files',
  skill: 'Skills',
};

const itemKey = (item: Item) => {
  switch (item.kind) {
    case 'bot':
      return `bot:${item.bot.id}`;
    case 'all':
      return 'all';
    case 'chat':
      return `chat:${item.chat.id}`;
    case 'file':
      return `file:${item.path}`;
    case 'skill':
      return `skill:${item.skill.id}`;
  }
};

export function BotComposer({
  chatId,
  placeholder,
  members,
  chatOptions = [],
  skills = [],
  running,
  disabled = false,
  toolbar,
  hint,
  voice,
  requestMicAccess,
  onSend,
  onStop,
}: BotComposerProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const [draft, setDraft] = useState<BotComposerDraft>(() => readBotDraft(localStorage, chatId));
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const keybindings = useSettingsStore((s) => s.keybindings);
  const voiceHoldBinding = effectiveKeybindings(keybindings)['voice-hold'];
  const { text } = draft;
  const patchDraft = (patch: Partial<BotComposerDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  // 宿主按 chatId 设 key：换聊天即重新挂载，草稿状态从不跨聊天
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    writeBotDraft(localStorage, chatId, draft);
  }, [chatId, draft]);

  useEffect(
    () =>
      onBotDraftSeeded((id) => {
        if (id === chatId) setDraft(readBotDraft(localStorage, id));
      }),
    [chatId]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: text 变化触发重新测高
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const searchFiles = useCallback(
    (query: string) =>
      window.electronAPI.bots
        .searchFiles({ chatId, query })
        .then((result) => (result.ok ? result.files : [])),
    [chatId]
  );
  const fileHits = useMentionSearch(undefined, popup?.kind === 'at' ? popup.query : null, [], {
    searchFiles,
    agents: false,
  }).files;

  const items: Item[] = (() => {
    if (!popup) return [];
    const query = popup.query.toLowerCase();
    if (popup.kind === 'skill')
      return skills
        .filter((skill) => skill.name.toLowerCase().includes(query))
        .slice(0, 10)
        .map((skill) => ({ kind: 'skill', skill }));
    const list: Item[] = members
      ? mentionCandidates(popup.query, members).map((bot) => ({ kind: 'bot', bot }))
      : [];
    if (members && BOT_MENTION_ALL.some((word) => word.startsWith(query)))
      list.push({ kind: 'all' });
    if (draft.chats.length < CHAT_REF_MAX_PER_MESSAGE)
      list.push(
        ...chatOptions
          .filter(
            (chat) => !draft.chats.includes(chat.id) && chat.title.toLowerCase().includes(query)
          )
          .slice(0, 6)
          .map((chat): Item => ({ kind: 'chat', chat }))
      );
    list.push(
      ...fileHits
        .slice(0, 8)
        .map((file): Item => ({ kind: 'file', path: file.relativePath, name: file.label }))
    );
    return list;
  })();

  const detectPopup = (value: string, caret: number) => {
    const skillQuery = skills.length ? extractSkillQuery(value, caret) : null;
    if (skillQuery !== null) {
      setPopup({ kind: 'skill', start: caret - skillQuery.length - 1, query: skillQuery });
      setActiveIndex(0);
      return;
    }
    const match = /(^|[^A-Za-z0-9._%+-])@([^\s@]*)$/u.exec(value.slice(0, caret));
    if (!match) return setPopup(null);
    setPopup({ kind: 'at', start: caret - match[2].length - 1, query: match[2] });
    setActiveIndex(0);
  };

  const pick = (item: Item) => {
    if (!popup) return;
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? text.length;
    const head = text.slice(0, popup.start);
    const tail = text.slice(caret);
    let inserted = '';
    const patch: Partial<BotComposerDraft> = {};
    if (item.kind === 'bot' || item.kind === 'all')
      inserted = `@${item.kind === 'all' ? t('everyone') : item.bot.name} `;
    else if (item.kind === 'file') {
      inserted = `@${item.path} `;
      patch.files = [...new Set([...draft.files, item.path])];
    } else if (item.kind === 'chat') patch.chats = [...draft.chats, item.chat.id];
    else patch.skill = item.skill.id;
    patchDraft({ ...patch, text: head + inserted + tail });
    setPopup(null);
    const position = head.length + inserted.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(position, position);
    });
  };

  const insertText = (value: string) => {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    patchDraft({ text: text.slice(0, start) + value + text.slice(end) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + value.length, start + value.length);
    });
  };

  const ingest = (files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const url = reader.result as string;
        setImages((list) => [
          ...list,
          { data: url.slice(url.indexOf(',') + 1), mimeType: file.type },
        ]);
      };
      reader.readAsDataURL(file);
    }
  };

  const chatById = new Map(chatOptions.map((chat) => [chat.id, chat]));
  // 回退回填的草稿只带技能名称：按 id 或名称解析
  const skill = draft.skill
    ? skills.find((item) => item.id === draft.skill || item.name === draft.skill)
    : undefined;
  // 群聊：@ 到的成员里没有该技能的，发送前提示（Main 投递时给他们的是「技能不可用」提示）
  const lacking =
    skill && members
      ? members.filter(
          (member) =>
            parseMentions(text, members).ids.includes(member.id) &&
            !skill.owners.includes(member.id)
        )
      : [];

  const canSend =
    !disabled &&
    !sending &&
    (text.trim().length > 0 || images.length > 0 || draft.chats.length > 0 || !!draft.skill);

  const submit = async () => {
    if (!canSend) return;
    const sent = draft;
    const sentImages = images;
    const sentText = sent.text.trim();
    setDraft(EMPTY_BOT_DRAFT);
    setImages([]);
    setPopup(null);
    setSending(true);
    try {
      const ok = await onSend({
        text: sentText,
        images: sentImages,
        files: sent.files.filter((path) => sentText.includes(`@${path}`)),
        chats: sent.chats,
        ...(sent.skill ? { skill: skill?.id ?? sent.skill } : {}),
      });
      if (!ok) {
        setDraft((current) =>
          current.text || current.chats.length || current.skill ? current : sent
        );
        setImages((current) => (current.length ? current : sentImages));
      }
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = event.nativeEvent.isComposing || composingRef.current;
    if (popup && items.length > 0 && !composing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((index) => (index + delta + items.length) % items.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        pick(items[Math.min(activeIndex, items.length - 1)]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setPopup(null);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !composing) {
      event.preventDefault();
      void submit();
    }
  };

  const ownerNames = (ids: string[]) =>
    (members ?? [])
      .filter((member) => ids.includes(member.id))
      .map((member) => member.name)
      .join(', ');

  return (
    <div
      ref={rootRef}
      data-slot="composer"
      className="relative rounded-2xl border bg-background shadow-float"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        ingest([...event.dataTransfer.files]);
      }}
    >
      {popup && items.length > 0 && (
        <div className="absolute bottom-full left-3 z-10 mb-1.5 max-h-80 w-80 overflow-y-auto rounded-xl border bg-popover p-1 shadow-lg">
          {items.map((item, index) => {
            const section = SECTION[item.kind];
            const header = index === 0 || SECTION[items[index - 1].kind] !== section;
            return (
              <div key={itemKey(item)}>
                {header && (
                  <div className="px-2 py-1 text-[11px] text-muted-foreground">{t(section)}</div>
                )}
                <button
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pick(item);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                    index === activeIndex && 'bg-muted'
                  )}
                >
                  <ItemRow item={item} ownerNames={ownerNames} grouped={!!members} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {(draft.chats.length > 0 || draft.skill) && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-3">
          {draft.skill && (
            <RefChip
              icon={<Sparkles className="h-3 w-3" />}
              label={skill?.name ?? draft.skill}
              tone="skill"
              onRemove={() => patchDraft({ skill: undefined })}
            />
          )}
          {draft.chats.map((id) => (
            <RefChip
              key={id}
              icon={<MessagesSquare className="h-3 w-3" />}
              label={chatById.get(id)?.title ?? t('Unavailable chat')}
              onRemove={() => patchDraft({ chats: draft.chats.filter((item) => item !== id) })}
            />
          ))}
        </div>
      )}
      {lacking.length > 0 && (
        <div className="px-4 pt-1.5 text-warning text-xs">
          {t('{{names}} cannot use this skill; they will be told it is unavailable', {
            names: lacking.map((member) => member.name).join(', '),
          })}
        </div>
      )}

      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {images.map((image, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: 附件无稳定 id
              key={index}
              className="group relative h-14 w-14 overflow-hidden rounded-lg border"
            >
              <img
                src={`data:${image.mimeType};base64,${image.data}`}
                alt=""
                className="h-full w-full object-cover"
              />
              <button
                type="button"
                aria-label={t('Remove')}
                onClick={() => setImages((list) => list.filter((_, i) => i !== index))}
                className="absolute top-0.5 right-0.5 hidden rounded-full bg-background/90 p-0.5 group-hover:block"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={text}
        rows={1}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => {
          patchDraft({ text: event.target.value });
          detectPopup(event.target.value, event.target.selectionStart);
        }}
        onSelect={(event) =>
          detectPopup(event.currentTarget.value, event.currentTarget.selectionStart)
        }
        onBlur={() => setPopup(null)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onPaste={(event) => {
          const files = [...event.clipboardData.files].filter((file) =>
            file.type.startsWith('image/')
          );
          if (files.length === 0) return;
          event.preventDefault();
          ingest(files);
        }}
        className="block max-h-56 min-h-12 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
      />

      <div className="flex items-center gap-1.5 px-2.5 pb-2">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          title={t('Attach image')}
          aria-label={t('Attach image')}
        >
          <ImagePlus className="h-4 w-4" />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            ingest([...(event.target.files ?? [])]);
            event.target.value = '';
          }}
        />
        {voice && (
          <VoiceInputButton
            startSession={voice}
            requestMicAccess={requestMicAccess}
            disabled={disabled}
            holdBinding={voiceHoldBinding || undefined}
            holdScope={rootRef}
            onText={insertText}
          />
        )}
        {toolbar}
        <div className="min-w-0 flex-1 truncate text-muted-foreground text-xs">{hint}</div>
        {running && onStop && !canSend ? (
          <button
            type="button"
            onClick={onStop}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"
            title={t('Stop')}
            aria-label={t('Stop')}
          >
            <Square className="h-3 w-3 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            disabled={!canSend}
            onClick={() => void submit()}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-40"
            title={t('Send')}
            aria-label={t('Send')}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function ItemRow({
  item,
  ownerNames,
  grouped,
}: {
  item: Item;
  ownerNames: (ids: string[]) => string;
  grouped: boolean;
}) {
  const { t } = useI18n();
  switch (item.kind) {
    case 'all':
      return (
        <>
          <span className="grid h-6 w-6 place-items-center rounded-full bg-muted text-[11px]">
            @
          </span>
          <span>{t('everyone')}</span>
        </>
      );
    case 'bot':
      return (
        <>
          <BotAvatar bot={item.bot} size="sm" />
          <span className="min-w-0 truncate">{item.bot.name}</span>
          <span className="min-w-0 truncate text-muted-foreground text-xs">{item.bot.title}</span>
        </>
      );
    case 'chat':
      return (
        <>
          <MessagesSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{item.chat.title}</span>
          <span className="shrink-0 text-muted-foreground text-xs">
            {item.chat.kind === 'group' ? t('Group chat') : t('Direct chat')}
          </span>
        </>
      );
    case 'file':
      return (
        <>
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0">{item.name}</span>
          <span className="min-w-0 truncate text-muted-foreground text-xs">{item.path}</span>
        </>
      );
    case 'skill':
      return (
        <>
          <Sparkles className="h-4 w-4 shrink-0 text-info" />
          <span className="shrink-0">{item.skill.name}</span>
          <span className="min-w-0 truncate text-muted-foreground text-xs">
            {grouped ? ownerNames(item.skill.owners) : item.skill.description}
          </span>
        </>
      );
  }
}

function RefChip({
  icon,
  label,
  tone,
  onRemove,
}: {
  icon: ReactNode;
  label: string;
  tone?: 'skill';
  onRemove: () => void;
}) {
  const { t } = useI18n();
  return (
    <span
      className={cn(
        'inline-flex h-6 max-w-56 items-center gap-1 rounded-md px-1.5 text-xs',
        tone === 'skill' ? 'bg-info/15 text-info' : 'bg-muted text-foreground'
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      <button
        type="button"
        aria-label={t('Remove')}
        onClick={onRemove}
        className="rounded opacity-70 hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
