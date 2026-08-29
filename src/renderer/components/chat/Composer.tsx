import type { AttachedImage, SlashCommand } from '@shared/types/agent';
import type { AgentTypeMentionCandidate, MentionCandidate } from '@shared/types/mentions';
import { ArrowUp, CircleStop, SlashSquare, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { flattenMentionGroups, useMentionSearch } from '@/hooks/useMentionSearch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { MentionChip } from './MentionChip';
import { MentionPicker } from './MentionPicker';
import type { ComposerPayload } from './mentionComposer';
import {
  createComposerPayload,
  extractMentionQuery,
  resolvePopupKeyAction,
  unresolvedMentionToken,
} from './mentionComposer';
import { SlashChip, splitSlashCommand } from './SlashChip';

interface ComposerProps {
  cwd?: string;
  commands: SlashCommand[];
  running: boolean;
  busy: boolean;
  focusKey?: string;
  /** 挂载/切会话时是否自动聚焦。移动端置 false，否则一进会话就弹出键盘挡住内容 */
  autoFocus?: boolean;
  /**
   * Enter 是否发送（默认 true，桌面习惯）。移动端置 false：软键盘的「换行」
   * 也是 Enter keydown，默认行为会把换行变成误发送；此时只能点发送按钮。
   */
  enterToSend?: boolean;
  /** 底部工具行左侧插槽（模型选择器等） */
  toolbar?: React.ReactNode;
  locked?: boolean;
  injectedDraft?: string;
  onDraftConsumed?: () => void;
  initialRecipient?: AgentTypeMentionCandidate;
  onInitialRecipientConsumed?: () => void;
  onSend: (payload: ComposerPayload) => boolean | undefined;
  onAbort: () => void;
}

function findSlashStart(text: string, cursor: number): number | null {
  for (let index = cursor - 1; index >= 0; index--) {
    const character = text[index];
    if (character === '/') {
      const previous = index > 0 ? text[index - 1] : ' ';
      return previous === ' ' || previous === '\n' ? index : null;
    }
    if (character === ' ' || character === '\n') return null;
  }
  return null;
}

interface ComposerDraft {
  text: string;
  images: AttachedImage[];
  slash: string | null;
  mentions: MentionCandidate[];
  recipient?: AgentTypeMentionCandidate;
}

const drafts = new Map<string, ComposerDraft>();

export function Composer({
  cwd,
  commands,
  running,
  busy,
  focusKey,
  autoFocus = true,
  enterToSend = true,
  toolbar,
  locked = false,
  injectedDraft,
  onDraftConsumed,
  initialRecipient,
  onInitialRecipientConsumed,
  onSend,
  onAbort,
}: ComposerProps) {
  const { t } = useI18n();
  const mentionPickerId = useId();
  const [text, setText] = useState('');
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [slash, setSlash] = useState<string | null>(null);
  const [mentions, setMentions] = useState<MentionCandidate[]>(() =>
    initialRecipient ? [initialRecipient] : []
  );
  const [recipient, setRecipient] = useState<AgentTypeMentionCandidate | undefined>(
    initialRecipient
  );
  const prevFocusKeyRef = useRef(focusKey);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const mentionGroups = useMentionSearch(cwd, mentionQuery);
  const mentionItems = useMemo(() => flattenMentionGroups(mentionGroups), [mentionGroups]);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const slashListRef = useRef<HTMLDivElement>(null);

  const detect = useCallback((value: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    window.setTimeout(() => {
      const cursor = textarea.selectionStart;
      const mention = extractMentionQuery(value, cursor);
      setMentionQuery(mention);
      const slashStart = mention === null ? findSlashStart(value, cursor) : null;
      setSlashQuery(slashStart === null ? null : value.slice(slashStart + 1, cursor));
      setActiveIndex(0);
    }, 0);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusKey is a switch signal; values are captured at switch time.
  useEffect(() => {
    const previous = prevFocusKeyRef.current;
    let nextText = text;
    if (previous !== focusKey) {
      if (previous) drafts.set(previous, { text, images, slash, mentions, recipient });
      const draft = focusKey ? drafts.get(focusKey) : undefined;
      nextText = draft?.text ?? '';
      setText(nextText);
      setImages(draft?.images ?? []);
      setSlash(draft?.slash ?? null);
      setMentions(draft?.mentions ?? []);
      setRecipient(draft?.recipient);
      prevFocusKeyRef.current = focusKey;
      setMentionQuery(null);
      setSlashQuery(null);
      setActiveIndex(0);
    }
    if (autoFocus) textareaRef.current?.focus();
    if (previous !== focusKey) {
      const restored = nextText;
      setTimeout(() => detect(restored), 0);
    }
  }, [focusKey]);

  useEffect(() => {
    if (!initialRecipient) return;
    setRecipient(initialRecipient);
    setMentions((current) => [
      ...current.filter((mention) => mention.kind !== 'agent-type'),
      initialRecipient,
    ]);
    onInitialRecipientConsumed?.();
  }, [initialRecipient, onInitialRecipientConsumed]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: injectedDraft is an external one-shot signal.
  useEffect(() => {
    if (!injectedDraft) return;
    const parsed = splitSlashCommand(injectedDraft);
    setSlash(parsed.slash);
    setText(parsed.rest);
    onDraftConsumed?.();
    window.setTimeout(() => {
      textareaRef.current?.focus();
      detect(parsed.rest);
    }, 0);
  }, [injectedDraft]);

  const slashResults =
    slashQuery === null
      ? []
      : commands
          .filter((command) => command.name.toLowerCase().includes(slashQuery.toLowerCase()))
          .slice(0, 10);

  useEffect(() => {
    const item = slashListRef.current?.children[activeIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const replaceToken = useCallback(
    (trigger: '@' | '/', replacement: string) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const cursor = textarea.selectionStart;
      let start = -1;
      for (let index = cursor - 1; index >= 0; index--) {
        if (text[index] === trigger) {
          start = index;
          break;
        }
        if (text[index] === ' ' || text[index] === '\n') break;
      }
      if (start === -1) return;
      const next = text.slice(0, start) + replacement + text.slice(cursor);
      setText(next);
      setMentionQuery(null);
      setSlashQuery(null);
      const newCursor = start + replacement.length;
      window.setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(newCursor, newCursor);
      }, 0);
    },
    [text]
  );

  const pickMention = useCallback(
    (candidate: MentionCandidate) => {
      if (candidate.kind === 'agent-type') {
        replaceToken('@', '');
        setRecipient(candidate);
        setMentions((current) => [
          ...current.filter((mention) => mention.kind !== 'agent-type'),
          candidate,
        ]);
        return;
      }
      replaceToken('@', `@${candidate.relativePath} `);
      setMentions((current) =>
        current.some(
          (mention) => mention.kind === 'file' && mention.relativePath === candidate.relativePath
        )
          ? current
          : [...current, candidate]
      );
    },
    [replaceToken]
  );

  const popupKind =
    mentionQuery !== null && mentionItems.length > 0
      ? 'mention'
      : slashQuery !== null && slashResults.length > 0
        ? 'slash'
        : null;
  const popupLength = popupKind === 'mention' ? mentionItems.length : slashResults.length;

  const pickActive = useCallback(() => {
    if (popupKind === 'mention') {
      const item = mentionItems[activeIndex];
      if (item) pickMention(item.candidate);
    } else if (popupKind === 'slash') {
      const item = slashResults[activeIndex];
      if (!item) return;
      replaceToken('/', '');
      setSlash(item.name);
    }
  }, [activeIndex, mentionItems, pickMention, popupKind, replaceToken, slashResults]);

  const unresolvedToken = unresolvedMentionToken(text, mentions);
  const content = text.trim();
  const hasContent = Boolean(content || slash || images.length > 0);
  const agentRecipient = recipient !== undefined;
  const effectiveBusy = busy && !agentRecipient;

  const handleSend = () => {
    if (!hasContent || unresolvedToken) return;
    const payload = createComposerPayload({ text, slash, images, mentions, recipient });
    if (onSend(payload) === false) return;
    setText('');
    setImages([]);
    setSlash(null);
    setMentions([]);
    setRecipient(undefined);
    setMentionQuery(null);
    setSlashQuery(null);
  };

  const insertAtCursor = useCallback(
    (snippet: string) => {
      const textarea = textareaRef.current;
      const cursor = textarea ? textarea.selectionStart : text.length;
      const next = text.slice(0, cursor) + snippet + text.slice(cursor);
      setText(next);
      const newCursor = cursor + snippet.length;
      window.setTimeout(() => {
        textarea?.focus();
        textarea?.setSelectionRange(newCursor, newCursor);
      }, 0);
    },
    [text]
  );

  const ingestFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
            setImages((current) => [...current, { data: base64, mimeType: file.type }]);
          };
          reader.readAsDataURL(file);
          continue;
        }
        const filePath = window.electronAPI.files.pathForFile(file);
        if (!filePath) continue;
        insertAtCursor(`@${filePath} `);
        setMentions((current) => [
          ...current.filter(
            (mention) => mention.kind !== 'file' || mention.relativePath !== filePath
          ),
          {
            kind: 'file',
            id: filePath,
            label: file.name || filePath.split('/').at(-1) || filePath,
            relativePath: filePath,
          },
        ]);
      }
    },
    [insertAtCursor]
  );

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const isComposing = event.nativeEvent.isComposing || composingRef.current;
    if (popupKind) {
      const action = resolvePopupKeyAction({
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing,
        activeIndex,
        itemCount: popupLength,
      });
      if (action.type === 'move') {
        event.preventDefault();
        setActiveIndex(action.index);
        return;
      }
      if (action.type === 'pick') {
        event.preventDefault();
        pickActive();
        return;
      }
      if (action.type === 'close') {
        event.preventDefault();
        setMentionQuery(null);
        setSlashQuery(null);
        return;
      }
    }
    if (isComposing) return;
    if (event.key === 'Backspace' && slash && text.length === 0) {
      event.preventDefault();
      setSlash(null);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && enterToSend) {
      event.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="relative">
      {popupKind === 'mention' && (
        <MentionPicker
          id={mentionPickerId}
          groups={mentionGroups}
          activeIndex={activeIndex}
          onActiveIndexChange={setActiveIndex}
          onSelect={pickMention}
        />
      )}
      {popupKind === 'slash' && (
        <div
          ref={slashListRef}
          role="listbox"
          aria-label={t('Command suggestions')}
          className="absolute bottom-full left-0 z-10 mb-1.5 max-h-64 w-full overflow-y-auto rounded-lg border bg-popover p-1 shadow-md"
        >
          {slashResults.map((item, index) => (
            <button
              key={item.name}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              onClick={() => {
                setActiveIndex(index);
                replaceToken('/', '');
                setSlash(item.name);
              }}
              onMouseMove={() => setActiveIndex(index)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
                // 同 MentionPicker：浅色主题下 bg-muted 在纯白 popover 上不可见
                index === activeIndex && 'bg-foreground/10'
              )}
            >
              <SlashSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0 font-mono font-medium">{item.name}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {item.description}
              </span>
            </button>
          ))}
        </div>
      )}

      <div
        data-slot="composer"
        className={cn(
          'rounded-xl border bg-background shadow-sm transition-colors focus-within:border-ring',
          dragging && 'border-ring bg-muted/30',
          agentRecipient && 'border-primary/35 shadow-primary/5'
        )}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={(event) => {
          const files = Array.from(event.dataTransfer.files);
          if (files.length === 0) return;
          event.preventDefault();
          setDragging(false);
          ingestFiles(files);
        }}
      >
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {images.map((image, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: attachments have no stable id.
              <div key={index} className="group relative">
                <img
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt=""
                  className="h-16 w-16 rounded-md border object-cover"
                />
                <button
                  type="button"
                  onClick={() =>
                    setImages((current) => current.filter((_, item) => item !== index))
                  }
                  className="absolute -top-1.5 -right-1.5 rounded-full border bg-background p-0.5 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-destructive group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          className={cn('flex items-start gap-1.5 px-3.5', images.length > 0 ? 'pt-1.5' : 'pt-3')}
        >
          {recipient && (
            <MentionChip
              recipient={recipient}
              onRemove={() => {
                setRecipient(undefined);
                setMentions((current) =>
                  current.filter((mention) => mention.kind !== 'agent-type')
                );
              }}
            />
          )}
          {slash && (
            <SlashChip
              name={slash}
              className="mt-0.5 shrink-0"
              trailing={
                <button
                  type="button"
                  onClick={() => setSlash(null)}
                  className="rounded-sm opacity-70 hover:opacity-100"
                  aria-label={t('Remove')}
                >
                  <X className="h-3 w-3" />
                </button>
              }
            />
          )}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => {
              const next = event.target.value;
              setText(next);
              setMentions((current) =>
                current.filter(
                  (mention) =>
                    mention.kind === 'agent-type' || next.includes(`@${mention.relativePath}`)
                )
              );
              detect(next);
            }}
            onKeyDown={handleKeyDown}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length === 0) return;
              event.preventDefault();
              ingestFiles(files);
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              detect((event.target as HTMLTextAreaElement).value);
            }}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={popupKind !== null}
            aria-controls={popupKind === 'mention' ? mentionPickerId : undefined}
            aria-activedescendant={
              popupKind === 'mention' ? `${mentionPickerId}-option-${activeIndex}` : undefined
            }
            placeholder={
              slash
                ? ''
                : locked
                  ? t('Resolve the pending approval to continue')
                  : agentRecipient
                    ? t('Message the selected Agent…')
                    : running
                      ? t('Message will queue until this round finishes…')
                      : t('Type @ to choose a file or Agent')
            }
            disabled={locked}
            rows={2}
            className="max-h-40 min-w-0 flex-1 resize-none bg-transparent pt-0.5 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {unresolvedToken && (
          <p role="alert" className="px-3.5 pt-1 text-[11px] text-destructive">
            {t('Choose a mention suggestion before sending')}: @{unresolvedToken}
          </p>
        )}
        {agentRecipient && !unresolvedToken && (
          <p className="px-3.5 pt-1 text-[11px] text-primary/80">
            {t('This message and selected files go only to the selected Agent')}
          </p>
        )}
        <div className="flex items-center justify-between gap-1.5 px-1.5 pb-1">
          <div className="flex min-w-0 items-center gap-1">{toolbar}</div>
          {effectiveBusy ? (
            <Button variant="outline" size="icon" className="h-7 w-7 rounded-lg" onClick={onAbort}>
              <CircleStop className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="h-7 w-7 rounded-lg"
              onClick={handleSend}
              disabled={!hasContent || Boolean(unresolvedToken) || locked}
              aria-label={agentRecipient ? t('Send only to the selected Agent') : t('Send')}
              title={agentRecipient ? t('Send only to the selected Agent') : t('Send')}
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
