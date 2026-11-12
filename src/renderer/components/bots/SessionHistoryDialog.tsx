import type { ParentHistoryTailResult, ProjectedMessage } from '@shared/types/agent';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatHostContext, type ChatSpeaker } from '@/components/chat/chatHost';
import { EditDiffSourceContext } from '@/components/chat/editDiffSource';
import { MessageTimeline, type MessageTimelineHandle } from '@/components/chat/MessageTimeline';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/i18n';
import { buildTimeline } from '@/stores/sessions/timeline';
import { useBotFileLink } from './botFileLink';
import { type MessageFocus, useMessageFocus, useRunDividers } from './LiveSessionTimeline';

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
  /** 缺省走 bots.sessionHistory。子代理记录改走 agent.readChildRun */
  read?: (beforeIndex?: number) => Promise<ParentHistoryTailResult>;
  /** 缺省 true。子代理查看不是 bot 会话，调用方传 false */
  botSession?: boolean;
  onClose: () => void;
}

/** 成员旧会话 / 群消息所在会话的只读查看 */
export function SessionHistoryDialog({
  conversationId,
  title,
  speaker,
  focus,
  turnFooter,
  read,
  botSession = true,
  onClose,
}: SessionHistoryDialogProps) {
  const { t } = useI18n();
  const [page, setPage] = useState<{ messages: ProjectedMessage[]; baseIndex: number } | null>(
    null
  );
  const [historyProjectId, setHistoryProjectId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingRef = useRef(false);
  const timelineRef = useRef<MessageTimelineHandle>(null);

  const loadPage = useCallback(
    (beforeIndex?: number) => {
      if (read) return read(beforeIndex);
      return window.electronAPI.bots.sessionHistory({
        conversationId: conversationId ?? '',
        ...(beforeIndex !== undefined ? { beforeIndex } : {}),
      });
    },
    [conversationId, read]
  );

  useEffect(() => {
    setPage(null);
    setError(undefined);
    setHistoryProjectId(undefined);
    if (!conversationId) return;
    let alive = true;
    void loadPage().then((result) => {
      if (!alive) return;
      if (result.ok) {
        setPage({ messages: result.messages, baseIndex: result.baseIndex });
        setHistoryProjectId(result.projectId);
      } else
        setError(
          result.code === 'not-found' ? t('This conversation has no history yet.') : result.error
        );
    });
    return () => {
      alive = false;
    };
  }, [conversationId, loadPage, t]);

  const loadOlder = useCallback(async () => {
    if (!conversationId || !page || page.baseIndex <= 0 || loadingRef.current) return;
    loadingRef.current = true;
    setLoadingOlder(true);
    try {
      const result = await loadPage(page.baseIndex);
      if (result.ok && result.baseIndex + result.messages.length === page.baseIndex) {
        setPage({ messages: [...result.messages, ...page.messages], baseIndex: result.baseIndex });
      }
    } finally {
      loadingRef.current = false;
      setLoadingOlder(false);
    }
  }, [conversationId, loadPage, page]);

  const runDividers = useRunDividers(conversationId);
  const items = useMemo(
    () =>
      page
        ? buildTimeline(page.messages, false, [], undefined, {
            historyBaseIndex: page.baseIndex,
            runDividers,
          })
        : [],
    [page, runDividers]
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
      botSession,
      speaker:
        speakerName && speakerColor
          ? { name: speakerName, color: speakerColor, image: speakerImage }
          : undefined,
      turnFooter,
    }),
    [botSession, conversationId, speakerName, speakerColor, speakerImage, turnFooter]
  );
  const link = useBotFileLink(botSession ? conversationId : null, historyProjectId);

  return (
    <EditDiffSourceContext.Provider value={link}>
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
    </EditDiffSourceContext.Provider>
  );
}
