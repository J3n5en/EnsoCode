import type { BtwMode } from '@shared/btw';
import {
  buildBtwSystemPrompt,
  formatBtwHandoff,
  lastAssistantText,
  snapshotMainConversation,
} from '@shared/btw';
import { resolveChatModel, scopedDefaultModels } from '@shared/defaultModel';
import type { DockviewPanelApi } from 'dockview-react';
import { MessageCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ApprovalBar } from '@/components/chat/ApprovalBar';
import { AskBar } from '@/components/chat/AskBar';
import { ChatSessionTimeline } from '@/components/chat/ChatSessionTimeline';
import { Composer } from '@/components/chat/Composer';
import { insertComposerText, requestFocusComposer } from '@/components/chat/composerMentionBridge';
import { MessageQueue } from '@/components/chat/MessageQueue';
import { CHAT_COL, type MessageTimelineHandle } from '@/components/chat/MessageTimeline';
import { ModelPicker } from '@/components/chat/ModelPicker';
import { RetryBar } from '@/components/chat/RetryBar';
import { StatsLine } from '@/components/chat/StatsLine';
import { TaskBar } from '@/components/chat/TaskBar';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  oauthCredentialContext,
  usableProvidersForOauthSnapshot,
  useOauthCredentialStore,
} from '@/stores/oauthCredentials';
import { useSessionsStore } from '@/stores/sessions';
import { chatSurfaceBusy } from '@/stores/sessions/messageCache';
import { useSettingsStore } from '@/stores/settings';

