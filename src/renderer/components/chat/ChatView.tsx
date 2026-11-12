import { agentTypeDisplayName } from '@shared/builtinAgents';
import { conversationDotTone } from '@shared/conversationDotTone';
import { resolveChatModel, scopedDefaultModels } from '@shared/defaultModel';
import { presetOverlay } from '@shared/extensionPlugins/preset';
import { planPhase } from '@shared/planMode';
import { isBuiltinToolEnabledForProject } from '@shared/types/builtinTools';
import { isVirtualRef, modelDisplayName } from '@shared/virtualModels';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ChromeRow, useShellChrome } from '@/components/app/WindowChrome';
import { addToast } from '@/components/ui/toast';
import { useMemberName } from '@/hooks/useMemberName';
import { toChatMentionCandidates } from '@/hooks/useMentionSearch';
import { useSpeechStatus } from '@/hooks/useSpeechStatus';
import { useI18n } from '@/i18n';
import { startDesktopVoiceSession } from '@/lib/voiceSession';
import { useMaterializedProviders, useUsableProviders } from '@/stores/modelDirectory/useProviders';
import { oauthCredentialContext, useOauthCredentialStore } from '@/stores/oauthCredentials';
import { useSessionsStore } from '@/stores/sessions';
import { selectChatChrome, selectEmptyChatState } from '@/stores/sessions/chatChrome';
import { selectChatCandidateConversations } from '@/stores/sessions/sidebarDirectory';
import { useSettingsStore } from '@/stores/settings';
import { usePluginSlashCommands } from '../../plugins/commands';
import { ElevationBar } from '../elevation/ElevationPrompt';
import { ApprovalBar } from './ApprovalBar';
import { ApprovalModePicker } from './ApprovalModePicker';
import { AskBar } from './AskBar';
import { ChatSessionTimeline } from './ChatSessionTimeline';
import { ChildRunsButton } from './ChildRunsButton';
import { Composer } from './Composer';
import { ConversationStatusIndicator } from './ConversationStatusIndicator';
import { CoworkerTabs } from './CoworkerTabs';
import { insertComposerText, requestFocusComposer } from './composerMentionBridge';
import { routeComposerPayload } from './composerRouting';
import { GoalBar } from './GoalBar';
import { MarkdownLinkContext } from './Markdown';
import { MessageQueue } from './MessageQueue';
import { CHAT_COL, type MessageTimelineHandle } from './MessageTimeline';
import { ModelPicker } from './ModelPicker';
import { PlanBar } from './PlanBar';
import { PlanModeToggle } from './PlanModeToggle';
import { PresetPicker } from './PresetPicker';
import { ProjectCodeTrustBar } from './ProjectCodeTrustBar';
import { RetryBar } from './RetryBar';
import { StatsLine } from './StatsLine';
import { resolveSessionUsageAccount } from './sessionUsageAccount';
import { dedupeSlashCommands } from './skillCompletion';
import { TaskBar } from './TaskBar';
import { TodoBar } from './TodoBar';
import { WorkspaceBadge } from './WorkspaceBadge';
import { WorktreeMissingDialog } from './WorktreeMissingDialog';
import { WorktreePicker } from './WorktreePicker';

/** 虚拟模型最近一次实际路由到的真实模型：取最后一条成功回复记录的 model */
function lastReplyModel(
  messages: readonly { role: string; model?: string; stopReason?: string }[] | undefined
) {
  if (!messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== 'assistant' || !message.model) continue;
    if (message.stopReason === 'error' || message.stopReason === 'aborted') continue;
    return message.model;
  }
  return undefined;
}

/** 空会话建议：填入输入框并聚焦，由用户确认后再发送 */
const pickSuggestion = (prompt: string) => {
  if (insertComposerText(prompt)) requestFocusComposer();
};

