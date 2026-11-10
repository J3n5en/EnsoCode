import type { AgentSessionCustomEntry, ProjectedMessage } from '@shared/types/agent';
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useOpenChangesOnEdit } from '@/hooks/useOpenChangesOnEdit';
import { eventToBinding } from '@/lib/keybindings';
import { useSessionsStore } from '@/stores/sessions';
import { chatTimelineActivity } from '@/stores/sessions/messageCache';
import {
  buildTimeline,
  patchStreamingTimeline,
  type TimelineItem,
  terminalErrorText,
} from '@/stores/sessions/timeline';
import { ChatFindBar, consumePendingFindQuery, OPEN_CHAT_FIND_EVENT } from './ChatFindBar';
import { timelineSearchHits } from './chatSearch';
import { MarkdownLinkContext } from './Markdown';
import { MessageTimeline, type MessageTimelineHandle } from './MessageTimeline';

const EMPTY_MESSAGES: ProjectedMessage[] = [];
const EMPTY_CUSTOM: AgentSessionCustomEntry[] = [];

/**
 * 远程桌面（多为手机 WebKit）不虚拟化：Virtuoso 在 WebKit 上切换渲染范围时滚动位置会被钳位，
 * 表现为流式输出跟不到底、画面往上跳。手机版同样全量渲染，历史本就按尾窗分页。
 */
const REMOTE = typeof window !== 'undefined' && Boolean(window.electronAPI?.remote);

