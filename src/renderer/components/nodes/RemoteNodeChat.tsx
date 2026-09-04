import type { CatalogEntry, ProviderEntry } from '@enso/pair';
import type { GuestSessionView } from '@shared/pair/guestProjection';
import { type AttachedImage, THINKING_LEVELS, type ThinkingLevel } from '@shared/types/agent';
import type { ModelProvider } from '@shared/types/llm';
import type { RemoteNodeStatus } from '@shared/types/nodes';
import { Bot, Monitor } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { ApprovalBar } from '@/components/chat/ApprovalBar';
import { AskBar } from '@/components/chat/AskBar';
import { Composer } from '@/components/chat/Composer';
import { ChatHostContext } from '@/components/chat/chatHost';
import {
  CHAT_COL,
  MessageTimeline,
  type MessageTimelineHandle,
} from '@/components/chat/MessageTimeline';
import { ModelPicker } from '@/components/chat/ModelPicker';
import { RetryBar } from '@/components/chat/RetryBar';
import { TaskBar } from '@/components/chat/TaskBar';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { buildTimeline } from '@/stores/sessions/timeline';
import { NodeDot } from './NodeSwitcher';

interface RemoteNodeChatProps {
  node: RemoteNodeStatus;
  sessionId: string | null;
  entry: CatalogEntry | undefined;
  /** 同父会话下的 coworker 子会话（有则显示 tab 组，与手机同语义） */
  tabGroup?: { parent: CatalogEntry; children: CatalogEntry[] };
  view: GuestSessionView | null;
  syncing: boolean;
  providers: ProviderEntry[];
  hasOlder: boolean;
  onLoadOlder: () => void;
  onSelectTab: (id: string) => void;
  onSend: (text: string, images: AttachedImage[]) => void;
  onAbort: () => void;
  onApproval: (requestId: string, decision: 'allow' | 'allowSession' | 'deny') => void;
  onAsk: (requestId: string, answer: string) => void;
  onSetModel: (providerId: string, modelId: string) => void;
  onSetReasoning: (enabled: boolean) => void;
  onSetThinking: (level: ThinkingLevel) => void;
}

/** 对方剥密后下发的 provider 只有 id/name/models，补齐 ModelPicker 需要的形状（凭据字段留空，仅展示） */
function toModelProviders(entries: ProviderEntry[]): ModelProvider[] {
  return entries.map((p) => ({
    id: p.id,
    name: p.name,
    api: 'openai-completions',
    apiKey: '',
    baseUrl: '',
    enabled: true,
    models: p.models.map((m) => ({ id: m.id, ...(m.label ? { label: m.label } : {}) })),
  }));
}

/** pair 协议的档位含手机可选的 minimal/xhigh；桌面选择器只有四档，越界回落 medium */
function toDesktopLevel(level: string | undefined): ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(level ?? '')
    ? (level as ThinkingLevel)
    : 'medium';
}

