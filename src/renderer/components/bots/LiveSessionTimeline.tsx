import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { type ChatHost, ChatHostContext, type ChatSpeaker } from '@/components/chat/chatHost';
import {
  CHAT_COL,
  MessageTimeline,
  type MessageTimelineHandle,
} from '@/components/chat/MessageTimeline';
import { RetryBar } from '@/components/chat/RetryBar';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useBotsStore } from '@/stores/bots';
import { focusStep, messageItemKey } from '@/stores/bots/focus';
import { buildTimeline } from '@/stores/sessions/timeline';

/** 搜索跳转：滚到该消息并用查询词短暂高亮 */
export interface MessageFocus {
  messageIndex: number;
  query: string;
  nonce: number;
}

const FLASH_MS = 2500;

/**
 * 消费一次跳转请求：目标比已加载最早一条还早就向前翻页，加载到后滚动并高亮；
 * 翻到头仍找不到也结束。返回给 MessageTimeline 的高亮参数。
 */
export function useMessageFocus({
  focus,
  timelineRef,
  items,
  baseIndex,
  hasMessages,
  loading,
  loadOlder,
  onDone,
}: {
  focus: MessageFocus | undefined;
  timelineRef: RefObject<MessageTimelineHandle | null>;
  items: readonly { key: string }[];
  baseIndex: number;
  hasMessages: boolean;
  loading: boolean;
  loadOlder: () => void;
  onDone?: (nonce: number) => void;
}): { searchQuery: string; activeHit: { key: string; nth: number } | null } {
  const [flash, setFlash] = useState<{ key: string; query: string } | null>(null);
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (!focus || handled.current === focus.nonce) return;
    const step = focusStep({
      target: focus.messageIndex,
      earliest: hasMessages ? baseIndex : undefined,
      hasOlder: baseIndex > 0,
      loading,
    });
    if (step === 'wait') return;
    if (step === 'load') {
      loadOlder();
      return;
    }
    handled.current = focus.nonce;
    onDone?.(focus.nonce);
    const key = step === 'scroll' ? messageItemKey(items, focus.messageIndex) : undefined;
    if (!key) return;
    // 等新页 / 新挂载的列表完成一帧布局再滚
    window.setTimeout(() => timelineRef.current?.scrollToKey(key), 60);
    setFlash({ key, query: focus.query });
  }, [focus, items, baseIndex, hasMessages, loading, loadOlder, onDone, timelineRef]);
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);
  return {
    searchQuery: flash?.query ?? '',
    activeHit: flash ? { key: flash.key, nth: 0 } : null,
  };
}

interface LiveSessionTimelineProps {
  conversationId: string;
  speaker: ChatSpeaker;
  emptyTitle: string;
  className?: string;
  focus?: MessageFocus;
  onFocusDone?: (nonce: number) => void;
  /** 一轮最终回复下方的附加内容（私聊产物卡片） */
  turnFooter?: (messageIndex: number) => ReactNode;
  /** 私聊当前会话：开启回退 / 重试（须稳定引用） */
  controls?: ChatHost['botControls'];
}

/** 成员会话的实时投影（私聊正文、群里正在回复的成员） */
export function LiveSessionTimeline({
  conversationId,
  speaker,
  emptyTitle,
  className,
  focus,
  onFocusDone,
  turnFooter,
  controls,
}: LiveSessionTimelineProps) {
  const projection = useBotsStore((s) => s.sessions[conversationId]);
  const historyLoading = useBotsStore((s) => Boolean(s.sessionHistoryLoading[conversationId]));
  const timelineRef = useRef<MessageTimelineHandle>(null);
  const running = projection?.status === 'running';
  const items = useMemo(
    () =>
      projection
        ? buildTimeline(projection.messages, running, projection.customEntries, undefined, {
            historyBaseIndex: projection.historyBaseIndex,
            toolOutputs: projection.toolOutputs,
            pendingApprovals: projection.pendingApprovals,
            toolStartedAt: projection.toolStartedAt,
          })
        : [],
    [projection, running]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: items 是触发信号
  useEffect(() => {
    if (timelineRef.current?.isAtBottom()) timelineRef.current.pinToBottom();
  }, [items]);
  const loadOlder = useMemo(
    () => () => void useBotsStore.getState().loadOlderSession(conversationId),
    [conversationId]
  );
  const highlight = useMessageFocus({
    focus,
    timelineRef,
    items,
    baseIndex: projection?.historyBaseIndex ?? 0,
    hasMessages: (projection?.messages.length ?? 0) > 0,
    loading: historyLoading,
    loadOlder,
    onDone: onFocusDone,
  });

  const { name, color, image } = speaker;
  const host = useMemo(
    () => ({
      sessionId: conversationId,
      canRewind: Boolean(controls),
      canRetry: Boolean(controls),
      canFork: false,
      speaker: { name, color, image },
      turnFooter,
      ...(controls ? { botControls: controls } : {}),
    }),
    [conversationId, name, color, image, turnFooter, controls]
  );
  const hasOlder = (projection?.historyBaseIndex ?? 0) > 0;

  return (
    <ChatHostContext.Provider value={host}>
      <div className={cn('@container flex min-h-0 flex-1 flex-col', className)}>
        <MessageTimeline
          key={conversationId}
          ref={timelineRef}
          items={items}
          busy={running}
          loading={false}
          running={running}
          runStartedAt={projection?.runStartedAt}
          lastOutputAt={projection?.lastOutputAt}
          error={projection?.status === 'failed' ? projection.error : undefined}
          emptyTitle={emptyTitle}
          historyLoading={historyLoading}
          hasOlder={hasOlder}
          olderCursor={projection?.historyBaseIndex}
          onStartReached={
            hasOlder
              ? () => void useBotsStore.getState().loadOlderSession(conversationId)
              : undefined
          }
          searchQuery={highlight.searchQuery}
          activeHit={highlight.activeHit}
        />
        {projection?.retry && (
          <div className={CHAT_COL}>
            <RetryBar retry={projection.retry} />
          </div>
        )}
      </div>
    </ChatHostContext.Provider>
  );
}

interface LiveSessionDialogProps {
  /** null = 关闭 */
  conversationId: string | null;
  title: string;
  speaker: ChatSpeaker;
  /** 弹窗底部（该会话的审批 / 提问） */
  footer?: React.ReactNode;
  onClose: () => void;
}

/** 群里正在回复的成员：实时查看其群会话 */
export function LiveSessionDialog({
  conversationId,
  title,
  speaker,
  footer,
  onClose,
}: LiveSessionDialogProps) {
  return (
    <Dialog open={conversationId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[80vh] max-w-3xl flex-col">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {conversationId && (
          <LiveSessionTimeline
            className="border-t"
            conversationId={conversationId}
            speaker={speaker}
            emptyTitle={title}
          />
        )}
        {footer && <div className={CHAT_COL}>{footer}</div>}
      </DialogContent>
    </Dialog>
  );
}