export function ChatSessionTimeline({
  conversationId,
  cwd,
  emptyTitle,
  onSuggestion,
  timelineRef,
}: {
  conversationId: string;
  cwd?: string;
  emptyTitle: string;
  onSuggestion?: (prompt: string) => void;
  timelineRef: RefObject<MessageTimelineHandle | null>;
}) {
  const projectId = useSessionsStore((state) => state.conversations[conversationId]?.projectId);
  const messages = useSessionsStore(
    (state) => state.conversations[conversationId]?.messages ?? EMPTY_MESSAGES
  );
  const customEntries = useSessionsStore(
    (state) => state.conversations[conversationId]?.customEntries ?? EMPTY_CUSTOM
  );
  const running = useSessionsStore(
    (state) => state.conversations[conversationId]?.status === 'running'
  );
  const compaction = useSessionsStore((state) => state.conversations[conversationId]?.compaction);
  const compactionNoticeAt = useSessionsStore(
    (state) => state.conversations[conversationId]?.compactionNoticeAt
  );
  const compactionTokensAfter = useSessionsStore(
    (state) => state.conversations[conversationId]?.occupancy?.compactionTokensAfter
  );
  const historyBaseIndex = useSessionsStore(
    (state) => state.conversations[conversationId]?.historyBaseIndex ?? 0
  );
  const toolOutputs = useSessionsStore((state) => state.conversations[conversationId]?.toolOutputs);
  const toolStartedAt = useSessionsStore(
    (state) => state.conversations[conversationId]?.toolStartedAt
  );
  const pendingApprovals = useSessionsStore(
    (state) => state.conversations[conversationId]?.pendingApprovals
  );
  const runStartedAt = useSessionsStore(
    (state) => state.conversations[conversationId]?.runStartedAt
  );
  const lastOutputAt = useSessionsStore(
    (state) => state.conversations[conversationId]?.lastOutputAt
  );
  const error = useSessionsStore((state) => state.conversations[conversationId]?.error);
  const started = useSessionsStore(
    (state) => state.conversations[conversationId]?.started === true
  );
  const sessionFile = useSessionsStore((state) => state.conversations[conversationId]?.sessionFile);
  const status = useSessionsStore((state) => state.conversations[conversationId]?.status);
  const spawning = useSessionsStore(
    (state) => state.conversations[conversationId]?.spawning === true
  );
  const historyLoadAttempted = useSessionsStore(
    (state) => state.conversations[conversationId]?.historyLoadAttempted
  );
  const historyLoading = useSessionsStore((state) =>
    Boolean(state.conversations[conversationId]?.historyLoading)
  );

  const cache = useRef<{ conversationId: string; items: TimelineItem[] }>({
    conversationId: '',
    items: [],
  });
  const timeline = useMemo(() => {
    if (cache.current.conversationId !== conversationId) {
      cache.current = { conversationId, items: [] };
    }
    const patched = patchStreamingTimeline(
      cache.current.items,
      messages,
      running,
      historyBaseIndex
    );
    const items =
      patched ??
      buildTimeline(messages, running, customEntries, cwd, {
        compaction,
        compactionNoticeAt,
        compactionTokensAfter,
        historyBaseIndex,
        toolOutputs,
        toolStartedAt,
        pendingApprovals,
      });
    cache.current.items = items;
    return items;
  }, [
    compaction,
    compactionNoticeAt,
    compactionTokensAfter,
    conversationId,
    cwd,
    customEntries,
    historyBaseIndex,
    messages,
    pendingApprovals,
    running,
    toolOutputs,
    toolStartedAt,
  ]);
  useOpenChangesOnEdit(timeline, conversationId);

  const timelineActivity = chatTimelineActivity({
    started,
    sessionFile,
    messages,
    spawning,
    status,
    historyLoadAttempted,
    historyLoading,
  });
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);
  const findHits = useMemo(
    () => (findOpen ? timelineSearchHits(timeline, findQuery) : []),
    [findOpen, findQuery, timeline]
  );

  useEffect(() => {
    const open = () => {
      const pending = consumePendingFindQuery();
      setFindOpen(true);
      if (pending) {
        setFindQuery(pending);
        setFindIndex(0);
      }
    };
    window.addEventListener(OPEN_CHAT_FIND_EVENT, open);
    return () => window.removeEventListener(OPEN_CHAT_FIND_EVENT, open);
  }, []);

  useEffect(() => {
    const pending = consumePendingFindQuery();
    setFindIndex(0);
    if (pending) {
      setFindQuery(pending);
      setFindOpen(true);
      return;
    }
    if (!conversationId) return;
    setFindQuery('');
    setFindOpen(false);
  }, [conversationId]);

  useEffect(() => {
    if (!findOpen || findHits.length === 0) return;
    const i = Math.min(findIndex, findHits.length - 1);
    timelineRef.current?.scrollToKey(findHits[i].key);
  }, [findOpen, findIndex, findHits, timelineRef]);

  const stepFind = useCallback(
    (dir: 1 | -1) => {
      if (findHits.length === 0) return;
      setFindIndex((i) => (i + dir + findHits.length) % findHits.length);
    },
    [findHits.length]
  );

  useEffect(() => {
    if (!findOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setFindOpen(false);
        return;
      }
      const pressed = eventToBinding(e);
      if (pressed === 'mod+g') {
        e.preventDefault();
        stepFind(1);
      } else if (pressed === 'mod+shift+g') {
        e.preventDefault();
        stepFind(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [findOpen, stepFind]);

  const markdownLinkContext = useMemo(
    () =>
      projectId
        ? {
            conversationId,
            projectId,
            ...(cwd ? { cwd } : {}),
          }
        : null,
    [conversationId, cwd, projectId]
  );

  /*
   * 全量渲染时（远程桌面）上滑分页的滚动锚定：iOS Safari 不支持 overflow-anchor，
   * 旧页插到顶部后内容整体下压。请求前记下 scrollHeight，旧页落地后用差值补偿。
   */
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const loadOlder = useCallback(() => {
    const el = timelineRef.current?.getScroller();
    anchorRef.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
    void useSessionsStore.getState().loadOlderHistory(conversationId);
  }, [conversationId, timelineRef]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: historyBaseIndex 变小 = 旧页已渲染，此时才补偿
  useLayoutEffect(() => {
    const el = timelineRef.current?.getScroller();
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    anchorRef.current = null;
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
  }, [historyBaseIndex]);

  return (
    <MarkdownLinkContext.Provider value={markdownLinkContext}>
      {findOpen && (
        <ChatFindBar
          query={findQuery}
          onQueryChange={(value) => {
            setFindQuery(value);
            setFindIndex(0);
          }}
          current={findHits.length === 0 ? 0 : Math.min(findIndex, findHits.length - 1) + 1}
          total={findHits.length}
          onPrev={() => stepFind(-1)}
          onNext={() => stepFind(1)}
          onClose={() => {
            setFindOpen(false);
            setFindQuery('');
          }}
        />
      )}
      <MessageTimeline
        key={conversationId}
        virtualize={!REMOTE}
        ref={timelineRef}
        items={timeline}
        busy={timelineActivity !== null}
        loading={timelineActivity === 'loading'}
        running={running}
        runStartedAt={runStartedAt}
        lastOutputAt={lastOutputAt}
        error={terminalErrorText(messages, error)}
        emptyTitle={emptyTitle}
        onSuggestion={onSuggestion}
        onRetryResume={
          !started && sessionFile && status === 'failed'
            ? () => void useSessionsStore.getState().resumeConversation(conversationId)
            : undefined
        }
        historyLoading={historyLoading}
        hasOlder={historyBaseIndex > 0}
        olderCursor={historyBaseIndex}
        onStartReached={historyBaseIndex > 0 ? loadOlder : undefined}
        searchQuery={findOpen ? findQuery : ''}
        activeHit={findOpen ? (findHits[findIndex] ?? null) : null}
      />
    </MarkdownLinkContext.Provider>
  );
}
