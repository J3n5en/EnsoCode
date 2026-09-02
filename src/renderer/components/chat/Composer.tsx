import { useDroppable } from '@dnd-kit/core';
import { unbindImages } from '@shared/browser/designMode';
import type { AttachedImage, SlashCommand } from '@shared/types/agent';
import type {
  AgentTypeMentionCandidate,
  ChatMentionCandidate,
  MentionCandidate,
  UiElementMentionCandidate,
} from '@shared/types/mentions';
import { ArrowUp, CircleStop, SlashSquare, X } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { flattenMentionRoot, useMentionSearch } from '@/hooks/useMentionSearch';
import { useI18n } from '@/i18n';
import { effectiveKeybindings, eventToBinding } from '@/lib/keybindings';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import {
  registerComposerFocus,
  registerComposerInsert,
  registerComposerInsertText,
  registerComposerInsertUiElement,
} from './composerMentionBridge';
import { COMPOSER_DROP_ID } from './dragDrop';
import { MentionChip } from './MentionChip';
import { MentionEditor, type MentionEditorHandle, type MentionEditorState } from './MentionEditor';
import { MentionPicker } from './MentionPicker';
import { requestOpenChatModelPicker } from './ModelPicker';
import type { ComposerPayload, MentionSegment } from './mentionComposer';
import { createEditorPayload, mentionPopupLayout, resolvePopupKeyAction } from './mentionComposer';
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
  /** @ 弹窗的过去会话候选（宿主从 sessions store 算好传入，保持本组件与 store 解耦） */
  chatCandidates?: ChatMentionCandidate[];
  onSend: (payload: ComposerPayload) => boolean | undefined;
  onAbort: () => void;
}