/** 远程节点的聊天区：复用桌面时间线/审批/提问/输入框；宿主 context 关闭回退/重试 */
export function RemoteNodeChat(props: RemoteNodeChatProps) {
  const { t } = useI18n();
  const { node, sessionId, entry, view, syncing } = props;
  const timelineRef = useRef<MessageTimelineHandle>(null);
  const running = view?.status === 'running';

  const messages = useMemo(
    () =>
      view
        ? [...view.messages.entries()].sort((a, b) => a[0] - b[0]).map(([, message]) => message)
        : [],
    [view]
  );
  const timeline = useMemo(
    () => buildTimeline(messages, running, [], entry?.cwd),
    [messages, running, entry?.cwd]
  );
  // 流式输出按同一 index 覆盖，Virtuoso 的 followOutput 不触发；贴底时补一次单帧贴底
  // biome-ignore lint/correctness/useExhaustiveDependencies: timeline 是触发信号
  useEffect(() => {
    if (timelineRef.current?.isAtBottom()) timelineRef.current.pinToBottom();
  }, [timeline]);

  const host = useMemo(() => ({ sessionId, canRewind: false, canRetry: false }), [sessionId]);
  const providers = useMemo(() => toModelProviders(props.providers), [props.providers]);
  const configurable = entry && !entry.parentId;

  const banner = !node.hostOnline
    ? node.connected
      ? t('Remote desktop is offline')
      : t('Connecting…')
    : syncing && sessionId
      ? t('Syncing…')
      : null;

  return (
    <ChatHostContext.Provider value={host}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <header className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
          <Monitor className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-muted-foreground text-xs">{node.label}</span>
          <NodeDot node={node} />
          {entry && (
            <>
              <span className="text-muted-foreground/50">/</span>
              <span className="min-w-0 truncate text-sm">
                {entry.title || t('New conversation')}
              </span>
              {entry.projectName && (
                <span className="truncate font-mono text-muted-foreground text-xs">
                  {entry.projectName}
                </span>
              )}
            </>
          )}
          <div className="flex-1" />
          {banner && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              {banner}
            </span>
          )}
        </header>

        {props.tabGroup && (
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1">
            <TabPill
              active={sessionId === props.tabGroup.parent.id}
              label={props.tabGroup.parent.title || t('New conversation')}
              status={props.tabGroup.parent.status}
              onClick={() => props.onSelectTab(props.tabGroup!.parent.id)}
            />
            {props.tabGroup.children.map((child) => (
              <TabPill
                key={child.id}
                active={sessionId === child.id}
                icon={<Bot className="h-3 w-3 shrink-0" />}
                label={child.title || 'coworker'}
                status={child.status}
                onClick={() => props.onSelectTab(child.id)}
              />
            ))}
          </div>
        )}

        {sessionId === null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
            <p className="font-medium text-lg">{node.label}</p>
            <p className="text-muted-foreground text-sm">
              {node.hostOnline
                ? t('Select a conversation on the left, or create one')
                : (banner ?? '')}
            </p>
          </div>
        ) : (
          <MessageTimeline
            key={sessionId}
            ref={timelineRef}
            items={timeline}
            // view 为 null = 快照尚未到达，显示加载态而非空态
            busy={running || view === null}
            running={running}
            error={undefined}
            emptyTitle={entry?.projectName || node.label}
            onStartReached={props.hasOlder ? props.onLoadOlder : undefined}
          />
        )}

        {sessionId !== null && (
          <div className="@container pt-1">
            <div className={CHAT_COL}>
              {/* 自动重试横幅：只展示不可取消（协议无 abort-retry，整轮 abort 已够用） */}
              {view?.retry && <RetryBar retry={view.retry} />}
              <TaskBar
                key={sessionId}
                sessionId={sessionId}
                tasks={view?.tasks ?? []}
                subagents={view?.subagents ?? []}
              />
              <ApprovalBar approvals={view?.approvals ?? []} onRespond={props.onApproval} />
              <AskBar asks={view?.asks ?? []} onAnswer={props.onAsk} />
              <Composer
                commands={[]}
                running={running}
                busy={running}
                locked={(view?.approvals ?? []).length > 0}
                focusKey={`${node.nodeId}:${sessionId}`}
                toolbar={
                  configurable && entry ? (
                    <ModelPicker
                      providers={providers}
                      providerId={entry.providerId ?? ''}
                      modelId={entry.modelId ?? ''}
                      reasoningEnabled={entry.reasoningEnabled ?? false}
                      thinkingLevel={toDesktopLevel(entry.thinkingLevel)}
                      onSelect={props.onSetModel}
                      onReasoningChange={props.onSetReasoning}
                      onThinkingChange={props.onSetThinking}
                    />
                  ) : (
                    <span className="text-[11px] text-muted-foreground">
                      {entry?.modelId ?? ''}
                    </span>
                  )
                }
                onSend={(payload) => {
                  // 远程节点不支持 @ 派发与 slash：只取文本与图片
                  if (!payload.text.trim() && payload.images.length === 0) return false;
                  props.onSend(payload.text, payload.images);
                  timelineRef.current?.scrollToBottom();
                  return true;
                }}
                onAbort={props.onAbort}
              />
            </div>
          </div>
        )}
      </div>
    </ChatHostContext.Provider>
  );
}

function TabPill({
  active,
  icon,
  label,
  status,
  onClick,
}: {
  active: boolean;
  icon?: React.ReactNode;
  label: string;
  status: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50'
      )}
    >
      {icon}
      <span className="max-w-32 truncate">{label}</span>
      <span
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          status === 'running'
            ? 'animate-pulse bg-blue-500'
            : status === 'failed'
              ? 'bg-destructive'
              : 'bg-muted-foreground/30'
        )}
      />
    </button>
  );
}
