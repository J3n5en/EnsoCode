import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { buildTimeline } from '@/stores/sessions/timeline';
import { useSettingsStore } from '@/stores/settings';
import { Composer } from './Composer';
import { ContextMeter } from './ContextMeter';
import { CHAT_COL, MessageTimeline, type MessageTimelineHandle } from './MessageTimeline';
import { ModelPicker } from './ModelPicker';
import { PresetPicker } from './PresetPicker';
import { StatsLine } from './StatsLine';

export function ChatView() {
  const { t } = useI18n();
  const providers = useSettingsStore((state) => state.providers);
  const projects = useSettingsStore((state) => state.projects);
  const conversation = useSessionsStore((state) =>
    state.activeId ? state.conversations[state.activeId] : null
  );

  const enabledProviders = useMemo(
    () => providers.filter((provider) => provider.enabled && provider.apiKey),
    [providers]
  );
  const [providerId, setProviderId] = useState('');
  const provider = enabledProviders.find((p) => p.id === providerId) ?? enabledProviders[0];
  const enabledModels = useMemo(
    () => (provider?.models ?? []).filter((model) => model.enabled !== false),
    [provider]
  );
  const [modelId, setModelId] = useState('');
  const effectiveModelId = enabledModels.some((m) => m.id === modelId)
    ? modelId
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
    if (conversation && !conversation.started && conversation.sessionFile) {
      void useSessionsStore.getState().resumeConversation(conversation.id);
    }
  }, [conversation]);

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
      <div className="flex items-center justify-between gap-1.5 border-b px-3 py-1.5">
        <span className="min-w-0 truncate text-xs font-medium">
          {conversation.title || t('New conversation')}
        </span>
        <div className="flex min-w-0 items-center gap-1.5">
          {project && (
            <span className="truncate font-mono text-xs text-muted-foreground" title={project.path}>
              {project.name}
            </span>
          )}
          <StatusDot status={conversation.spawning ? 'running' : conversation.status} />
        </div>
      </div>

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

      <div className="@container px-4 pt-1">
        <div className={CHAT_COL}>
          <Composer
            cwd={project?.path}
            commands={conversation.commands}
            running={running}
            busy={busy}
            focusKey={conversation.id}
            toolbar={
              <>
                <PresetPicker
                  presetId={conversation.presetId ?? 'default'}
                  disabled={conversation.started}
                  onSelect={(presetId) =>
                    useSessionsStore.getState().setPreset(conversation.id, presetId)
                  }
                />
                <ModelPicker
                  providers={enabledProviders}
                  providerId={provider?.id ?? ''}
                  modelId={effectiveModelId}
                  reasoningEnabled={conversation.reasoningEnabled ?? false}
                  thinkingLevel={conversation.thinkingLevel ?? 'medium'}
                  onSelect={(pid, mid) => {
                    setProviderId(pid);
                    setModelId(mid);
                  }}
                  onReasoningChange={(enabled) =>
                    useSessionsStore.getState().setReasoning(conversation.id, enabled)
                  }
                  onThinkingChange={(level) =>
                    useSessionsStore.getState().setThinking(conversation.id, level)
                  }
                />
                <ContextMeter messages={conversation.messages} />
              </>
            }
            onSend={(content, images) => {
              if (!provider || !effectiveModelId || !project) return;
              // 发送后强制回到跟随（ref-chat-b 的 post-submit scroll）
              timelineRef.current?.scrollToBottom();
              void useSessionsStore.getState().send(
                content,
                {
                  providerId: provider.id,
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
