import { secretaryAvatarUrl } from '@shared/localImage';
import type { AgentSessionCustomEntry, ProjectedMessage, TodoItem } from '@shared/types/agent';
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
import { useSecretaryStore } from '@/stores/secretary';
import { useSessionsStore } from '@/stores/sessions';
import { chatTimelineActivity } from '@/stores/sessions/messageCache';
import {
  buildTimeline,
  patchStreamingTimeline,
  type TimelineItem,
  terminalErrorText,
} from '@/stores/sessions/timeline';
import { useSettingsStore } from '@/stores/settings';
import { ChatFindBar, consumePendingFindQuery, OPEN_CHAT_FIND_EVENT } from './ChatFindBar';
import { timelineSearchHits } from './chatSearch';
import { emptyStateTitle } from './emptyState';
import { markFileLinksStale } from './fileLinkResolver';
import { MarkdownLinkContext } from './Markdown';
import { MessageTimeline, type MessageTimelineHandle } from './MessageTimeline';
import { QueuedSessionCard } from './QueuedSessionCard';

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
  peek = false,
  readOnly = false,
  quotable = false,
}: {
  conversationId: string;
  cwd?: string;
  emptyTitle: string;
  onSuggestion?: (prompt: string) => void;
  timelineRef: RefObject<MessageTimelineHandle | null>;
  /** 弹窗旁观：不接全局查找、不因新编辑自动开 Changes */
  peek?: boolean;
  /** 只读（已归档）：不给会拉起 worker 或要快照的重试 */
  readOnly?: boolean;
  /** 选中文字可引用到主输入框 */
  quotable?: boolean;
}) {
  const projectId = useSessionsStore((state) => state.conversations[conversationId]?.projectId);
  const secretarySession = useSettingsStore((state) =>
    state.projects.some((project) => project.id === projectId && project.kind === 'secretary')
  );
  const secretaryId = useSecretaryStore((state) =>
    secretarySession
      ? (state.secretaries.find((entry) => entry.projectId === projectId)?.id ?? null)
      : null
  );
  // selector 只取 store 里的原引用：每次返回新对象会让 useSyncExternalStore 无限重渲染
  const secretaryProfile = useSecretaryStore((state) =>
    secretaryId
      ? ((state.states[secretaryId] ?? (state.focusedId === secretaryId ? state.secretary : null))
          ?.profile ?? null)
      : null
  );
  // 档案没到就用清单里的名字：别让空态标题回退到隐藏项目名
  const secretarySummaryName = useSecretaryStore((state) =>
    secretaryId ? state.secretaries.find((entry) => entry.id === secretaryId)?.name : undefined
  );
  const secretaryOwnerName = secretaryProfile?.name.trim() || secretarySummaryName?.trim() || null;
  const secretaryFace = useMemo(() => {
    if (!secretaryId || !secretaryProfile) return null;
    const imageVersion = secretaryProfile.avatar.imageVersion;
    return {
      name: secretaryProfile.name.trim() || '·',
      color: secretaryProfile.avatar.color,
      ...(imageVersion
        ? {
            image: secretaryAvatarUrl(imageVersion, secretaryProfile.avatar.imageHash, secretaryId),
          }
        : {}),
    };
  }, [secretaryId, secretaryProfile]);
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
  const toolEnded = useSessionsStore((state) => state.conversations[conversationId]?.toolEnded);
  const toolTodos = useSessionsStore((state) => state.conversations[conversationId]?.toolTodos);
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
  const syncStalled = useSessionsStore(
    (state) => state.conversations[conversationId]?.syncStalled === true
  );
  const queuedStart = useSessionsStore((state) => state.conversations[conversationId]?.queuedStart);
  /** 应用退出打断的一轮：正文里被吞掉的模型错误不再渲染，底部钉系统提示 */
  const interrupted = useSessionsStore((state) => state.conversations[conversationId]?.interrupted);

  const cache = useRef<{
    conversationId: string;
    items: TimelineItem[];
    toolEnded?: Record<string, 'ok' | 'error'>;
    toolTodos?: Record<string, TodoItem[]>;
  }>({
    conversationId: '',
    items: [],
  });
  const timeline = useMemo(() => {
    if (cache.current.conversationId !== conversationId) {
      cache.current = { conversationId, items: [] };
    }
    // 正文还在流时工具收口了（agy 的工具与正文同在一条流式 assistant 里）：只补正文会漏掉卡片转完成
    const patched =
      cache.current.toolEnded === toolEnded && cache.current.toolTodos === toolTodos
        ? patchStreamingTimeline(cache.current.items, messages, running, historyBaseIndex)
        : null;
    const items =
      patched ??
      buildTimeline(messages, running, customEntries, cwd, {
        compaction,
        compactionNoticeAt,
        compactionTokensAfter,
        historyBaseIndex,
        toolOutputs,
        toolEnded,
        toolTodos,
        toolStartedAt,
        pendingApprovals,
        secretarySession,
        interrupted,
      });
    cache.current.items = items;
    cache.current.toolEnded = toolEnded;
    cache.current.toolTodos = toolTodos;
    return items;
  }, [
    compaction,
    compactionNoticeAt,
    compactionTokensAfter,
    conversationId,
    cwd,
    customEntries,
    historyBaseIndex,
    interrupted,
    messages,
    pendingApprovals,
    running,
    secretarySession,
    toolEnded,
    toolOutputs,
    toolStartedAt,
    toolTodos,
  ]);
  useOpenChangesOnEdit(timeline, peek ? undefined : conversationId);

  const timelineActivity = chatTimelineActivity({
    started,
    sessionFile,
    messages,
    spawning,
    status,
    historyLoadAttempted,
    historyLoading,
    syncStalled,
  });
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);
  const findHits = useMemo(
    () => (findOpen ? timelineSearchHits(timeline, findQuery) : []),
    [findOpen, findQuery, timeline]
  );

  useEffect(() => {
    if (peek) return;
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
  }, [peek]);

  useEffect(() => {
    if (peek) return;
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
  }, [conversationId, peek]);

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

  const markdownLinkContext = useMemo(() => {
    // 进入（切换到）会话：能打开的链接缓存在子组件挂载时后台复查
    markFileLinksStale();
    return projectId
      ? {
          conversationId,
          projectId,
          ...(cwd ? { cwd } : {}),
        }
      : null;
  }, [conversationId, cwd, projectId]);

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
      {queuedStart ? (
        <QueuedSessionCard conversationId={conversationId} />
      ) : (
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
          emptyTitle={emptyStateTitle({
            secretarySession,
            ownerName: secretaryOwnerName,
            fallback: emptyTitle,
          })}
          onSuggestion={onSuggestion}
          {...(secretarySession ? { emptyVariant: 'secretary' as const } : {})}
          onRetryResume={
            !readOnly && !started && sessionFile && status === 'failed'
              ? () => void useSessionsStore.getState().resumeConversation(conversationId)
              : undefined
          }
          onRetrySync={
            !readOnly && syncStalled && !running
              ? () => useSessionsStore.getState().retrySessionSync(conversationId)
              : undefined
          }
          historyLoading={historyLoading}
          hasOlder={historyBaseIndex > 0}
          olderCursor={historyBaseIndex}
          onStartReached={historyBaseIndex > 0 ? loadOlder : undefined}
          searchQuery={findOpen ? findQuery : ''}
          quotable={quotable}
          activeHit={findOpen ? (findHits[findIndex] ?? null) : null}
          secretarySession={secretarySession}
          conversationId={conversationId}
          {...(secretaryFace ? { secretaryFace } : {})}
        />
      )}
    </MarkdownLinkContext.Provider>
  );
}
