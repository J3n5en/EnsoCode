import { ENSO_AGENT_TYPE_KEY } from '@shared/builtinAgents';
import { resolveChatModel } from '@shared/defaultModel';
import type { AgentTypeMentionCandidate } from '@shared/types/mentions';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentChildOauthHost } from '@/components/agent/AgentChildOauthHost';
import { toChatMentionCandidates } from '@/hooks/useMentionSearch';
import { useI18n } from '@/i18n';
import { eventToBinding } from '@/lib/keybindings';
import { cn } from '@/lib/utils';
import {
  oauthCredentialContext,
  usableProvidersForOauthSnapshot,
  useOauthCredentialStore,
} from '@/stores/oauthCredentials';

import { useSessionsStore } from '@/stores/sessions';
import { buildTimeline, terminalErrorText } from '@/stores/sessions/timeline';
import { useSettingsStore } from '@/stores/settings';
import { ChatFindBar, OPEN_CHAT_FIND_EVENT } from './ChatFindBar';
import { timelineSearchHits } from './chatSearch';
import { ApprovalBar } from './ApprovalBar';
import { ApprovalModePicker } from './ApprovalModePicker';
import { AskBar } from './AskBar';
import { Composer } from './Composer';
import { CoworkerTabs } from './CoworkerTabs';
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
  // @ chats 候选：同项目可回放的过去会话。ChatView 本就随 agent 事件重渲染，订阅全表不额外增负。
  const allConversations = useSessionsStore((state) => state.conversations);
  const chatCandidates = useMemo(
    () =>
      parent
        ? toChatMentionCandidates(Object.values(allConversations), parent.projectId, parent.id)
        : [],
    [allConversations, parent]
  );
  const enabledProviders = useMemo(
    () => usableProvidersForOauthSnapshot(providers, oauthSnapshot),
    [providers, oauthSnapshot]
  );
  // 会话显式选择优先；没有 last* 的新草稿只使用全局默认，不再退化到 providers 第一项。
  const modelResolution = useMemo(
    () =>
      resolveChatModel({
        defaultModel,
        lastProviderId: conversation?.lastProviderId,
        lastModelId: conversation?.lastModelId,
        providers,
        credentials: oauthCredentialContext(oauthSnapshot),
      }),
    [
      conversation?.lastModelId,
      conversation?.lastProviderId,
      defaultModel,
      oauthSnapshot,
      providers,
    ]
  );
  const parentModelResolution = useMemo(
    () =>
      resolveChatModel({
        defaultModel,
        lastProviderId: parent?.lastProviderId,
        lastModelId: parent?.lastModelId,
        providers,
        credentials: oauthCredentialContext(oauthSnapshot),
      }),
    [defaultModel, oauthSnapshot, parent?.lastModelId, parent?.lastProviderId, providers]
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
            ? t('Choose a model for this conversation or set a global default before sending.')
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
      ...fromSettings.map((command) => command.name),
      ...fromProject.map((command) => command.name),
    ]);
    return [
      goal,
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
  const busy = running || conversation?.spawning === true;
  const toolCwd = parent?.worktree?.path ?? project?.path;
  const timeline = useMemo(
    () =>
      buildTimeline(
        conversation?.messages ?? [],
        running,
        conversation?.customEntries ?? [],
        toolCwd
      ),
    [conversation?.customEntries, conversation?.messages, running, toolCwd]
  );
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

  // app 重启后选中可恢复的对话时自动 resume（历史消息由 worker 回放）
  useEffect(() => {
    // modelResolution 变化代表默认/provider/OAuth 可用性已变化，需重试先前 fail-closed 的恢复。
    void modelResolution;
    // worktreeMissing：resume 已发现 worktree 丢失，等用户选重建/回退，不要重试循环
    if (parent && !parent.started && parent.sessionFile && !parent.worktreeMissing) {
      void useSessionsStore.getState().resumeConversation(parent.id);
    }
  }, [modelResolution, parent]);

  useEffect(() => {
    const open = () => {
      setFindOpen(true);
    };
    window.addEventListener(OPEN_CHAT_FIND_EVENT, open);
    return () => window.removeEventListener(OPEN_CHAT_FIND_EVENT, open);
  }, []);

  useEffect(() => {
    setFindIndex(0);
    setFindQuery('');
    setFindOpen(false);
  }, [conversation?.id]);

  useEffect(() => {
    if (!findOpen || findHits.length === 0) return;
    const i = Math.min(findIndex, findHits.length - 1);
    timelineRef.current?.scrollToKey(findHits[i].key);
  }, [findOpen, findIndex, findHits]);

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
              <StatusDot status={conversation.spawning ? 'running' : conversation.status} />
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
        busy={busy}
        running={running}
        runStartedAt={conversation.runStartedAt}
        lastOutputAt={conversation.lastOutputAt}
        error={terminalErrorText(conversation.messages, conversation.error)}
        emptyTitle={project?.name ?? 'EnsoCode'}
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

function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'h-2 w-2 rounded-full',
        status === 'running' && 'animate-pulse bg-blue-500',
        status === 'failed' && 'bg-destructive',
        status === 'idle' && 'bg-muted-foreground/30'
      )}
      title={status}
    />
  );
}
