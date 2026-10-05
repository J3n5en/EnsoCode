import type { ProjectedMessage } from '@shared/types/agent';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatHostContext, type ChatSpeaker } from '@/components/chat/chatHost';
import { MessageTimeline, type MessageTimelineHandle } from '@/components/chat/MessageTimeline';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/i18n';
import { buildTimeline } from '@/stores/sessions/timeline';
import { type MessageFocus, useMessageFocus } from './LiveSessionTimeline';

interface SessionHistoryDialogProps {
  /** null = 关闭 */
  conversationId: string | null;
  title: string;
  /** 回复头显示的成员 */
  speaker?: ChatSpeaker;
  /** 搜索跳转到该会话的某条消息 */
  focus?: MessageFocus;
  /** 一轮最终回复下方的附加内容（私聊产物卡片） */
  turnFooter?: (messageIndex: number) => ReactNode;
  onClose: () => void;
}

/** 成员旧会话 / 群消息所在会话的只读查看 */
export function SessionHistoryDialog({
  conversationId,
  title,
  speaker,
  focus,
  turnFooter,
  onClose,
}: SessionHistoryDialogProps) {
  const { t } = useI18n();
  const [page, setPage] = useState<{ messages: ProjectedMessage[]; baseIndex: number } | null>(
    null
  );
  const [error, setError] = useState<string | undefined>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingRef = useRef(false);
  const timelineRef = useRef<MessageTimelineHandle>(null);

  useEffect(() => {
    setPage(null);
    setError(undefined);
    if (!conversationId) return;
    let alive = true;
    void window.electronAPI.bots.sessionHistory({ conversationId }).then((result) => {
      if (!alive) return;
      if (result.ok) setPage({ messages: result.messages, baseIndex: result.baseIndex });
      else
        setError(
          result.code === 'not-found' ? t('This conversation has no history yet.') : result.error
        );
    });
    return () => {
      alive = false;
    };
  }, [conversationId, t]);

  const loadOlder = useCallback(async () => {
    if (!conversationId || !page || page.baseIndex <= 0 || loadingRef.current) return;
    loadingRef.current = true;
    setLoadingOlder(true);
    try {
      const result = await window.electronAPI.bots.sessionHistory({
        conversationId,
        beforeIndex: page.baseIndex,
      });
      if (result.ok && result.baseIndex + result.messages.length === page.baseIndex) {
        setPage({ messages: [...result.messages, ...page.messages], baseIndex: result.baseIndex });
      }
    } finally {
      loadingRef.current = false;
      setLoadingOlder(false);
    }
  }, [conversationId, page]);

  const items = useMemo(
    () =>
      page
        ? buildTimeline(page.messages, false, [], undefined, { historyBaseIndex: page.baseIndex })
        : [],
    [page]
  );
  const loadOlderPage = useCallback(() => void loadOlder(), [loadOlder]);
  const highlight = useMessageFocus({
    focus,
    timelineRef,
    items,
    baseIndex: page?.baseIndex ?? 0,
    hasMessages: Boolean(page?.messages.length),
    loading: loadingOlder || page === null,
    loadOlder: loadOlderPage,
  });
  const speakerName = speaker?.name;
  const speakerColor = speaker?.color;
  const speakerImage = speaker?.image;
  const host = useMemo(
    () => ({
      sessionId: conversationId,
      canRewind: false,
      canRetry: false,
      botSession: true,
      speaker:
        speakerName && speakerColor
          ? { name: speakerName, color: speakerColor, image: speakerImage }
          : undefined,
      turnFooter,
    }),
    [conversationId, speakerName, speakerColor, speakerImage, turnFooter]
  );

  return (
    <Dialog open={conversationId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[80vh] max-w-3xl flex-col">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <ChatHostContext.Provider value={host}>
          <div className="@container flex min-h-0 flex-1 flex-col border-t">
            {error ? (
              <p className="p-6 text-muted-foreground text-sm">{error}</p>
            ) : (
              <MessageTimeline
                ref={timelineRef}
                items={items}
                busy={page === null}
                loading={page === null}
                running={false}
                emptyTitle={title}
                hasOlder={Boolean(page && page.baseIndex > 0)}
                historyLoading={loadingOlder}
                olderCursor={page?.baseIndex}
                onStartReached={page && page.baseIndex > 0 ? () => void loadOlder() : undefined}
                searchQuery={highlight.searchQuery}
                activeHit={highlight.activeHit}
              />
            )}
          </div>
        </ChatHostContext.Provider>
      </DialogContent>
    </Dialog>
  );
}
