import { hasProviderCredentials } from '@shared/types';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { buildTimeline } from '@/stores/sessions/timeline';
import { useSettingsStore } from '@/stores/settings';
import { ApprovalBar } from './ApprovalBar';
import { ApprovalModePicker } from './ApprovalModePicker';
import { AskBar } from './AskBar';
import { Composer } from './Composer';
import { ContextMeter } from './ContextMeter';
import { CoworkerTabs } from './CoworkerTabs';
import { GoalBar } from './GoalBar';
import { MessageQueue } from './MessageQueue';
import { CHAT_COL, MessageTimeline, type MessageTimelineHandle } from './MessageTimeline';
import { ModelPicker } from './ModelPicker';
import { PresetPicker } from './PresetPicker';
import { StatsLine } from './StatsLine';
import { TaskBar } from './TaskBar';

export function ChatView() {
  const { t } = useI18n();
  const providers = useSettingsStore((state) => state.providers);
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

  const enabledProviders = useMemo(
    () => providers.filter((provider) => provider.enabled && hasProviderCredentials(provider)),
    [providers]
  );
  // 模型选择读写会话记忆（lastProviderId/lastModelId,持久化）,重启/切会话不丢
  const provider =
    enabledProviders.find((p) => p.id === conversation?.lastProviderId) ?? enabledProviders[0];
  const enabledModels = useMemo(
    () => (provider?.models ?? []).filter((model) => model.enabled !== false),
    [provider]
  );
  const effectiveModelId = enabledModels.some((m) => m.id === conversation?.lastModelId)
    ? (conversation?.lastModelId ?? '')
    : (enabledModels[0]?.id ?? '');

  const project = projects.find((p) => p.id === conversation?.projectId);

  const timelineRef = useRef<MessageTimelineHandle>(null);

  const running = conversation?.status === 'running';
  const busy = running || conversation?.spawning === true;
  const timeline = useMemo(
    () => buildTimeline(conversation?.messages ?? [], running),
    [conversation?.messages, running]
  );

  // app 重启后选中可恢复的对话时自动 resume（历史消息由 worker 回放）
  useEffect(() => {
    if (parent && !parent.started && parent.sessionFile) {
      void useSessionsStore.getState().resumeConversation(parent.id);
    }
  }, [parent]);

  if (!conversation) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-1 text-center">
        <p className="text-lg font-medium">EnsoCode</p>
        <p className="text-sm text-muted-foreground">{t('Select or create a conversation')}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {parent && (
        <CoworkerTabs
          parent={parent}
          displayedId={conversation.id}
          trailing={
            <div className="flex min-w-0 shrink-0 items-center gap-1.5 pl-1.5">
              {project && (
                <span
                  className="truncate font-mono text-xs text-muted-foreground"
                  title={project.path}
                >
                  {project.name}
                </span>
              )}
              <StatusDot status={conversation.spawning ? 'running' : conversation.status} />
            </div>
          }
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
        error={conversation.error}
        emptyTitle={project?.name ?? 'EnsoCode'}
      />

      <div className="@container pt-1">
        <div className={CHAT_COL}>
          <TaskBar
            key={conversation.id}
            sessionId={conversation.id}
            tasks={conversation.backgroundTasks ?? []}
            subagents={conversation.subagents ?? []}
          />
          <ApprovalBar
            approvals={conversation.pendingApprovals ?? []}
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
          <MessageQueue
            conversationId={conversation.id}
            queued={conversation.queuedMessages ?? []}
          />
          {conversation.goal && (
            <GoalBar conversationId={conversation.id} goal={conversation.goal} />
          )}
          <Composer
            cwd={project?.path}
            commands={[
              {
                name: '/goal',
                description: t('Set a session goal (/goal <objective> · pause · resume · clear)'),
              },
              ...conversation.commands,
            ]}
            running={running}
            busy={busy}
            locked={(conversation.pendingApprovals ?? []).length > 0}
            focusKey={conversation.id}
            injectedDraft={conversation.draftText}
            onDraftConsumed={() => useSessionsStore.getState().clearDraft(conversation.id)}
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
                    <ApprovalModePicker
                      mode={conversation.approvalMode ?? 'full'}
                      onSelect={(mode) =>
                        useSessionsStore.getState().setApprovalMode(conversation.id, mode)
                      }
                    />
                    <ModelPicker
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
                <ContextMeter messages={conversation.messages} />
              </>
            }
            onSend={(content, images) => {
              if (!project) return;
              if (!conversation.parentId && (!provider || !effectiveModelId)) return;
              // 发送后强制回到跟随（ref-chat-b 的 post-submit scroll）
              timelineRef.current?.scrollToBottom();
              void useSessionsStore.getState().send(
                content,
                {
                  providerId: provider?.id ?? '',
                  modelId: effectiveModelId,
                  cwd: project.path,
                },
                images
              );
            }}
            onAbort={() => void useSessionsStore.getState().abort()}
          />
          <StatsLine messages={conversation.messages} />
        </div>
      </div>
    </div>
  );
}

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