export function BtwView({
  conversationId: parentConversationId,
  panelApi,
}: {
  conversationId: string;
  panelApi: DockviewPanelApi;
}) {
  const { t } = useI18n();
  const sessionId = panelApi.id.startsWith('btw:') ? panelApi.id.slice(4) : panelApi.id;
  const providers = useSettingsStore((state) => state.providers);
  const defaultModel = useSettingsStore((state) => state.defaultModel);
  const projects = useSettingsStore((state) => state.projects);
  const projectGroups = useSettingsStore((state) => state.projectGroups);
  const oauthSnapshot = useOauthCredentialStore((state) => state.snapshot);
  const enabledProviders = useMemo(
    () => usableProvidersForOauthSnapshot(providers, oauthSnapshot),
    [providers, oauthSnapshot]
  );
  const [mode, setMode] = useState<BtwMode>('contextual');
  const [resetting, setResetting] = useState(false);
  const [snapshot] = useState(() =>
    snapshotMainConversation(
      useSessionsStore.getState().conversations[parentConversationId]?.messages ?? []
    )
  );
  const conversation = useSessionsStore(
    useShallow((state) => state.conversations[sessionId] ?? null)
  );
  const title = conversation?.title;
  const projectId = conversation?.projectId;
  const project = useMemo(
    () => projects.find((entry) => entry.id === projectId),
    [projectId, projects]
  );
  const conversationDefaults = useMemo(
    () => scopedDefaultModels(project, projectGroups),
    [project, projectGroups]
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
  const provider =
    modelResolution.source === 'none'
      ? undefined
      : enabledProviders.find((entry) => entry.id === modelResolution.providerId);
  const effectiveModelId = modelResolution.source === 'none' ? '' : modelResolution.modelId;
  const lastAssistant = useMemo(
    () => lastAssistantText(conversation?.messages ?? []),
    [conversation?.messages]
  );
  const timelineRef = useRef<MessageTimelineHandle>(null);
  const running = conversation?.status === 'running';
  const busy =
    resetting ||
    (conversation
      ? chatSurfaceBusy({
          started: conversation.started,
          sessionFile: conversation.sessionFile,
          messages: conversation.messages,
          spawning: conversation.spawning,
          status: conversation.status,
          historyLoadAttempted: conversation.historyLoadAttempted,
        })
      : true);
  const slashCommands = useMemo(() => {
    const compact = {
      name: '/compact',
      description: t('Compact the context now (/compact [summary focus])'),
    };
    const seen = new Set([compact.name]);
    return [
      compact,
      ...(conversation?.commands ?? []).filter((command) => !seen.has(command.name)),
    ];
  }, [conversation?.commands, t]);

  useEffect(() => {
    const parent = useSessionsStore.getState().conversations[parentConversationId];
    const settings = useSettingsStore.getState();
    useSessionsStore.getState().ensureBtwConversation({
      id: sessionId,
      projectId: parent?.projectId ?? '',
      btwParentId: parentConversationId,
      rolePrompt: buildBtwSystemPrompt('contextual', snapshot),
      lastProviderId: parent?.lastProviderId ?? settings.defaultModel?.providerId,
      lastModelId: parent?.lastModelId ?? settings.defaultModel?.modelId,
      reasoningEnabled: parent?.reasoningEnabled ?? settings.defaultReasoningEnabled,
      thinkingLevel: parent?.thinkingLevel ?? settings.defaultThinkingLevel,
      approvalMode: parent?.approvalMode ?? 'full',
      presetId: parent?.presetId,
    });
  }, [parentConversationId, sessionId, snapshot]);

  useEffect(() => {
    if (title) panelApi.setTitle(title);
  }, [panelApi, title]);

  const changeMode = (next: BtwMode) => {
    if (next === mode || resetting) return;
    setResetting(true);
    void (async () => {
      void useSessionsStore.getState().abort(sessionId);
      await useSessionsStore
        .getState()
        .resetBtwSession(sessionId, buildBtwSystemPrompt(next, snapshot));
      setMode(next);
      panelApi.setTitle(t('Btw'));
      setResetting(false);
    })();
  };

  const inject = () => {
    const wrapped = formatBtwHandoff(lastAssistant);
    if (!wrapped) return;
    if (!insertComposerText(wrapped)) {
      addToast({ type: 'warning', title: t('No Composer for this selection') });
      return;
    }
    requestFocusComposer();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
        <ModeChip
          label={t('Contextual')}
          active={mode === 'contextual'}
          onClick={() => changeMode('contextual')}
        />
        <ModeChip
          label={t('Tangent')}
          active={mode === 'tangent'}
          onClick={() => changeMode('tangent')}
        />
        <button
          type="button"
          className="ml-auto rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          disabled={!lastAssistant}
          onClick={inject}
        >
          {t('Insert into chat')}
        </button>
      </div>
      {conversation ? (
        <ChatSessionTimeline
          conversationId={sessionId}
          cwd={project?.path}
          emptyTitle={t('Btw')}
          timelineRef={timelineRef}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
          <MessageCircle className="h-5 w-5" />
          <p className="text-xs">
            {t('Ask a side question without sending it to the main agent.')}
          </p>
        </div>
      )}
      <div className="@container pt-1">
        <div className={CHAT_COL}>
          {conversation?.retry ? (
            <RetryBar
              retry={conversation.retry}
              onCancel={() => void window.electronAPI.agent.abortRetry(sessionId)}
            />
          ) : null}
          <TaskBar
            key={sessionId}
            sessionId={sessionId}
            tasks={conversation?.backgroundTasks ?? []}
            subagents={conversation?.subagents ?? []}
          />
          <ApprovalBar
            approvals={conversation?.pendingApprovals ?? []}
            allowSession
            onRespond={(requestId, decision) =>
              void window.electronAPI.agent.respondApproval(sessionId, requestId, decision)
            }
          />
          <AskBar
            asks={conversation?.pendingAsks ?? []}
            onAnswer={(requestId, answer) =>
              void window.electronAPI.agent.respondAsk(sessionId, requestId, answer)
            }
          />
          <MessageQueue conversationId={sessionId} queued={conversation?.queuedMessages ?? []} />
          <Composer
            isolated
            cwd={project?.path}
            commands={slashCommands}
            running={running}
            busy={busy}
            locked={(conversation?.pendingApprovals ?? []).length > 0}
            focusKey={sessionId}
            injectedDraft={conversation?.draftText}
            injectedImages={conversation?.draftImages}
            onDraftConsumed={() => useSessionsStore.getState().clearDraft(sessionId)}
            autoFocus={false}
            placeholder={t('Ask aside…')}
            toolbar={
              <ModelPicker
                providers={enabledProviders}
                providerId={provider?.id ?? ''}
                modelId={effectiveModelId}
                reasoningEnabled={conversation?.reasoningEnabled ?? false}
                thinkingLevel={conversation?.thinkingLevel ?? 'medium'}
                onSelect={(pid, mid) => useSessionsStore.getState().setModel(sessionId, pid, mid)}
                onReasoningChange={(enabled) =>
                  useSessionsStore.getState().setReasoning(sessionId, enabled)
                }
                onThinkingChange={(level) =>
                  useSessionsStore.getState().setThinking(sessionId, level)
                }
                side="top"
              />
            }
            onSend={(payload) => {
              if (!provider || !effectiveModelId || !project) return false;
              timelineRef.current?.scrollToBottom();
              void useSessionsStore.getState().send(
                payload.text,
                {
                  providerId: provider.id,
                  modelId: effectiveModelId,
                  cwd: project.path,
                },
                payload.images,
                sessionId
              );
              return true;
            }}
            onAbort={() => void useSessionsStore.getState().abort(sessionId)}
          />
          <StatsLine conversationId={sessionId} />
        </div>
      </div>
    </div>
  );
}

function ModeChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        'rounded-md px-2 py-1 text-xs transition-colors',
        active ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50'
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