interface ComposerDraft {
  segments: MentionSegment[];
  images: AttachedImage[];
  slash: string | null;
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
  chatCandidates,
  onSend,
  onAbort,
}: ComposerProps) {
  const { t } = useI18n();
  const mentionPickerId = useId();
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [slash, setSlash] = useState<string | null>(null);
  const [recipient, setRecipient] = useState<AgentTypeMentionCandidate | undefined>(
    initialRecipient
  );
  const prevFocusKeyRef = useRef(focusKey);
  const [dragging, setDragging] = useState(false);

  // 侧栏拖入(dnd-kit):会话/项目行落到输入区插 mention chip。
  // 与 OS 文件拖入(HTML5 dnd)互不干扰:两套事件体系独立。
  const { setNodeRef: setDropRef, isOver: dndOver } = useDroppable({ id: COMPOSER_DROP_ID });
  const [preview, setPreview] = useState<UiElementMentionCandidate | null>(null);
  const boundIds = useRef(new Set<string>());
  useEffect(() => {
    const unsubInsert = registerComposerInsert((candidate) =>
      editorRef.current?.insertMention(candidate)
    );
    const unsubText = registerComposerInsertText((text) => editorRef.current?.insertText(text));
    const unsubFocus = registerComposerFocus(() => editorRef.current?.focus());
    const unsubUi = registerComposerInsertUiElement((candidate, image) => {
      if (image) {
        setImages((current) => [...current, { ...image, id: candidate.imageId }]);
      }
      editorRef.current?.insertMention(candidate);
      editorRef.current?.focus();
    });
    return () => {
      unsubInsert();
      unsubText();
      unsubFocus();
      unsubUi();
    };
  }, []);
  const editorRef = useRef<MentionEditorHandle>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const [popupLayout, setPopupLayout] = useState<{
    left: number;
    flyoutSide: 'left' | 'right';
  }>({ left: 0, flyoutSide: 'right' });
  // 编辑器的纯文本投影与卡片存在性（DOM 是事实源，这里只存渲染需要的派生态）
  const [editorPlain, setEditorPlain] = useState('');
  const [editorHasMentions, setEditorHasMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const mentionGroups = useMentionSearch(cwd, mentionQuery, chatCandidates);
  const mentionItems = useMemo(
    () => flattenMentionRoot(mentionGroups, mentionQuery ?? ''),
    [mentionGroups, mentionQuery]
  );
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [openFolderId, setOpenFolderId] = useState<'agents' | 'chats' | null>(null);
  const [folderIndex, setFolderIndex] = useState(0);
  const slashListRef = useRef<HTMLDivElement>(null);

  /** 编辑器每次输入/光标变化回流：同步 query 与派生态，重置弹窗选中 */
  const handleEditorState = useCallback((state: MentionEditorState) => {
    setEditorPlain(state.plainText);
    setEditorHasMentions(state.hasMentions);
    const nextBound = new Set(
      state.segments
        .filter((segment) => segment.type === 'ui-element' && segment.imageId)
        .map((segment) => (segment.type === 'ui-element' ? segment.imageId : ''))
    );
    const dropped = [...boundIds.current].filter((id) => !nextBound.has(id));
    boundIds.current = nextBound;
    if (dropped.length > 0) {
      setImages((current) => unbindImages(current, dropped));
      setPreview((current) => (current && dropped.includes(current.imageId) ? null : current));
    }
    setMentionQuery((previous) => {
      if (previous !== state.mentionQuery) {
        setActiveIndex(0);
        setOpenFolderId(null);
        setFolderIndex(0);
      }
      return state.mentionQuery;
    });
    setSlashQuery(state.slashQuery);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusKey is a switch signal; values are captured at switch time.
  useEffect(() => {
    const previous = prevFocusKeyRef.current;
    if (previous !== focusKey) {
      if (previous) {
        drafts.set(previous, {
          segments: editorRef.current?.getSegments() ?? [],
          images,
          slash,
          recipient,
        });
      }
      const draft = focusKey ? drafts.get(focusKey) : undefined;
      editorRef.current?.setSegments(draft?.segments ?? []);
      boundIds.current = new Set(
        (draft?.segments ?? [])
          .filter((segment) => segment.type === 'ui-element' && segment.imageId)
          .map((segment) => (segment.type === 'ui-element' ? segment.imageId : ''))
      );
      setImages(draft?.images ?? []);
      setSlash(draft?.slash ?? null);
      setRecipient(draft?.recipient);
      prevFocusKeyRef.current = focusKey;
      setMentionQuery(null);
      setSlashQuery(null);
      setActiveIndex(0);
      setOpenFolderId(null);
      setFolderIndex(0);
    }
    if (autoFocus) editorRef.current?.focus();
  }, [focusKey]);

  useEffect(() => {
    if (!initialRecipient) return;
    setRecipient(initialRecipient);
    onInitialRecipientConsumed?.();
  }, [initialRecipient, onInitialRecipientConsumed]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: injectedDraft is an external one-shot signal.
  useEffect(() => {
    if (!injectedDraft) return;
    const parsed = splitSlashCommand(injectedDraft);
    setSlash(parsed.slash);
    editorRef.current?.setSegments(parsed.rest ? [{ type: 'text', text: parsed.rest }] : []);
    onDraftConsumed?.();
    window.setTimeout(() => editorRef.current?.focus(), 0);
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

  const pickMention = useCallback((candidate: MentionCandidate) => {
    if (candidate.kind === 'agent-type') {
      editorRef.current?.consumeToken('@');
      setRecipient(candidate);
      setMentionQuery(null);
      return;
    }
    // 文件/会话都是内联原子卡片：替换当前 @token，位置/顺序语义天然保留
    editorRef.current?.insertMention(candidate);
    setMentionQuery(null);
  }, []);

  const popupKind =
    mentionQuery !== null && mentionItems.length > 0
      ? 'mention'
      : slashQuery !== null && slashResults.length > 0
        ? 'slash'
        : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: 光标移动、picker 挂载、flyout 打开都要重测宽高
  useLayoutEffect(() => {
    if (popupKind !== 'mention') return;
    const container = composerRef.current;
    if (!container) return;
    const sync = () => {
      const containerRect = container.getBoundingClientRect();
      const picker = container.querySelector('[data-slot="mention-picker"]');
      const listbox = picker?.querySelector('[role="listbox"]');
      const flyout = picker?.querySelector('[data-slot="mention-flyout"]');
      const anchor = editorRef.current?.getMentionAnchorRect();
      const next = mentionPopupLayout({
        anchorLeft: anchor ? anchor.left - containerRect.left : 0,
        containerWidth: containerRect.width,
        popupWidth: listbox instanceof HTMLElement ? listbox.offsetWidth : 280,
        flyoutWidth: flyout instanceof HTMLElement ? flyout.offsetWidth : 252,
        flyoutGap: 4,
      });
      setPopupLayout((previous) =>
        previous.left === next.left && previous.flyoutSide === next.flyoutSide ? previous : next
      );
    };
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, [mentionQuery, editorPlain, openFolderId, popupKind]);
  const popupLength = popupKind === 'mention' ? mentionItems.length : slashResults.length;

  const pickActive = useCallback(() => {
    if (popupKind === 'mention') {
      if (openFolderId) {
        const candidate = mentionGroups[openFolderId][folderIndex];
        if (candidate) pickMention(candidate);
        return;
      }
      const item = mentionItems[activeIndex];
      if (item?.type === 'item') pickMention(item.candidate);
    } else if (popupKind === 'slash') {
      const item = slashResults[activeIndex];
      if (!item) return;
      editorRef.current?.consumeToken('/');
      setSlashQuery(null);
      setSlash(item.name);
    }
  }, [
    activeIndex,
    folderIndex,
    openFolderId,
    mentionGroups,
    mentionItems,
    pickMention,
    popupKind,
    slashResults,
  ]);

  const content = editorPlain.replaceAll('\uFFFC', '').trim();
  const hasContent = Boolean(content || slash || images.length > 0 || editorHasMentions);
  const agentRecipient = recipient !== undefined;
  const effectiveBusy = busy && !agentRecipient;

  const handleSend = () => {
    if (!hasContent) return;
    const payload = createEditorPayload({
      segments: editorRef.current?.getSegments() ?? [],
      slash,
      images,
      recipient,
    });
    if (onSend(payload) === false) return;
    editorRef.current?.clear();
    setImages([]);
    setSlash(null);
    setRecipient(undefined);
    setMentionQuery(null);
    setSlashQuery(null);
  };

  const ingestFiles = useCallback((files: File[]) => {
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
      // 拖入的文件在光标处插原子卡片，位置/顺序语义保留
      editorRef.current?.insertFileChip(filePath);
    }
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const isComposing = event.nativeEvent.isComposing || composingRef.current;
    if (popupKind) {
      const activeItem = popupKind === 'mention' ? mentionItems[activeIndex] : undefined;
      const action = resolvePopupKeyAction({
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing,
        activeIndex,
        itemCount: popupLength,
        folderOpen: popupKind === 'mention' && openFolderId !== null,
        activeIsFolder: popupKind === 'mention' && activeItem?.type === 'folder',
        folderIndex,
        folderItemCount: openFolderId ? mentionGroups[openFolderId].length : 0,
      });
      if (action.type === 'move') {
        event.preventDefault();
        setActiveIndex(action.index);
        setOpenFolderId(null);
        return;
      }
      if (action.type === 'move-folder') {
        event.preventDefault();
        setFolderIndex(action.index);
        return;
      }
      if (action.type === 'open-folder') {
        event.preventDefault();
        if (activeItem?.type === 'folder') setOpenFolderId(activeItem.id);
        setFolderIndex(0);
        return;
      }
      if (action.type === 'close-folder') {
        event.preventDefault();
        setOpenFolderId(null);
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
        setOpenFolderId(null);
        return;
      }
    }
    if (isComposing) return;
    const pressed = eventToBinding(event);
    if (
      pressed &&
      pressed === effectiveKeybindings(useSettingsStore.getState().keybindings)['switch-model']
    ) {
      event.preventDefault();
      requestOpenChatModelPicker();
      return;
    }
    if (event.key === 'Backspace' && slash && content.length === 0 && !editorHasMentions) {
      event.preventDefault();
      setSlash(null);
      return;
    }
    // 文件/会话卡片是 cE=false 原子块，Backspace 浏览器原生整块删除；
    // 只剩 recipient（编辑器外的顶部 chip）需要在编辑器全空时兼顾
    if (event.key === 'Backspace' && recipient && editorRef.current?.isEmpty() && !slash) {
      event.preventDefault();
      setRecipient(undefined);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && enterToSend) {
      event.preventDefault();
      handleSend();
    }
  };

  return (
    <div ref={composerRef} className="relative">
      {popupKind === 'mention' && (
        <MentionPicker
          id={mentionPickerId}
          groups={mentionGroups}
          query={mentionQuery ?? ''}
          activeIndex={activeIndex}
          onActiveIndexChange={setActiveIndex}
          openFolderId={openFolderId}
          folderIndex={folderIndex}
          onOpenFolderIdChange={setOpenFolderId}
          onFolderIndexChange={setFolderIndex}
          onSelect={pickMention}
          left={popupLayout.left}
          flyoutSide={popupLayout.flyoutSide}
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
                editorRef.current?.consumeToken('/');
                setSlashQuery(null);
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
        ref={setDropRef}
        data-slot="composer"
        className={cn(
          'rounded-xl border bg-background shadow-sm transition-colors focus-within:border-ring',
          (dragging || dndOver) && 'border-ring bg-muted/30',
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
        {images.filter((image) => !image.id).length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {images
              .filter((image) => !image.id)
              .map((image, index) => (
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
            <MentionChip recipient={recipient} onRemove={() => setRecipient(undefined)} />
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
          <MentionEditor
            ref={editorRef}
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
            onStateChange={handleEditorState}
            onChipActivate={(segment) => {
              if (segment.type === 'ui-element') {
                setPreview({
                  kind: 'ui-element',
                  id: segment.id,
                  label: segment.label,
                  path: segment.path,
                  text: segment.text,
                  imageId: segment.imageId,
                });
              }
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
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            ariaProps={{
              role: 'combobox',
              'aria-autocomplete': 'list',
              'aria-expanded': popupKind !== null,
              'aria-controls': popupKind === 'mention' ? mentionPickerId : undefined,
              'aria-activedescendant':
                popupKind === 'mention'
                  ? openFolderId
                    ? `${mentionPickerId}-sub-${folderIndex}`
                    : `${mentionPickerId}-option-${activeIndex}`
                  : undefined,
            }}
          />
        </div>
        {agentRecipient && <p className="sr-only">{t('Send only to the selected Agent')}</p>}
        <div className="flex items-center justify-between gap-1.5 px-1.5 pb-1">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">{toolbar}</div>
          {effectiveBusy ? (
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-lg"
              onClick={onAbort}
            >
              <CircleStop className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="h-7 w-7 shrink-0 rounded-lg"
              onClick={handleSend}
              disabled={!hasContent || locked}
              aria-label={agentRecipient ? t('Send only to the selected Agent') : t('Send')}
              title={agentRecipient ? t('Send only to the selected Agent') : t('Send')}
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{preview?.label ?? t('Selected UI element')}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-2 text-xs">
            {preview && (
              <>
                <p className="text-muted-foreground break-all">{preview.path}</p>
                {preview.text && <p>{preview.text}</p>}
                {(() => {
                  const image = images.find((item) => item.id === preview.imageId);
                  return image ? (
                    <img
                      src={`data:${image.mimeType};base64,${image.data}`}
                      alt=""
                      className="max-h-72 w-full rounded-md border object-contain"
                    />
                  ) : null;
                })()}
              </>
            )}
          </DialogPanel>
        </DialogContent>
      </Dialog>
    </div>
  );
}
