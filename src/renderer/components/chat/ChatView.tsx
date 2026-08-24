import { ArrowUp, CircleStop, FolderOpen, Settings } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { buildTimeline } from '@/stores/sessions/timeline';
import { useSettingsStore } from '@/stores/settings';
import { TimelineRow } from './TimelineRow';

export function ChatView() {
  const { t } = useI18n();
  const providers = useSettingsStore((state) => state.providers);
  const session = useSessionsStore();

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
  const modelLabel = enabledModels.find((m) => m.id === effectiveModelId)?.label;

  const [text, setText] = useState('');
  const [cwd, setCwd] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const running = session.status === 'running';
  const busy = running || session.spawning;
  const timeline = useMemo(
    () => buildTimeline(session.messages, running),
    [session.messages, running]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: 时间线变化时滚到底部
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [timeline]);

  const handleSend = async () => {
    const content = text.trim();
    if (!content || !provider || !effectiveModelId) return;
    setText('');
    if (!session.sessionId) {
      const error = await session.start(provider.id, effectiveModelId, cwd.trim());
      if (error) return;
    }
    await useSessionsStore.getState().send(content);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b px-3 py-1.5">
        <Select value={provider?.id ?? ''} onValueChange={(v) => setProviderId(v ?? '')}>
          <SelectTrigger className="h-7 w-auto min-w-0 shrink-0 gap-1 border-none bg-transparent px-2 text-xs shadow-none before:shadow-none hover:bg-muted">
            <SelectValue>{provider?.name ?? t('Provider')}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {enabledProviders.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <span className="text-muted-foreground/40 text-xs">/</span>
        <Select value={effectiveModelId} onValueChange={(v) => setModelId(v ?? '')}>
          <SelectTrigger className="h-7 w-auto min-w-0 shrink-0 gap-1 border-none bg-transparent px-2 text-xs shadow-none before:shadow-none hover:bg-muted">
            <SelectValue>{modelLabel ?? effectiveModelId ?? t('Model')}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {enabledModels.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.label ?? model.id}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
          <StatusDot status={session.spawning ? 'running' : session.status} />
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => window.electronAPI.window.openSettings()}
          >
            <Settings className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <ScrollArea ref={scrollRef} className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
          {timeline.length === 0 && !busy && (
            <div className="flex flex-col items-center gap-1 py-24 text-center">
              <p className="text-lg font-medium">EnsoCode</p>
              <p className="text-sm text-muted-foreground">{t('Ask the agent…')}</p>
            </div>
          )}
          {timeline.map((item) => (
            <TimelineRow key={item.key} item={item} />
          ))}
          {busy && <LoadingDots />}
          {session.error && (
            <p className="text-sm text-destructive whitespace-pre-wrap">{session.error}</p>
          )}
        </div>
      </ScrollArea>

      <div className="px-4 pt-1 pb-4">
        <div className="mx-auto w-full max-w-2xl">
          <div className="rounded-xl border bg-background shadow-sm transition-colors focus-within:border-ring">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder={running ? t('Steer the running agent…') : t('Ask the agent…')}
              rows={2}
              className="max-h-40 w-full resize-none bg-transparent px-3.5 pt-3 text-sm outline-none placeholder:text-muted-foreground"
            />
            <div className="flex items-center gap-1.5 px-2.5 pb-2">
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder={t('Working directory')}
                disabled={session.sessionId !== null}
                className="h-6 min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-muted-foreground disabled:text-muted-foreground"
              />
              {busy ? (
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7 rounded-lg"
                  onClick={() => void session.abort()}
                >
                  <CircleStop className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  className="h-7 w-7 rounded-lg"
                  onClick={() => void handleSend()}
                  disabled={!text.trim()}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
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
