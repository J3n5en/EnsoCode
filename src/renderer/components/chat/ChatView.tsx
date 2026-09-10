import { ENSO_AGENT_TYPE_KEY } from '@shared/builtinAgents';
import { conversationDotTone, conversationHasRunningChild } from '@shared/conversationDotTone';
import { resolveChatModel, scopedDefaultModels } from '@shared/defaultModel';
import type { AgentTypeMentionCandidate } from '@shared/types/mentions';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentChildOauthHost } from '@/components/agent/AgentChildOauthHost';
import { addToast } from '@/components/ui/toast';
import { toChatMentionCandidates } from '@/hooks/useMentionSearch';
import { useOpenChangesOnEdit } from '@/hooks/useOpenChangesOnEdit';
import { useI18n } from '@/i18n';
import { eventToBinding } from '@/lib/keybindings';
import {
  oauthCredentialContext,
  usableProvidersForOauthSnapshot,
  useOauthCredentialStore,
} from '@/stores/oauthCredentials';

import { useSessionsStore } from '@/stores/sessions';
import { chatSurfaceBusy, chatTimelineBusy } from '@/stores/sessions/messageCache';
import { selectChatCandidateConversations } from '@/stores/sessions/sidebarDirectory';
import { buildTimeline, terminalErrorText } from '@/stores/sessions/timeline';
import { useSettingsStore } from '@/stores/settings';
import { ApprovalBar } from './ApprovalBar';
import { ApprovalModePicker } from './ApprovalModePicker';
import { AskBar } from './AskBar';
import { ChatFindBar, consumePendingFindQuery, OPEN_CHAT_FIND_EVENT } from './ChatFindBar';
import { Composer } from './Composer';
import { ConversationStatusIndicator } from './ConversationStatusIndicator';
import { CoworkerTabs } from './CoworkerTabs';
import { timelineSearchHits } from './chatSearch';
import { routeComposerPayload } from './composerRouting';
import { GoalBar } from './GoalBar';
import { MessageQueue } from './MessageQueue';
import { CHAT_COL, MessageTimeline, type MessageTimelineHandle } from './MessageTimeline';
import { ModelPicker } from './ModelPicker';
import { PresetPicker } from './PresetPicker';
import { RetryBar } from './RetryBar';
import { StatsLine } from './StatsLine';
import { TaskBar } from './TaskBar';
import { WorktreeMissingDialog } from './WorktreeMissingDialog';
import { WorktreePicker } from './WorktreePicker';

