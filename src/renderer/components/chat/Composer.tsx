import { useDroppable } from '@dnd-kit/core';
import { unbindImages } from '@shared/browser/designMode';
import { filterSlashSubcommands, slashSubcommandQuery } from '@shared/slashSubcommands';
import type { AttachedImage, SlashCommand } from '@shared/types/agent';
import type {
  AgentTypeMentionCandidate,
  ChatMentionCandidate,
  MentionCandidate,
  UiElementMentionCandidate,
} from '@shared/types/mentions';
import type { StartVoiceSession } from '@shared/types/speech';
import { ArrowUp, CircleStop, ImagePlus, SlashSquare, X } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  flattenMentionRoot,
  type MentionFolderId,
  useMentionSearch,
} from '@/hooks/useMentionSearch';
import { useI18n } from '@/i18n';
import { effectiveKeybindings, eventToBinding, formatBinding } from '@/lib/keybindings';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import {
  registerComposerFocus,
  registerComposerInsert,
  registerComposerInsertImage,
  registerComposerInsertText,
  registerComposerInsertUiElement,
} from './composerMentionBridge';
import { COMPOSER_DROP_ID } from './dragDrop';
import { HoldToTalk, HoldToTalkToggle } from './HoldToTalk';
import { applyInjectedDraft } from './injectedDraft';
import { MentionChip } from './MentionChip';
import { MentionEditor, type MentionEditorHandle, type MentionEditorState } from './MentionEditor';
import { MentionPicker } from './MentionPicker';
import { requestOpenChatModelPicker } from './ModelPicker';
import type { ComposerPayload, MentionSegment } from './mentionComposer';
import { createEditorPayload, mentionPopupLayout, resolvePopupKeyAction } from './mentionComposer';
import { SlashChip } from './SlashChip';
import { filterComposerCommands } from './skillCompletion';
import { VoiceInputButton } from './VoiceInputButton';

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
  injectedImages?: AttachedImage[];
  injectedDraftAppend?: boolean;
  onDraftConsumed?: () => void;
  initialRecipient?: AgentTypeMentionCandidate;
  onInitialRecipientConsumed?: () => void;
  /** @ 弹窗的过去会话候选（宿主从 sessions store 算好传入，保持本组件与 store 解耦） */
  chatCandidates?: ChatMentionCandidate[];
  /** 浏览不自动 spawn：用户开始打字/聚焦输入框时再拉 worker */
  onActivate?: () => void;
  onSend: (payload: ComposerPayload) => boolean | undefined;
  onAbort: () => void;
  /** 排队消息数；运行中且输入为空时，发送快捷键改为 steer 队首一条 */
  queuedCount?: number;
  onSteerQueued?: () => void;
  /**
   * 侧栏旁路等第二输入框：不抢主 Composer 的 insert/focus 桥，也不吃侧栏拖放。
   * 主会话必须保持默认 false。
   */
  isolated?: boolean;
  /** 覆盖默认「Type @ …」占位；slash / locked / agent 文案仍优先 */
  placeholder?: string;
  /** Plan 模式：边框提示当前只读规划 */
  planMode?: boolean;
  /** 语音输入：给出即显示麦克风，边录边推 16kHz PCM；桌面走 IPC，手机走配对信道 */
  voice?: StartVoiceSession;
  /** 录音前向系统申请麦克风（macOS 需主进程发起） */
  requestMicAccess?: () => Promise<boolean>;
  /** hold = 手机微信式：麦克风切出输入框下方的「按住 说话」 */
  voiceMode?: 'click' | 'hold';
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
  injectedImages,
  injectedDraftAppend,
  onDraftConsumed,
  initialRecipient,
  onInitialRecipientConsumed,
  chatCandidates,
  onActivate,
  onSend,
  onAbort,
  queuedCount = 0,
  onSteerQueued,
  isolated = false,
  placeholder: placeholderText,
  planMode = false,
  voice,
  requestMicAccess,
  voiceMode = 'click',
}: ComposerProps) {
  const { t } = useI18n();
  const [holdToTalk, setHoldToTalk] = useState(false);
  // 断线重连时语音会短暂不可用：不清掉按住说话，恢复后原样回来
  const holdVoice = voiceMode === 'hold' ? voice : undefined;
  const keybindings = useSettingsStore((s) => s.keybindings);
  const sendBinding = effectiveKeybindings(keybindings)['send-message'];
  const voiceHoldBinding = effectiveKeybindings(keybindings)['voice-hold'];
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
  const { setNodeRef: setDropRef, isOver: dndOver } = useDroppable({
    id: isolated ? `isolated-composer:${focusKey ?? 'side'}` : COMPOSER_DROP_ID,
    disabled: isolated,
  });
  const [preview, setPreview] = useState<UiElementMentionCandidate | null>(null);
  const [imagePreview, setImagePreview] = useState<AttachedImage | null>(null);
  const boundIds = useRef(new Set<string>());
  useEffect(() => {
    if (isolated) return;
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
    const unsubImage = registerComposerInsertImage((image) => {
      setImages((current) => [...current, { data: image.data, mimeType: image.mimeType }]);
      editorRef.current?.focus();
    });
    return () => {
      unsubInsert();
      unsubText();
      unsubFocus();
      unsubUi();
      unsubImage();
    };
  }, [isolated]);
  const editorRef = useRef<MentionEditorHandle>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
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
  const [skillQuery, setSkillQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [openFolderId, setOpenFolderId] = useState<MentionFolderId | null>(null);
  const [folderIndex, setFolderIndex] = useState(0);
  const slashListRef = useRef<HTMLDivElement>(null);

  /** 编辑器每次输入/光标变化回流：同步 query 与派生态，重置弹窗选中 */
  const handleEditorState = useCallback(
    (state: MentionEditorState) => {
      if (state.plainText.trim() || state.hasMentions) onActivate?.();
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
      setSkillQuery(state.skillQuery);
    },
    [onActivate]
  );

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
      setSkillQuery(null);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: injected content is an external one-shot signal.
  useEffect(() => {
    if (!injectedDraft && !injectedImages?.length) return;
    const draft = applyInjectedDraft(
      { segments: editorRef.current?.getSegments() ?? [], images, slash },
      { text: injectedDraft, images: injectedImages },
      injectedDraftAppend
    );
    setSlash(draft.slash);
    setImages(draft.images);
    editorRef.current?.setSegments(draft.segments);
    onDraftConsumed?.();
    window.setTimeout(() => editorRef.current?.focus(), 0);
  }, [injectedDraft, injectedImages, injectedDraftAppend]);

  const subQuery = slashSubcommandQuery(slash, editorPlain.replaceAll('\uFFFC', ''));
  const slashResults = filterComposerCommands(commands, slashQuery, skillQuery);
  const subResults =
    slashQuery === null && skillQuery === null && subQuery !== null
      ? filterSlashSubcommands(slash, subQuery)
      : [];

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset highlight when the filter token changes
  useEffect(() => {
    setActiveIndex(0);
  }, [slashQuery, skillQuery, subQuery]);

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
      : slashResults.length > 0
        ? 'slash'
        : subResults.length > 0
          ? 'slash-sub'
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
  const popupLength =
    popupKind === 'mention'
      ? mentionItems.length
      : popupKind === 'slash-sub'
        ? subResults.length
        : slashResults.length;

  const applySlashSubcommand = useCallback(
    (name: string, sendNow: boolean) => {
      const segments: MentionSegment[] = [{ type: 'text', text: name }];
      editorRef.current?.setSegments(segments);
      if (!sendNow) return;
      const payload = createEditorPayload({
        segments,
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
      setSkillQuery(null);
    },
    [images, onSend, recipient, slash]
  );

  const pickActive = useCallback(
    (submitSubcommand = false) => {
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
        editorRef.current?.consumeToken(skillQuery !== null ? '$' : '/');
        setSlashQuery(null);
        setSkillQuery(null);
        setSlash(item.name);
      } else if (popupKind === 'slash-sub') {
        const item = subResults[activeIndex];
        if (!item) return;
        applySlashSubcommand(item.name, submitSubcommand);
      }
    },
    [
      activeIndex,
      folderIndex,
      openFolderId,
      mentionGroups,
      mentionItems,
      pickMention,
      popupKind,
      slashResults,
      skillQuery,
      subResults,
      applySlashSubcommand,
    ]
  );

  const content = editorPlain.replaceAll('\uFFFC', '').trim();
  const hasContent = Boolean(content || slash || images.length > 0 || editorHasMentions);
  const agentRecipient = recipient !== undefined;
  const effectiveBusy = busy && !agentRecipient;
  // 仅快捷键触发，无绑定时不提示
  const steerAvailable =
    running && queuedCount > 0 && onSteerQueued !== undefined && enterToSend && !!sendBinding;
  const steerable = steerAvailable && !hasContent && !agentRecipient && !locked;

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
    setSkillQuery(null);
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
        pickActive(popupKind === 'slash-sub' && event.key === 'Enter');
        return;
      }
      if (action.type === 'close') {
        event.preventDefault();
        setMentionQuery(null);
        setSlashQuery(null);
        setSkillQuery(null);
        setOpenFolderId(null);
        return;
      }
    }
    if (isComposing) return;
    const pressed = eventToBinding(event);
    if (
      !isolated &&
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
    if (enterToSend && !popupKind) {
      const pressedSend = eventToBinding(event, { allowBare: true });
      if (pressedSend === sendBinding) {
        event.preventDefault();
        if (steerable) onSteerQueued?.();
        else handleSend();
      }
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
      {(popupKind === 'slash' || popupKind === 'slash-sub') && (
        <div
          ref={slashListRef}
          role="listbox"
          aria-label={t('Command suggestions')}
          className="absolute bottom-full left-0 z-10 mb-1.5 max-h-64 w-full overflow-y-auto rounded-lg border bg-popover p-1 shadow-md"
        >
          {(popupKind === 'slash' ? slashResults : subResults).map((item, index) => (
            <button
              key={item.name}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              onClick={() => {
                setActiveIndex(index);
                if (popupKind === 'slash') {
                  editorRef.current?.consumeToken(skillQuery !== null ? '$' : '/');
                  setSlashQuery(null);
                  setSkillQuery(null);
                  setSlash(item.name);
                } else {
                  applySlashSubcommand(item.name, false);
                }
              }}
              onMouseMove={() => setActiveIndex(index)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
                // 同 MentionPicker：浅色主题下 bg-muted 在纯白 popover 上不可见
                index === activeIndex && 'bg-foreground/10'
              )}
            >
              <SlashSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0 font-mono font-medium">
                {skillQuery !== null ? `$${item.name.slice('/skill:'.length)}` : item.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {t(item.description)}
              </span>
            </button>
          ))}
        </div>
      )}

      <div
        ref={setDropRef}
        data-slot="composer"
        className={cn(
          'rounded-2xl border bg-background shadow-float transition-[border-color,box-shadow] duration-200 focus-within:border-brand/45 focus-within:ring-3 focus-within:ring-brand/12',
          (dragging || dndOver) && 'border-brand/50 bg-brand/5',
          (agentRecipient || planMode) && 'border-primary/35 shadow-primary/5'
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
                  <button
                    type="button"
                    onClick={() => setImagePreview(image)}
                    className="block rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    aria-label={t('Preview')}
                  >
                    <img
                      src={`data:${image.mimeType};base64,${image.data}`}
                      alt=""
                      className="h-16 w-16 rounded-md border object-cover"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setImages((current) => current.filter((_, item) => item !== index))
                    }
                    className="absolute -top-1.5 -right-1.5 rounded-full border bg-background p-0.5 text-muted-foreground shadow-sm transition-opacity hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
          </div>
        )}
        <div
          className={cn('flex items-start gap-1.5 px-4', images.length > 0 ? 'pt-1.5' : 'pt-3.5')}
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
                    : steerAvailable
                      ? t('Press {{key}} to steer the next queued message into this round…', {
                          key: formatBinding(sendBinding),
                        })
                      : placeholderText
                        ? placeholderText
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
        <div className="flex items-center justify-between gap-1.5 px-2 pt-0.5 pb-2">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => {
                ingestFiles(Array.from(event.target.files ?? []));
                event.target.value = '';
              }}
            />
            <button
              type="button"
              disabled={locked}
              onClick={() => imageInputRef.current?.click()}
              aria-label={t('Attach image')}
              title={t('Attach image')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <ImagePlus className="h-3.5 w-3.5" />
            </button>
            {holdVoice ? (
              <HoldToTalkToggle
                active={holdToTalk}
                disabled={locked}
                onChange={(active) => {
                  setHoldToTalk(active);
                  // 按住说话时收起软键盘；切回键盘直接聚焦
                  if (active) (document.activeElement as HTMLElement | null)?.blur();
                  else editorRef.current?.focus();
                }}
              />
            ) : voice ? (
              <VoiceInputButton
                startSession={voice}
                requestMicAccess={requestMicAccess}
                disabled={locked}
                holdBinding={voiceHoldBinding || undefined}
                holdScope={composerRef}
                onText={(text) => {
                  editorRef.current?.insertText(text);
                  editorRef.current?.focus();
                }}
              />
            ) : null}
            {toolbar}
          </div>
          {/* 生成中且输入为空才显示停止；有草稿则保持发送，方便手机点按钮入队 */}
          {effectiveBusy && !hasContent ? (
            <Button
              variant="outline"
              size="icon"
              className="size-8 shrink-0 rounded-[10px]"
              onClick={onAbort}
              aria-label={t('Stop')}
            >
              <CircleStop className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="size-8 shrink-0 rounded-[10px] border-brand bg-brand text-brand-foreground shadow-brand/24 hover:bg-brand/90 disabled:opacity-35"
              onClick={handleSend}
              disabled={!hasContent || locked}
              aria-label={agentRecipient ? t('Send only to the selected Agent') : t('Send')}
              title={
                agentRecipient
                  ? t('Send only to the selected Agent')
                  : enterToSend
                    ? sendBinding
                      ? `${t('Send')} ${formatBinding(sendBinding)}`
                      : t('Send')
                    : t('Send')
              }
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      {holdVoice && holdToTalk ? (
        <HoldToTalk
          startSession={holdVoice}
          disabled={locked}
          onText={(text) => {
            editorRef.current?.insertText(text);
            // 插入会聚焦编辑器，按住说话模式下不弹键盘
            (document.activeElement as HTMLElement | null)?.blur();
          }}
        />
      ) : null}
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
      <Dialog open={imagePreview !== null} onOpenChange={(open) => !open && setImagePreview(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('Preview')}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {imagePreview && (
              <img
                src={`data:${imagePreview.mimeType};base64,${imagePreview.data}`}
                alt=""
                className="max-h-[80vh] w-full rounded-md object-contain"
              />
            )}
          </DialogPanel>
        </DialogContent>
      </Dialog>
    </div>
  );
}