export function ChatView() {
  const { t } = useI18n();
  const shellChrome = useShellChrome();
  const providers = useMaterializedProviders();
  const virtualModels = useSettingsStore((state) => state.virtualModels);
  const customAgentTypes = useSettingsStore((state) => state.agentTypes);
  const defaultModel = useSettingsStore((state) => state.defaultModel);
  const projects = useSettingsStore((state) => state.projects);
  const projectGroups = useSettingsStore((state) => state.projectGroups);
  const voiceInputEnabled = useSettingsStore((state) => state.voiceInputEnabled);
  const voiceModel = useSettingsStore((state) => state.voiceModel);
  const presets = useSettingsStore((state) => state.presets);
  const { status: speechStatus } = useSpeechStatus(voiceInputEnabled);
  // 按本窗口的选择判断：换模型后 Main 同步设置有延迟，status.selected 可能还是旧的
  const voiceReady =
    voiceInputEnabled &&
    speechStatus?.state !== 'unsupported' &&
    speechStatus?.models.find((model) => model.id === voiceModel)?.state === 'ready';
  const sessionsHydrated = useSyncExternalStore(
    (onChange) => useSessionsStore.persist?.onFinishHydration?.(onChange) ?? (() => {}),
    () => useSessionsStore.persist?.hasHydrated?.() ?? true
  );
  const chrome = useSessionsStore(useShallow(selectChatChrome));
  const coworkerIds = useSessionsStore(
    (state) => state.conversations[chrome?.parentId ?? '']?.coworkerIds
  );
  const pluginPresetId =
    presetOverlay(chrome?.presetId, (id) => presets.find((preset) => preset.id === id))
      .pluginPresetId ?? null;
  const memberName = useMemberName(chrome?.displayedParentId ? chrome.agentType : undefined);
  const oauthSnapshot = useOauthCredentialStore((state) => state.snapshot);
  const enabledProviders = useUsableProviders();
  const candidateConversations = useSessionsStore((state) =>
    selectChatCandidateConversations(state.conversations)
  );
  const parentId = chrome?.parentId;
  const parentProjectId = chrome?.parentProjectId;
  const chatCandidates = useMemo(
    () =>
      parentId !== undefined && parentProjectId !== undefined
        ? toChatMentionCandidates(candidateConversations, parentProjectId, parentId)
        : [],
    [candidateConversations, parentId, parentProjectId]
  );
  // 会话显式选择优先；新草稿沿 项目默认 → 分组默认 → 全局默认，不再退化到 providers 第一项。
  const conversationProject = useMemo(
    () => projects.find((entry) => entry.id === chrome?.projectId),
    [chrome?.projectId, projects]
  );
  const parentProject = useMemo(
    () => projects.find((entry) => entry.id === chrome?.parentProjectId),
    [chrome?.parentProjectId, projects]
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
        lastProviderId: chrome?.lastProviderId,
        lastModelId: chrome?.lastModelId,
        providers,
        credentials: oauthCredentialContext(oauthSnapshot),
        virtualModels,
      }),
    [
      chrome?.lastModelId,
      chrome?.lastProviderId,
      conversationDefaults,
      defaultModel,
      oauthSnapshot,
      providers,
      virtualModels,
    ]
  );
  const parentModelResolution = useMemo(
    () =>
      resolveChatModel({
        defaultModel,
        ...parentDefaults,
        lastProviderId: chrome?.parentLastProviderId,
        lastModelId: chrome?.parentLastModelId,
        providers,
        credentials: oauthCredentialContext(oauthSnapshot),
        virtualModels,
      }),
    [
      defaultModel,
      oauthSnapshot,
      chrome?.parentLastModelId,
      chrome?.parentLastProviderId,
      parentDefaults,
      providers,
      virtualModels,
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
  const selectedProviderId =
    modelResolution.source === 'none'
      ? ''
      : isVirtualRef(modelResolution)
        ? modelResolution.providerId
        : (provider?.id ?? '');
  const routedModelLabel = useSessionsStore((state) =>
    isVirtualRef(modelResolution) && chrome?.id
      ? lastReplyModel(state.conversations[chrome.id]?.messages)
      : undefined
  );
  const activeAccount = useSessionsStore(
    useShallow((state) =>
      resolveSessionUsageAccount(providers, chrome?.id ? state.conversations[chrome.id] : undefined)
    )
  );
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

  const project = projects.find((p) => p.id === chrome?.projectId);
  const pickerId = chrome?.id;
  const [localBranch, setLocalBranch] = useState<{ id: string; branch: string }>();
  const handleBranchChange = useCallback(
    (branch: string | undefined) =>
      setLocalBranch(pickerId && branch ? { id: pickerId, branch } : undefined),
    [pickerId]
  );
  const branch =
    chrome?.parentWorktreeBranch ??
    (localBranch?.id === chrome?.parentId ? localBranch?.branch : undefined);
  const skills = useSettingsStore((state) => state.skills);
  const loadLocalSkills = useSettingsStore((state) => state.loadLocalSkills);
  const planAvailable = useSettingsStore((state) =>
    isBuiltinToolEnabledForProject(
      state.disabledBuiltinTools,
      state.projects,
      chrome?.projectId,
      'plan'
    )
  );
  const [projectSkills, setProjectSkills] = useState<{ name: string; description: string }[]>([]);

  const skillCwd = loadLocalSkills ? (project?.path ?? '') : '';
  const presetId = chrome?.presetId;
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.assets
      .listProjectSkills(skillCwd, presetId)
      .then((listed) => {
        if (!cancelled) setProjectSkills(listed);
      })
      .catch(() => {
        if (!cancelled) setProjectSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, [skillCwd, presetId]);

  const chromeCommands = chrome?.commands;
  const pluginCommands = usePluginSlashCommands();
  const slashCommands = useMemo(() => {
    if (!chromeCommands) return [];
    const goal = {
      name: '/goal',
      description: t('Set a session goal (/goal <objective> · pause · resume · clear)'),
    };
    const compact = {
      name: '/compact',
      description: t('Compact the context now (/compact [summary focus])'),
    };
    const plan = {
      name: '/plan',
      description: t('Plan mode: research read-only, then approve a plan (/plan [task] · off)'),
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
    // 设置里登记的同名技能优先；项目扫描和会话命令里的副本不再各占一行
    return dedupeSlashCommands([
      goal,
      compact,
      ...(planAvailable ? [plan] : []),
      ...fromSettings,
      ...fromProject,
      ...chromeCommands,
      ...pluginCommands,
    ]);
  }, [t, skills, projectSkills, chromeCommands, pluginCommands, planAvailable]);

  const timelineRef = useRef<MessageTimelineHandle>(null);
  const planning =
    !chrome?.displayedParentId &&
    ['planning', 'awaiting_review'].includes(planPhase(chrome?.planState));
  const running = chrome?.status === 'running';
  const busy = chrome?.busy === true;
  const toolCwd = chrome?.parentWorktreePath ?? project?.path;

  const activateParent = useCallback(() => {
    if (
      chrome &&
      !chrome.parentStarted &&
      chrome.parentSessionFile &&
      !chrome.parentWorktreeMissing &&
      chrome.parentStatus !== 'failed'
    ) {
      void useSessionsStore.getState().resumeConversation(chrome.parentId);
    }
  }, [chrome]);

  useEffect(() => {
    const error = chrome?.compactionError;
    if (!error || !chrome) return;
    addToast({ type: 'error', title: t('Compaction failed'), description: error });
    useSessionsStore.getState().clearCompactionError(chrome.id);
  }, [chrome, t]);

  const emptyState = selectEmptyChatState(chrome, sessionsHydrated);
  if (!chrome) {
    return (
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        {...(emptyState === 'hydrating' ? { 'data-timeline-loading': '' } : {})}
      >
        {shellChrome && <ChromeRow data-enso="title-bar" />}
        {emptyState === 'empty' && (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 text-center">
            <p className="text-lg font-medium">EnsoCode</p>
            <p className="text-sm text-muted-foreground">
              {t('Create or select a project to start a conversation')}
            </p>
          </div>
        )}
      </div>
    );
  }

  const statusDot = (
    <StatusDot
      status={chrome.spawning ? 'running' : chrome.status}
      pendingAskCount={(chrome.pendingAsks ?? []).length}
      hasRunningChild={chrome.id === chrome.parentId && chrome.parentHasRunningChild}
    />
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WorktreeMissingDialog conversationId={chrome.parentId} />
      <CoworkerTabs
        parentId={chrome.parentId}
        displayedId={chrome.id}
        trailing={
          <div className="flex min-w-0 shrink-0 items-center gap-1">
            <ChildRunsButton parentId={chrome.parentId} coworkerIds={coworkerIds ?? []} />
            {project ? (
              <WorkspaceBadge
                project={project}
                conversationId={chrome.parentId}
                path={chrome.parentWorktreePath ?? project.path}
                branch={branch}
                openDisabled={chrome.parentWorktreeMissing}
              >
                {statusDot}
              </WorkspaceBadge>
            ) : (
              <div className="flex min-w-0 shrink-0 items-center">{statusDot}</div>
            )}
          </div>
        }
      />
      <ChatSessionTimeline
        conversationId={chrome.id}
        cwd={toolCwd}
        emptyTitle={project?.name ?? 'EnsoCode'}
        onSuggestion={project ? pickSuggestion : undefined}
        timelineRef={timelineRef}
      />

      <div className="@container pt-1">
        <div className={CHAT_COL}>
          {project &&
            project.kind !== 'ssh' &&
            project.kind !== 'scratch' &&
            !chrome.displayedParentId && (
              <ProjectCodeTrustBar projectId={project.id} conversationId={chrome.id} />
            )}
          {chrome.retry && (
            <RetryBar
              retry={chrome.retry}
              onCancel={() => void window.electronAPI.agent.abortRetry(chrome.id)}
            />
          )}
          {(chrome.rewinding || chrome.restoringFiles) && (
            <div
              role="status"
              className="mb-1 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-muted-foreground text-xs"
            >
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              <span>
                {chrome.restoringFiles && !chrome.rewinding
                  ? t('Restoring files…')
                  : chrome.restoringFiles
                    ? t('Rewinding conversation and files…')
                    : t('Rewinding…')}
              </span>
            </div>
          )}
          <MarkdownLinkContext.Provider
            value={{
              conversationId: chrome.id,
              projectId: chrome.projectId,
              ...(toolCwd ? { cwd: toolCwd } : {}),
            }}
          >
            <TaskBar
              key={chrome.id}
              sessionId={chrome.id}
              tasks={chrome.backgroundTasks ?? []}
              subagents={chrome.subagents ?? []}
            />
          </MarkdownLinkContext.Provider>
          <ApprovalBar
            approvals={chrome.pendingApprovals ?? []}
            allowSession={chrome.childLockedProfileId === undefined}
            onRespond={(requestId, decision) =>
              void window.electronAPI.agent.respondApproval(chrome.id, requestId, decision)
            }
          />
          <ElevationBar />
          <AskBar
            asks={chrome.pendingAsks ?? []}
            onAnswer={(requestId, answer) =>
              void window.electronAPI.agent.respondAsk(chrome.id, requestId, answer)
            }
          />
          {!chrome.displayedParentId && (
            <PlanBar
              conversationId={chrome.id}
              planState={chrome.planState}
              approvalMode={chrome.approvalMode ?? 'full'}
            />
          )}
          <MessageQueue conversationId={chrome.id} queued={chrome.queuedMessages ?? []} />
          {chrome.goal && <GoalBar conversationId={chrome.id} goal={chrome.goal} />}
          <TodoBar key={chrome.id} conversationId={chrome.id} />
          {!chrome.displayedParentId && modelBlockMessage && (
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
              (chrome.pendingApprovals ?? []).length > 0 ||
              Boolean(chrome.rewinding || chrome.restoringFiles)
            }
            focusKey={chrome.id}
            pluginPresetId={pluginPresetId}
            planMode={planning}
            savePastedText={
              project?.kind === 'ssh'
                ? undefined
                : (text) =>
                    window.electronAPI.files.savePastedText({ conversationId: chrome.id, text })
            }
            voice={voiceReady ? startDesktopVoiceSession : undefined}
            requestMicAccess={window.electronAPI.speech.requestMicAccess}
            placeholder={planning ? t('Describe the task — a plan comes first') : undefined}
            injectedDraft={chrome.draftText}
            injectedImages={chrome.draftImages}
            injectedDraftAppend={chrome.draftAppend}
            onDraftConsumed={() => useSessionsStore.getState().clearDraft(chrome.id)}
            queuedCount={chrome.queuedMessages?.length ?? 0}
            onSteerQueued={() => useSessionsStore.getState().steerQueued(chrome.id)}
            toolbar={
              <>
                {!chrome.displayedParentId && (
                  <>
                    <PresetPicker
                      presetId={chrome.presetId ?? 'default'}
                      disabled={chrome.started}
                      onSelect={(presetId) =>
                        useSessionsStore.getState().setPreset(chrome.id, presetId)
                      }
                      onModel={(model) =>
                        useSessionsStore
                          .getState()
                          .setModel(chrome.id, model.providerId, model.modelId)
                      }
                    />
                    <WorktreePicker
                      conversationId={chrome.id}
                      onBranchChange={handleBranchChange}
                    />
                    {(planAvailable || chrome.planState?.active) && (
                      <PlanModeToggle
                        active={chrome.planState?.active ?? false}
                        onToggle={(active) =>
                          useSessionsStore.getState().setPlanMode(chrome.id, active)
                        }
                      />
                    )}
                    <ApprovalModePicker
                      mode={chrome.approvalMode ?? 'full'}
                      autoReject={chrome.autoRejectApprovals === true}
                      onSelect={(mode) =>
                        useSessionsStore.getState().setApprovalMode(chrome.id, mode)
                      }
                      onToggleAutoReject={(value) =>
                        useSessionsStore.getState().setAutoRejectApprovals(chrome.id, value)
                      }
                    />
                    <ModelPicker
                      listenHotkey
                      refreshAllModels
                      providers={enabledProviders}
                      virtualModels={virtualModels}
                      routedModelLabel={routedModelLabel}
                      activeAccount={activeAccount}
                      providerId={selectedProviderId}
                      modelId={effectiveModelId}
                      reasoningEnabled={chrome.reasoningEnabled ?? false}
                      thinkingLevel={chrome.thinkingLevel ?? 'medium'}
                      onSelect={(pid, mid) =>
                        useSessionsStore.getState().setModel(chrome.id, pid, mid)
                      }
                      onReasoningChange={(enabled) =>
                        useSessionsStore.getState().setReasoning(chrome.id, enabled)
                      }
                      onThinkingChange={(level) =>
                        useSessionsStore.getState().setThinking(chrome.id, level)
                      }
                    />
                  </>
                )}
                {chrome.displayedParentId && (
                  <span className="text-[11px] text-muted-foreground">
                    {memberName ??
                      (chrome.agentType
                        ? agentTypeDisplayName(chrome.agentType, customAgentTypes)
                        : 'coworker')}
                    {chrome.lastModelId
                      ? ` · ${modelDisplayName(virtualModels, chrome.lastModelId)}`
                      : ''}
                  </span>
                )}
              </>
            }
            onActivate={activateParent}
            onSend={(payload) => {
              if (!payload.recipient && !project) return false;
              if (
                !payload.recipient &&
                !chrome.displayedParentId &&
                (!selectedProviderId || !effectiveModelId)
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
                      providerId: selectedProviderId,
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
          <StatsLine conversationId={chrome.id} cwd={toolCwd} />
        </div>
      </div>
    </div>
  );
}

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
  return <ConversationStatusIndicator tone={tone} title={status} />;
}
