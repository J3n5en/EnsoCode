import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { buildTimeline } from '@/stores/sessions/timeline';
import { useSettingsStore } from '@/stores/settings';
import { Composer } from './Composer';
import { ModelPicker } from './ModelPicker';
import { StatsLine } from './StatsLine';
import { TimelineRow } from './TimelineRow';

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

  const scrollRef = useRef<HTMLDivElement>(null);

  const running = conversation?.status === 'running';
  const busy = running || conversation?.spawning === true;
  const timeline = useMemo(
    () => buildTimeline(conversation?.messages ?? [], running),
    [conversation?.messages, running]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: 时间线变化时滚到底部
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [timeline]);

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

      <ScrollArea ref={scrollRef} className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
          {timeline.length === 0 && !busy && (
            <div className="flex flex-col items-center gap-1 py-24 text-center">
              <p className="text-lg font-medium">{project?.name ?? 'EnsoCode'}</p>
              <p className="text-sm text-muted-foreground">{t('Ask the agent…')}</p>
            </div>
          )}
          {timeline.map((item) => (
            <TimelineRow key={item.key} item={item} />
          ))}
          {busy && <LoadingDots />}
          {conversation.error && (
            <p className="text-sm text-destructive whitespace-pre-wrap">{conversation.error}</p>
          )}
        </div>
      </ScrollArea>

      <div className="px-4 pt-1">
        <div className="mx-auto w-full max-w-2xl">
          <Composer
            cwd={project?.path}
            commands={conversation.commands}
            running={running}
            busy={busy}
            toolbar={
              <ModelPicker
                providers={enabledProviders}
                providerId={provider?.id ?? ''}
                modelId={effectiveModelId}
                onSelect={(pid, mid) => {
                  setProviderId(pid);
                  setModelId(mid);
                }}
              />
            }
            onSend={(content, images) => {
              if (!provider || !effectiveModelId || !project) return;
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
          <StatsLine messages={conversation.messages} activeMs={conversation.activeMs} />
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

function LoadingDots() {
  return (
    <div className="flex items-center gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </div>
  );
}