export function ChatView() {
  const { t } = useI18n();
  const providers = useSettingsStore((state) => state.providers);
  const defaultModel = useSettingsStore((state) => state.defaultModel);
  const projects = useSettingsStore((state) => state.projects);
  const projectGroups = useSettingsStore((state) => state.projectGroups);
  const parent = useSessionsStore((state) =>
    state.activeId ? state.conversations[state.activeId] : null
  );
  // 当前 tab 的会话投影(主会话或某个 coworker);coworker 被删后回落主会话
  const conversation = useSessionsStore((state) => {
    const active = state.activeId ? state.conversations[state.activeId] : null;
    if (!active) return null;
    return active.activeTabId ? (state.conversations[active.activeTabId] ?? active) : active;
  });

  const oauthSnapshot = useOauthCredentialStore((state) => state.snapshot);
  const candidateConversations = useSessionsStore((state) =>
    selectChatCandidateConversations(state.conversations)
  );
  const parentHasRunningChild = useSessionsStore((state) => {
    const active = state.activeId ? state.conversations[state.activeId] : undefined;
    return conversationHasRunningChild(active, state.conversations);
  });
  const parentId = parent?.id;
  const parentProjectId = parent?.projectId;
  const chatCandidates = useMemo(
    () =>
      parentId !== undefined && parentProjectId !== undefined
        ? toChatMentionCandidates(candidateConversations, parentProjectId, parentId)
        : [],
    [candidateConversations, parentId, parentProjectId]
  );
  const enabledProviders = useMemo(
    () => usableProvidersForOauthSnapshot(providers, oauthSnapshot),
    [providers, oauthSnapshot]
  );
  // 会话显式选择优先；新草稿沿 项目默认 → 分组默认 → 全局默认，不再退化到 providers 第一项。
  const conversationProject = useMemo(
    () => projects.find((entry) => entry.id === conversation?.projectId),
    [conversation?.projectId, projects]
  );
  const parentProject = useMemo(
    () => projects.find((entry) => entry.id === parent?.projectId),
    [parent?.projectId, projects]
  );
  const conversationDefaults = useMemo(
    () => scopedDefaultModels(conversationProject, projectGroups),
    [conversationProject, projectGroups]
  );
  const parentDefaults = useMemo(
    () => scopedDefaultModels(parentProject, projectGroups),
    [parentProject, projectGroups]
  );
  const modelResolution = useMemo(
    () =>
      resolveChatModel({
        defaultModel,
        ...conversationDefaults,
        lastProviderId: conversation?.lastProviderId,
        lastModelId: conversation?.lastModelId,
        providers,
        credentials: oauthCredentialContext(oauthSnapshot),
      }),
    [
      conversation?.lastModelId,
      conversation?.lastProviderId,
      conversationDefaults,
      defaultModel,
      oauthSnapshot,
      providers,
    ]
  );
  const parentModelResolution = useMemo(
    () =>
      resolveChatModel({
        defaultModel,
        ...parentDefaults,
        lastProviderId: parent?.lastProviderId,
        lastModelId: parent?.lastModelId,
        providers,
        credentials: oauthCredentialContext(oauthSnapshot),
      }),
    [
      defaultModel,
      oauthSnapshot,
      parent?.lastModelId,
      parent?.lastProviderId,
      parentDefaults,
      providers,
    ]
  );
  const parentSelectedModel =
    parentModelResolution.source === 'none'
      ? null
      : {
          providerId: parentModelResolution.providerId,
          modelId: parentModelResolution.modelId,
        };
  const provider =
    modelResolution.source === 'none'
      ? undefined
      : enabledProviders.find((entry) => entry.id === modelResolution.providerId);
  const effectiveModelId = modelResolution.source === 'none' ? '' : modelResolution.modelId;
  const modelBlockMessage =
    modelResolution.source !== 'none'
      ? null
      : modelResolution.reason === 'oauth-credentials-error'
        ? t(
            'Subscription credentials could not be loaded. Choose an API-key model or retry the credential refresh.'
          )
        : modelResolution.reason === 'oauth-credentials-loading' ||
            modelResolution.reason === 'oauth-credentials-unloaded'
          ? t('Subscription credentials are loading. Choose an API-key model or wait, then retry.')
          : enabledProviders.length > 0
            ? t(
                'Choose a model for this conversation or set a project, group, or global default before sending.'
              )
            : t(
                'No usable model is available. Configure provider credentials and enable a model first.'
              );

  const project = projects.find((p) => p.id === conversation?.projectId);
  const skills = useSettingsStore((state) => state.skills);
  const loadLocalSkills = useSettingsStore((state) => state.loadLocalSkills);
  const [projectSkills, setProjectSkills] = useState<{ name: string; description: string }[]>([]);

  useEffect(() => {
    if (!project?.path || !loadLocalSkills) {
      setProjectSkills([]);
      return;
    }
    let cancelled = false;
    window.electronAPI.assets
      .listProjectSkills(project.path)
      .then((listed) => {
        if (!cancelled) setProjectSkills(listed);
      })
      .catch(() => {
        if (!cancelled) setProjectSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project?.path, loadLocalSkills]);

  const slashCommands = useMemo(() => {
    if (!conversation) return [];
    const goal = {
      name: '/goal',
      description: t('Set a session goal (/goal <objective> · pause · resume · clear)'),
    };
    const compact = {
      name: '/compact',
      description: t('Compact the context now (/compact [summary focus])'),
    };
    const fromSettings = skills
      .filter((skill) => skill.enabled !== false)
      .map((skill) => ({
        name: `/skill:${skill.name}`,
        description: skill.description,
      }));
    const fromProject = projectSkills.map((skill) => ({
      name: `/skill:${skill.name}`,
      description: skill.description,
    }));
    const seen = new Set([
      goal.name,
      compact.name,
      ...fromSettings.map((command) => command.name),
      ...fromProject.map((command) => command.name),
    ]);
    return [
      goal,
      compact,
      ...fromSettings,
      ...fromProject,
      ...conversation.commands.filter((command) => !seen.has(command.name)),
    ];
  }, [t, skills, projectSkills, conversation]);

  const timelineRef = useRef<MessageTimelineHandle>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);

  const running = conversation?.status === 'running';
  const busy = conversation !== null && chatSurfaceBusy(conversation);
  const timelineBusy = conversation !== null && chatTimelineBusy(conversation);
  const toolCwd = parent?.worktree?.path ?? project?.path;
  const timeline = useMemo(
    () =>
      buildTimeline(
        conversation?.messages ?? [],
        running,
        conversation?.customEntries ?? [],
        toolCwd,
        {
          compaction: conversation?.compaction,
          compactionNoticeAt: conversation?.compactionNoticeAt,
          historyBaseIndex: conversation?.historyBaseIndex,
          toolOutputs: conversation?.toolOutputs,
          toolStartedAt: conversation?.toolStartedAt,
          pendingApprovals: conversation?.pendingApprovals,
        }
      ),
    [
      conversation?.compaction,
      conversation?.compactionNoticeAt,
      conversation?.historyBaseIndex,
      conversation?.toolOutputs,
      conversation?.toolStartedAt,
      conversation?.pendingApprovals,
      conversation?.customEntries,
      conversation?.messages,
      running,
      toolCwd,
    ]
  );
  useOpenChangesOnEdit(timeline, conversation?.id);
  const findHits = useMemo(
    () => (findOpen ? timelineSearchHits(timeline, findQuery) : []),
    [findOpen, findQuery, timeline]
  );
  const capabilityApprovals = useMemo(
    () =>
      (conversation?.pendingCapabilityAsks ?? []).map((request) => ({
        requestId: request.requestId,
        tool: request.capabilityId,
        kind: 'mcp' as const,
        summary: request.summary,
      })),
    [conversation?.pendingCapabilityAsks]
  );

  const activateParent = useCallback(() => {
    if (
      parent &&
      !parent.started &&
      parent.sessionFile &&
      !parent.worktreeMissing &&
      parent.status !== 'failed'
    ) {
      void useSessionsStore.getState().resumeConversation(parent.id);
    }
  }, [parent]);

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

  const conversationId = conversation?.id;
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
  }, [findOpen, findIndex, findHits]);

  // 压缩失败（如会话太小无可压）必须给反馈：不然点了按钮/发了 /compact 一点动静都没有
  useEffect(() => {
    const error = conversation?.compactionError;
    if (!error || !conversation) return;
    addToast({ type: 'error', title: t('Compaction failed'), description: error });
    useSessionsStore.getState().clearCompactionError(conversation.id);
  }, [conversation, t]);

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

  if (!conversation) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-1 bg-background text-center">
        <p className="text-lg font-medium">EnsoCode</p>
        <p className="text-sm text-muted-foreground">
          {t('Create or select a project to start a conversation')}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {parent && <WorktreeMissingDialog conversationId={parent.id} />}
      {parent && (
        <CoworkerTabs
          parent={parent}
          displayedId={conversation.id}
          trailing={
            <div className="flex min-w-0 shrink-0 items-center gap-1.5 pl-1.5">
              {project && (
                <span
                  className="truncate font-mono text-xs text-muted-foreground"
                  title={parent?.worktree ? parent.worktree.path : project.path}
                >
                  {project.name}
                  {parent?.worktree ? ` · ${parent.worktree.branch}` : ''}
                </span>
              )}
              <StatusDot
                status={conversation.spawning ? 'running' : conversation.status}
                pendingAskCount={(conversation.pendingAsks ?? []).length}
                hasRunningChild={conversation.id === parent.id && parentHasRunningChild}
              />
            </div>
          }
        />
      )}

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
      {/* key 换会话强制重挂：Virtuoso 的 initialTopMostItemIndex 只在挂载时生效，天然实现切会话回底 */}
      <MessageTimeline
        key={conversation.id}
        ref={timelineRef}
        items={timeline}
        busy={timelineBusy}
        running={running}
        runStartedAt={conversation.runStartedAt}
        lastOutputAt={conversation.lastOutputAt}
        error={terminalErrorText(conversation.messages, conversation.error)}
        emptyTitle={project?.name ?? 'EnsoCode'}
        onRetryResume={
          !conversation.started && conversation.sessionFile && conversation.status === 'failed'
            ? () => void useSessionsStore.getState().resumeConversation(conversation.id)
            : undefined
        }
        firstItemIndex={conversation.historyBaseIndex ?? 0}
        historyLoading={Boolean(conversation.historyLoading)}
        hasOlder={(conversation.historyBaseIndex ?? 0) > 0}
        onStartReached={
          (conversation.historyBaseIndex ?? 0) > 0
            ? () => void useSessionsStore.getState().loadOlderHistory(conversation.id)
            : undefined
        }
        searchQuery={findOpen ? findQuery : ''}
        activeHit={findOpen ? (findHits[findIndex] ?? null) : null}
      />

      <div className="@container pt-1">
        <div className={CHAT_COL}>
          {conversation.retry && (
            <RetryBar
              retry={conversation.retry}
              onCancel={() => void window.electronAPI.agent.abortRetry(conversation.id)}
            />
          )}
          <TaskBar
            key={conversation.id}
            sessionId={conversation.id}
            tasks={conversation.backgroundTasks ?? []}
            subagents={conversation.subagents ?? []}
          />
          <ApprovalBar
            key={capabilityApprovals[0]?.requestId ?? 'no-capability-approval'}
            approvals={capabilityApprovals}
            allowSession={false}
            onRespond={(requestId, decision) => {
              if (decision === 'allowSession') return;
              void useSessionsStore
                .getState()
                .respondCapabilityAsk(conversation.id, requestId, decision);
            }}
          />
          <ApprovalBar
            approvals={conversation.pendingApprovals ?? []}
            allowSession={conversation.child?.lockedProfileId === undefined}
            onRespond={(requestId, decision) =>
              void window.electronAPI.agent.respondApproval(conversation.id, requestId, decision)
            }
          />
          <AskBar
            asks={conversation.pendingAsks ?? []}
            onAnswer={(requestId, answer) =>
              void window.electronAPI.agent.respondAsk(conversation.id, requestId, answer)
            }
          />
          {conversation.activeOauthAsk && (
            <AgentChildOauthHost
              key={conversation.activeOauthAsk.requestId}
              request={conversation.activeOauthAsk}
              conversationId={conversation.id}
            />
          )}
          <MessageQueue
            conversationId={conversation.id}
            queued={conversation.queuedMessages ?? []}
          />
          {conversation.goal && (
            <GoalBar conversationId={conversation.id} goal={conversation.goal} />
          )}
          {!conversation.parentId && modelBlockMessage && (
            <div
              role="status"
              className="rounded-md border border-dashed px-3 py-2 text-muted-foreground text-xs"
            >
              {modelBlockMessage}
            </div>
          )}
          <Composer
            cwd={project?.path}
            chatCandidates={chatCandidates}
            commands={slashCommands}
            running={running}
            busy={busy}
            locked={
              (conversation.pendingApprovals ?? []).length > 0 || capabilityApprovals.length > 0
            }
            focusKey={conversation.id}
            injectedDraft={conversation.draftText}
            onDraftConsumed={() => useSessionsStore.getState().clearDraft(conversation.id)}
            initialRecipient={
              conversation.prefillAgentTypeKey === ENSO_AGENT_TYPE_KEY
                ? ENSO_PREFILL_CANDIDATE
                : undefined
            }
            onInitialRecipientConsumed={() =>
              useSessionsStore.getState().clearAgentPrefill(conversation.id)
            }
            toolbar={
              <>
                {!conversation.parentId && (
                  <>
                    <PresetPicker
                      presetId={conversation.presetId ?? 'default'}
                      disabled={conversation.started}
                      onSelect={(presetId) =>
                        useSessionsStore.getState().setPreset(conversation.id, presetId)
                      }
                    />
                    <WorktreePicker conversationId={conversation.id} />
                    <ApprovalModePicker
                      mode={conversation.approvalMode ?? 'full'}
                      onSelect={(mode) =>
                        useSessionsStore.getState().setApprovalMode(conversation.id, mode)
                      }
                    />
                    <ModelPicker
                      listenHotkey
                      providers={enabledProviders}
                      providerId={provider?.id ?? ''}
                      modelId={effectiveModelId}
                      reasoningEnabled={conversation.reasoningEnabled ?? false}
                      thinkingLevel={conversation.thinkingLevel ?? 'medium'}
                      onSelect={(pid, mid) =>
                        useSessionsStore.getState().setModel(conversation.id, pid, mid)
                      }
                      onReasoningChange={(enabled) =>
                        useSessionsStore.getState().setReasoning(conversation.id, enabled)
                      }
                      onThinkingChange={(level) =>
                        useSessionsStore.getState().setThinking(conversation.id, level)
                      }
                    />
                  </>
                )}
                {conversation.parentId && (
                  <span className="text-[11px] text-muted-foreground">
                    {conversation.agentType ?? 'coworker'}
                    {conversation.lastModelId ? ` · ${conversation.lastModelId}` : ''}
                  </span>
                )}
              </>
            }
            onActivate={activateParent}
            onSend={(payload) => {
              if (!payload.recipient && !project) return false;
              if (
                !payload.recipient &&
                !conversation.parentId &&
                (!provider || !effectiveModelId)
              ) {
                return false;
              }
              routeComposerPayload(payload, {
                dispatchAgent: (typeKey, task) => {
                  void useSessionsStore
                    .getState()
                    .dispatchAgent(typeKey, task, parentSelectedModel);
                },
                sendCoding: (text, images) => {
                  if (!project) return;
                  // 发送后强制回到跟随（ref-chat-b 的 post-submit scroll）
                  timelineRef.current?.scrollToBottom();
                  void useSessionsStore.getState().send(
                    text,
                    {
                      providerId: provider?.id ?? '',
                      modelId: effectiveModelId,
                      cwd: project.path,
                    },
                    images
                  );
                },
              });
              return true;
            }}
            onAbort={() => void useSessionsStore.getState().abort()}
          />
          <StatsLine messages={conversation.messages} conversation={conversation} />
        </div>
      </div>
    </div>
  );
}
const ENSO_PREFILL_CANDIDATE: AgentTypeMentionCandidate = {
  kind: 'agent-type',
  id: ENSO_AGENT_TYPE_KEY,
  typeKey: ENSO_AGENT_TYPE_KEY,
  label: 'Enso',
  displayName: 'Enso',
  description: 'EnsoCode system agent for product capabilities and team setup',
  source: 'system',
  locked: true,
  canDisable: false,
  canEdit: false,
};

function StatusDot({
  status,
  pendingAskCount = 0,
  hasRunningChild = false,
}: {
  status: string;
  pendingAskCount?: number;
  hasRunningChild?: boolean;
}) {
  const tone = conversationDotTone({ status, pendingAskCount, hasRunningChild });
  return <ConversationStatusIndicator tone={tone} size="md" title={status} />;
}
